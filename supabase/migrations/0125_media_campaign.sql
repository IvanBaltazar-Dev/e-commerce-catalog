-- 0125 · Campaña Multimedia: el patrimonio se recupera con expediente, no a granel.
--
-- El catálogo declara 158 medios y no tiene un solo byte detrás. La cola del
-- auditor dice que 172 variantes tienen una imagen oficial identificada sin
-- ambigüedad y que 56 medios ya declarados necesitan auditoría. Los números
-- casi cuadran solos —102 de esas 172 son justamente medios fantasma, y 102 más
-- 56 son 158— pero hay dos expedientes que se salen de esa cuenta y se cancelan
-- entre sí: un medio que cuelga de un producto y no de una variante, y una
-- variante de la cohorte sin enlace vivo. Por eso la campaña congela 229
-- expedientes y no 228: un descuadre que se compensa sigue siendo dos casos sin
-- mirar.
--
-- Dos carriles que no se mezclan:
--
--   A · 172 imágenes oficiales exactas. Se descargan sin reinterpretar
--       identidad: el dueño ya está decidido y la campaña no lo revisa.
--   B ·  57 medios ya declarados. Se auditan hasta un estado explícito.
--
-- Y una regla que manda sobre el resultado: **ningún expediente puede
-- desaparecer para poner verde el gate**. Si el medio corresponde, se recupera;
-- si cuelga de quien no debe, se corrige dejando rastro; si la evidencia no lo
-- sostiene, deja de ser publicable pero se conserva por qué. Un patrimonio
-- coherente no es un patrimonio sin problemas: es uno donde cada problema tiene
-- nombre.

begin;

-- Los estados no son una lista quemada en un CHECK: se consultan, se explican
-- en la interfaz y pueden crecer cuando la auditoría encuentre un caso que hoy
-- no existe, sin migrar el esquema.
create table public.catalog_media_item_states (
  code text primary key,
  lane text not null check (lane in ('A', 'B', '*')),
  is_terminal boolean not null default false,
  requires_cause boolean not null default false,
  keeps_media_active boolean not null default true,
  description text not null,
  sort_order integer not null default 0
);

insert into public.catalog_media_item_states
  (code, lane, is_terminal, requires_cause, keeps_media_active, description, sort_order) values
  ('PENDING', '*', false, false, true,
   'Congelado en el alcance de la campaña, todavía sin procesar.', 10),

  -- Carril A
  ('DOWNLOADED', 'A', true, false, true,
   'Original descargado, validado, con hash exacto y perceptual, derivado web y dueño vinculado.', 20),
  ('DEDUPLICATED', 'A', true, false, true,
   'El original ya existía byte a byte: se reutiliza el medio en vez de duplicarlo.', 21),
  ('DOWNLOAD_FAILED', 'A', true, true, true,
   'La fuente no entregó el archivo. La causa queda escrita: nunca «faltan siete».', 22),
  ('INVALID_IMAGE', 'A', true, true, true,
   'La fuente respondió pero lo entregado no es una imagen utilizable.', 23),

  -- Carril B
  ('RECOVERABLE_EXACT', 'B', true, false, true,
   'El medio declarado corresponde a su dueño y su archivo se pudo recuperar.', 30),
  ('WRONG_OWNER', 'B', true, true, true,
   'El archivo es válido pero cuelga de la variante equivocada: se corrige con rastro.', 31),
  ('INVALID_SOURCE', 'B', true, true, false,
   'No hay fuente que sostenga este medio. Deja de ser publicable; la historia se conserva.', 32),
  ('DUPLICATE', 'B', true, false, true,
   'El mismo contenido ya está declarado en otro expediente.', 33),
  ('INSUFFICIENT_EVIDENCE', 'B', true, true, false,
   'La evidencia no permite afirmar ni negar la correspondencia. Se retira de publicación sin borrarse.', 34);

create table public.catalog_media_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null unique,
  status text not null default 'frozen'
    check (status in ('frozen', 'running', 'closed', 'abandoned')),
  -- Huella del alcance en el momento de congelar. Si el conjunto de expedientes
  -- cambia, la campaña deja de describir lo que dijo describir.
  scope_fingerprint text not null,
  scope_size integer not null check (scope_size > 0),
  lane_a_size integer not null default 0,
  lane_b_size integer not null default 0,
  media_fingerprint_before text,
  media_fingerprint_after text,
  totals jsonb not null default '{}'::jsonb,
  frozen_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint catalog_media_campaigns_closed_consistent check (
    (status <> 'closed' and closed_at is null) or (status = 'closed' and closed_at is not null)
  )
);

