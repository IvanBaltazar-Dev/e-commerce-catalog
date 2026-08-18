-- 0127 · Un expediente puede exigir más de una decisión terminal.
--
-- El incidente de la variante MAS101 lo dejó claro: una ejecución parcial
-- contaminó una asociación editorial válida, y cerrarlo bien exige DOS
-- decisiones sobre DOS objetos distintos:
--
--   productos/…/tonos/tiza.webp   medio editorial legítimo   RECOVERABLE_EXACT
--   campana-1/420c3af9….webp      artefacto de corrida       DUPLICATE
--
-- Partirlo en dos expedientes rompería la causalidad —son el mismo incidente— y
-- además inflaría el conteo del alcance. Pero meter las dos decisiones en un
-- solo campo `state` obligaría a elegir cuál se cuenta y cuál se pierde.
--
-- La unidad del problema es el incidente; la unidad de la decisión es el objeto.
-- Son dos cosas distintas y el modelo las separa. El carril B lo necesitará
-- igual: corregir un dueño equivocado también toca dos entidades, la que
-- pierde el medio y la que lo recibe.

begin;

create table public.catalog_media_campaign_item_actions (
  id uuid primary key default gen_random_uuid(),
  campaign_item_id uuid not null
    references public.catalog_media_campaign_items(id) on delete cascade,

  -- El objeto sobre el que se decide. Un medio del patrimonio, o una ruta que
  -- todavía no llegó a ser medio.
  media_asset_id uuid references public.media_assets(id) on delete set null,
  object_ref text not null,

  state text not null references public.catalog_media_item_states(code),
  cause text,
  -- Por qué apareció, que no es lo mismo que qué es. DUPLICATE describe el
  -- objeto; ABORTED_RUN_ARTIFACT explica su origen.
  origin_code text,

  evidence jsonb not null default '{}'::jsonb,
  applied_at timestamptz,
  created_at timestamptz not null default now(),

  constraint catalog_media_item_actions_unique unique (campaign_item_id, object_ref)
);

create index catalog_media_item_actions_state_idx
  on public.catalog_media_campaign_item_actions(state);

-- La misma exigencia que en el expediente: si el estado pide causa, la causa se
-- escribe. Aquí importa más todavía, porque estas acciones son las que
-- autorizan retirar bytes.
create or replace function public.enforce_media_action_cause()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  needs_cause boolean;
begin
  select requires_cause into needs_cause
  from public.catalog_media_item_states where code = new.state;

  if coalesce(needs_cause, false) and nullif(trim(coalesce(new.cause, '')), '') is null then
    raise exception using errcode = '23514',
      message = format('La acción %s sobre %s exige una causa explícita.', new.state, new.object_ref);
  end if;

  return new;
end;
$function$;

create trigger catalog_media_campaign_item_actions_cause
before insert or update on public.catalog_media_campaign_item_actions
for each row execute function public.enforce_media_action_cause();

-- DUPLICATE existía para el carril B pero exigía causa: un duplicado legítimo
-- no siempre la necesita, y en cambio el artefacto de una corrida sí. Se deja
-- la exigencia y se documenta que la causa es el origen, no la justificación.
update public.catalog_media_item_states
set description = 'El contenido ya existe correctamente en el patrimonio. La causa dice de dónde salió esta copia de más.',
    requires_cause = true
where code = 'DUPLICATE';

alter table public.catalog_media_campaign_item_actions enable row level security;
create policy catalog_media_item_actions_admin_read on public.catalog_media_campaign_item_actions
  for select to authenticated using (public.is_admin());

revoke all on function public.enforce_media_action_cause() from public, anon, authenticated;

commit;
