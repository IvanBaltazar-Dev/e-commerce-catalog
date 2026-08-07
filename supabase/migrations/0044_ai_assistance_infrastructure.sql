-- ---------------------------------------------------------------------------
-- 0044 — Infraestructura de asistencia IA (Bloque 4)
--
-- La IA de Bellaroshé es una ASISTENTE con evidencia, no una actora comercial.
-- Este es el principio del plan hecho estructura:
--
--   · Regla 9: «La IA nunca confirma una venta». Aquí no existe NINGÚN camino
--     por el que una interacción de IA cree ventas, reservas, pagos ni
--     movimientos: `ai_interactions` solo registra la PROPUESTA y, si un ser
--     humano la ejecutó por los contratos del Bloque 2, el enlace posterior.
--     `resolve_ai_interaction` cambia un estado y guarda una referencia;
--     jamás toca una tabla comercial.
--
--   · Regla 10: «La caída de la IA no impide la operación manual». El estado
--     del proveedor (`provider_status`) es un DATO de cada interacción:
--     'unavailable' es un resultado registrado con su error, no una excepción
--     que detenga nada. La tienda vende igual.
--
--   · Tendencias: el sistema PROPONE contenido y la dueña decide. No existe
--     función de publicación automática: `mark_content_published` registra
--     que un humano publicó él mismo, con su identidad, y solo sobre una
--     propuesta ya aprobada.
--
--   · El tipo de interacción es un dato con formato, no un enum rígido: el
--     Bloque 4 nace con audio, foto, asesor, look y tendencias, y mañana
--     habrá más sin migración (la lección de 0035 con los canales).
--
--   · Todo es append-only en lo que importa: la propuesta, el tipo y el
--     resumen de entrada son inmutables; el estado avanza en una sola
--     dirección; el enlace a venta se escribe UNA vez. Historia, no bitácora
--     reescribible.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Interacciones de IA: la evidencia de cada asistencia
-- ---------------------------------------------------------------------------