create table public.catalog_media_campaign_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.catalog_media_campaigns(id) on delete cascade,
  lane text not null check (lane in ('A', 'B')),

  -- El dueño se congela al abrir la campaña y no se reinterpreta. Un medio
  -- cuelga de una variante o de un producto, nunca de los dos.
  variant_id uuid references public.product_variants(id) on delete restrict,
  product_id uuid references public.products(id) on delete restrict,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  official_url text,
  source_classification text not null,

  state text not null default 'PENDING' references public.catalog_media_item_states(code),
  cause text,

  sha256 text,
  perceptual_hash text,
  bytes bigint,
  mime text,
  width integer,
  height integer,
  original_path text,
  derivative_path text,
  provenance jsonb not null default '{}'::jsonb,

  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_media_campaign_items_owner check (
    (variant_id is not null and product_id is null)
    or (variant_id is null and product_id is not null)
  ),
  constraint catalog_media_campaign_items_unique_owner
    unique (campaign_id, lane, variant_id, product_id, official_url)
);

create index catalog_media_campaign_items_state_idx
  on public.catalog_media_campaign_items(campaign_id, lane, state);
create index catalog_media_campaign_items_sha_idx
  on public.catalog_media_campaign_items(sha256) where sha256 is not null;

-- Una causa no es opcional cuando el estado la exige. «Faltan siete» no es un
-- resultado; «siete fallaron y aquí está por qué cada una» sí lo es.
create or replace function public.enforce_media_campaign_item_cause()
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
      message = format('El estado %s exige una causa explícita.', new.state);
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

create trigger catalog_media_campaign_items_cause
before insert or update on public.catalog_media_campaign_items
for each row execute function public.enforce_media_campaign_item_cause();

-- Gate A · Integridad de campaña: cada expediente congelado termina en un
-- estado terminal, y los que fallan lo hacen con causa. La suma tiene que dar
-- exactamente el alcance, sin residuo.
create or replace view public.catalog_media_campaign_integrity_v1
with (security_invoker = true) as
select
  campaign.id as campaign_id,
  campaign.campaign_key,
  campaign.scope_size,
  count(item.id)::integer as expedientes,
  count(item.id) filter (where state.is_terminal)::integer as terminados,
  count(item.id) filter (where not state.is_terminal)::integer as pendientes,
  count(item.id) filter (where state.requires_cause)::integer as con_incidencia,
  count(item.id) filter (
    where state.requires_cause and nullif(trim(coalesce(item.cause, '')), '') is null
  )::integer as incidencias_sin_causa,
  count(item.id) filter (where not state.keeps_media_active)::integer as retirados_de_publicacion,
  (count(item.id) = campaign.scope_size
    and count(item.id) filter (where not state.is_terminal) = 0
    and count(item.id) filter (
      where state.requires_cause and nullif(trim(coalesce(item.cause, '')), '') is null
    ) = 0) as integridad_completa
from public.catalog_media_campaigns campaign
left join public.catalog_media_campaign_items item on item.campaign_id = campaign.id
left join public.catalog_media_item_states state on state.code = item.state
group by campaign.id, campaign.campaign_key, campaign.scope_size;

alter table public.catalog_media_campaigns enable row level security;
alter table public.catalog_media_campaign_items enable row level security;
alter table public.catalog_media_item_states enable row level security;

create policy catalog_media_campaigns_admin_read on public.catalog_media_campaigns
  for select to authenticated using (public.is_admin());
create policy catalog_media_campaign_items_admin_read on public.catalog_media_campaign_items
  for select to authenticated using (public.is_admin());
create policy catalog_media_item_states_admin_read on public.catalog_media_item_states
  for select to authenticated using (public.is_admin());

revoke all on function public.enforce_media_campaign_item_cause() from public, anon, authenticated;
grant select on public.catalog_media_campaign_integrity_v1 to authenticated, service_role;

commit;