create table public.ai_interactions (
  id uuid primary key default gen_random_uuid(),
  -- audio_order · photo_recognition · advisor · look_recreation ·
  -- trend_analysis · … extensible por formato, no por migración.
  kind text not null,
  status text not null default 'proposed',
  branch_id uuid references public.branches(id) on delete restrict,
  conversation_id uuid references public.channel_conversations(id) on delete restrict,
  -- SIEMPRE hay una persona detrás: la IA no se invoca sola.
  requested_by uuid not null,
  requested_by_label text,
  -- Qué se pidió, en texto plano y sin payload sensible (regla de logs §44).
  input_summary text not null,
  -- La propuesta estructurada: líneas de carrito sugeridas, candidatos de
  -- foto, recomendación del asesor. Su forma la valida la aplicación; la
  -- base garantiza que sea un objeto y que no cambie jamás.
  proposal jsonb not null default '{}'::jsonb,
  -- Modelo usado; nulo cuando la propuesta fue puramente determinista.
  model text,
  -- ok · degraded (respondió el camino determinista sin LLM) · unavailable.
  provider_status text not null default 'ok',
  latency_ms integer,
  error_message text,
  confirmed_at timestamptz,
  confirmed_by uuid,
  resolution_note text,
  -- Enlace a lo que un HUMANO ejecutó después por el Bloque 2. Write-once.
  sale_id uuid references public.sales(id) on delete restrict,
  reservation_id uuid references public.reservations(id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint ai_interactions_kind_format check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint ai_interactions_status_valid check (
    status in ('proposed', 'confirmed', 'discarded', 'failed')
  ),
  constraint ai_interactions_provider_valid check (
    provider_status in ('ok', 'degraded', 'unavailable')
  ),
  constraint ai_interactions_summary_not_blank check (length(trim(input_summary)) > 0),
  constraint ai_interactions_proposal_object check (jsonb_typeof(proposal) = 'object'),
  constraint ai_interactions_latency_non_negative check (latency_ms is null or latency_ms >= 0),
  -- Confirmada ⇔ con quién y cuándo.
  constraint ai_interactions_confirmed_paired check (
    (status = 'confirmed') = (confirmed_at is not null and confirmed_by is not null)
  ),
  -- El enlace comercial solo existe en una interacción confirmada.
  constraint ai_interactions_links_need_confirmation check (
    (sale_id is null and reservation_id is null) or status = 'confirmed'
  )
);

create index ai_interactions_kind_idx on public.ai_interactions(kind, created_at desc);
create index ai_interactions_requester_idx on public.ai_interactions(requested_by, created_at desc);
create index ai_interactions_status_idx on public.ai_interactions(status) where status = 'proposed';
create index ai_interactions_sale_idx on public.ai_interactions(sale_id) where sale_id is not null;

comment on table public.ai_interactions is
  'Evidencia de cada asistencia de IA. La IA propone; el humano confirma o '
  'descarta. NUNCA hay un camino de aquí a crear una venta: el enlace sale_id '
  'apunta a lo que una persona ejecutó por los contratos del Bloque 2.';

-- La historia no se reescribe: propuesta, tipo y entrada quedan congelados;
-- el estado avanza proposed → (confirmed | discarded | failed) y se detiene.
create or replace function public.protect_ai_interaction_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     or new.proposal is distinct from old.proposal
     or new.input_summary is distinct from old.input_summary
     or new.requested_by is distinct from old.requested_by
     or new.model is distinct from old.model
     or new.provider_status is distinct from old.provider_status
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514',
      message = 'La propuesta de IA es evidencia: no se reescribe.';
  end if;

  if old.status <> 'proposed' and new.status is distinct from old.status then
    raise exception using errcode = '23514',
      message = 'Una interacción resuelta no cambia de estado.';
  end if;

  if old.sale_id is not null and new.sale_id is distinct from old.sale_id then
    raise exception using errcode = '23514',
      message = 'El enlace a la venta se establece una sola vez.';
  end if;

  if old.reservation_id is not null and new.reservation_id is distinct from old.reservation_id then
    raise exception using errcode = '23514',
      message = 'El enlace a la reserva se establece una sola vez.';
  end if;

  return new;
end;
$$;

revoke all on function public.protect_ai_interaction_history() from public, anon;

create trigger ai_interactions_history_protected
before update on public.ai_interactions
for each row execute function public.protect_ai_interaction_history();

-- Evidencia no se borra.
create or replace function public.reject_ai_interaction_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '23514',
    message = 'La evidencia de IA no se elimina; se descarta con estado.';
end;
$$;

revoke all on function public.reject_ai_interaction_delete() from public, anon;

create trigger ai_interactions_no_delete
before delete on public.ai_interactions
for each row execute function public.reject_ai_interaction_delete();

-- ---------------------------------------------------------------------------
-- 2. Contratos de la asistencia
-- ---------------------------------------------------------------------------

-- Registra una asistencia. La invoca el servidor con la sesión del PERSONAL
-- que pidió ayuda: vendedora dictando un pedido, administradora pidiendo una
-- recomendación. anon jamás llega aquí.
create or replace function public.record_ai_interaction(
  p_kind text,
  p_input_summary text,
  p_proposal jsonb default '{}'::jsonb,
  p_model text default null,
  p_provider_status text default 'ok',
  p_latency_ms integer default null,
  p_error_message text default null,
  p_branch_id uuid default null,
  p_conversation_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_label text;
  interaction_id uuid;
begin
  if actor is null or not public.is_staff(actor) then
    raise exception using errcode = '42501',
      message = 'La asistencia de IA es del personal autenticado.';
  end if;

  if p_branch_id is not null then
    perform public.assert_branch_access(p_branch_id, 'usar la asistencia de IA');
  end if;

  select full_name into actor_label from public.admin_profiles where id = actor;

  insert into public.ai_interactions (
    kind, branch_id, conversation_id, requested_by, requested_by_label,
    input_summary, proposal, model, provider_status, latency_ms, error_message,
    status
  )
  values (
    p_kind, p_branch_id, p_conversation_id, actor, actor_label,
    p_input_summary, coalesce(p_proposal, '{}'::jsonb), p_model,
    coalesce(p_provider_status, 'ok'), p_latency_ms, p_error_message,
    case when p_error_message is null then 'proposed' else 'failed' end
  )
  returning id into interaction_id;

  return interaction_id;
end;
$$;

-- El humano resuelve: confirma (con enlace opcional a lo que ÉL ejecutó por
-- el Bloque 2) o descarta. Esta función no crea nada comercial — esa es
-- exactamente la promesa de la regla 9.
create or replace function public.resolve_ai_interaction(
  p_interaction_id uuid,
  p_status text,
  p_sale_id uuid default null,
  p_reservation_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  interaction public.ai_interactions%rowtype;
begin
  if actor is null or not public.is_staff(actor) then
    raise exception using errcode = '42501',
      message = 'Resolver una asistencia es del personal autenticado.';
  end if;

  if p_status not in ('confirmed', 'discarded') then
    raise exception using errcode = '22023',
      message = 'Una asistencia se resuelve confirmándola o descartándola.';
  end if;

  select * into interaction from public.ai_interactions
  where id = p_interaction_id
  for update;

  if interaction.id is null then
    raise exception using errcode = 'P0002',
      message = 'La interacción no existe.';
  end if;

  -- Resolver es del solicitante o de administración.
  if interaction.requested_by <> actor and not public.is_admin(actor) then
    raise exception using errcode = '42501',
      message = 'Solo quien pidió la asistencia (o administración) la resuelve.';
  end if;

  if interaction.status <> 'proposed' then
    raise exception using errcode = '23514',
      message = 'La interacción ya fue resuelta.';
  end if;

  if p_status = 'discarded' and (p_sale_id is not null or p_reservation_id is not null) then
    raise exception using errcode = '22023',
      message = 'Una asistencia descartada no enlaza operaciones.';
  end if;

  update public.ai_interactions
  set status = p_status,
      confirmed_at = case when p_status = 'confirmed' then now() end,
      confirmed_by = case when p_status = 'confirmed' then actor end,
      resolution_note = p_note,
      sale_id = p_sale_id,
      reservation_id = p_reservation_id
  where id = p_interaction_id;

  return jsonb_build_object('id', p_interaction_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Propuestas de contenido (tendencias): proponer no es publicar
-- ---------------------------------------------------------------------------

create table public.content_proposals (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'trend_content',
  title text not null,
  body text not null,
  -- Las señales internas que motivaron la propuesta (ventas, tonos, canales).
  source_signals jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  ai_interaction_id uuid references public.ai_interactions(id) on delete restrict,
  created_by uuid not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  -- Publicar lo hace UN HUMANO fuera del sistema; aquí solo queda el registro
  -- de quién dijo «ya lo publiqué». No existe publicación automática.
  published_by uuid,
  published_at timestamptz,
  published_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint content_proposals_kind_format check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint content_proposals_title_not_blank check (length(trim(title)) > 0),
  constraint content_proposals_body_not_blank check (length(trim(body)) > 0),
  constraint content_proposals_signals_object check (jsonb_typeof(source_signals) = 'object'),
  constraint content_proposals_status_valid check (
    status in ('draft', 'approved', 'rejected', 'published')
  ),
  constraint content_proposals_review_paired check (
    (status in ('approved', 'rejected', 'published')) = (reviewed_by is not null and reviewed_at is not null)
  ),
  constraint content_proposals_published_paired check (
    (status = 'published') = (published_by is not null and published_at is not null)
  )
);

create index content_proposals_status_idx on public.content_proposals(status, created_at desc);

comment on table public.content_proposals is
  'Propuestas de contenido nacidas de señales internas. El flujo es draft → '
  'approved/rejected → published, siempre por decisión humana registrada. '
  'NUNCA hay publicación automática: published solo registra que la dueña '
  'publicó ella misma.';

create trigger content_proposals_set_updated_at
before update on public.content_proposals
for each row execute function public.set_updated_at();

-- El contenido aprobado no se reescribe y los estados no retroceden.
create or replace function public.protect_content_proposal_flow()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft'
     and (new.title is distinct from old.title or new.body is distinct from old.body) then
    raise exception using errcode = '23514',
      message = 'Una propuesta revisada no cambia de contenido.';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('approved', 'rejected'))
      or (old.status = 'approved' and new.status = 'published')
    ) then
      raise exception using errcode = '23514',
        message = 'El flujo es draft → approved/rejected → published; no hay atajos ni retrocesos.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_content_proposal_flow() from public, anon;

create trigger content_proposals_flow_protected
before update on public.content_proposals
for each row execute function public.protect_content_proposal_flow();

-- Contratos de tendencias, todos administrativos.

create or replace function public.create_content_proposal(
  p_title text,
  p_body text,
  p_signals jsonb default '{}'::jsonb,
  p_ai_interaction_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  proposal_id uuid;
begin
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501',
      message = 'Las propuestas de contenido son administrativas.';
  end if;

  insert into public.content_proposals (title, body, source_signals, ai_interaction_id, created_by)
  values (p_title, p_body, coalesce(p_signals, '{}'::jsonb), p_ai_interaction_id, actor)
  returning id into proposal_id;

  return proposal_id;
end;
$$;

create or replace function public.review_content_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501',
      message = 'Revisar contenido es administrativo.';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023',
      message = 'La revisión aprueba o rechaza.';
  end if;

  update public.content_proposals
  set status = p_decision,
      reviewed_by = actor,
      reviewed_at = now(),
      review_note = p_note
  where id = p_proposal_id and status = 'draft';

  if not found then
    raise exception using errcode = '23514',
      message = 'Solo un borrador se revisa, y una sola vez.';
  end if;

  return jsonb_build_object('id', p_proposal_id, 'status', p_decision);
end;
$$;

create or replace function public.mark_content_published(
  p_proposal_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501',
      message = 'Registrar una publicación es administrativo.';
  end if;

  -- Nótese lo que esta función NO hace: no llama a ninguna API de red social,
  -- no programa nada, no publica. Registra que un humano publicó él mismo.
  update public.content_proposals
  set status = 'published',
      published_by = actor,
      published_at = now(),
      published_note = p_note
  where id = p_proposal_id and status = 'approved';

  if not found then
    raise exception using errcode = '23514',
      message = 'Solo una propuesta aprobada se marca como publicada.';
  end if;

  return jsonb_build_object('id', p_proposal_id, 'status', 'published');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS y ACL: la doctrina de siempre
-- ---------------------------------------------------------------------------

alter table public.ai_interactions enable row level security;
alter table public.content_proposals enable row level security;

-- La vendedora ve SUS asistencias; administración ve todas. Nadie inserta ni
-- actualiza por tabla: solo por los contratos.
create policy "staff reads own ai interactions"
on public.ai_interactions for select to authenticated
using (requested_by = auth.uid() or public.is_admin());

create policy "admins read content proposals"
on public.content_proposals for select to authenticated
using (public.is_admin());

-- El ACL por defecto de Supabase concede de más; se retira explícito.
revoke all on public.ai_interactions from anon, authenticated;
revoke all on public.content_proposals from anon, authenticated;
grant select on public.ai_interactions to authenticated;
grant select on public.content_proposals to authenticated;

revoke all on function public.record_ai_interaction(text, text, jsonb, text, text, integer, text, uuid, uuid) from public, anon;
revoke all on function public.resolve_ai_interaction(uuid, text, uuid, uuid, text) from public, anon;
revoke all on function public.create_content_proposal(text, text, jsonb, uuid) from public, anon;
revoke all on function public.review_content_proposal(uuid, text, text) from public, anon;
revoke all on function public.mark_content_published(uuid, text) from public, anon;

grant execute on function public.record_ai_interaction(text, text, jsonb, text, text, integer, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.resolve_ai_interaction(uuid, text, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.create_content_proposal(text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.review_content_proposal(uuid, text, text) to authenticated, service_role;
grant execute on function public.mark_content_published(uuid, text) to authenticated, service_role;
