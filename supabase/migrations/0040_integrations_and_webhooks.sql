-- Bloque 3 · Migración 6 de 6 — Integraciones, webhooks y métricas operativas.
--
-- La regla crítica del plan: NUNCA procesar un webhook solo en memoria.
-- Primero INSERT, después procesar. Meta reenvía ante cualquier timeout; si el
-- reintento y el original compiten, la base decide con un índice único y el
-- perdedor lee al ganador.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. EL EVENTO CRUDO ES INMUTABLE; SU CICLO DE VIDA NO. payload, proveedor e
--    identidad externa quedan congelados por trigger — son la evidencia de lo
--    que el proveedor mandó—. Lo que sí transiciona es el estado
--    (received → processing → processed | failed | ignored), con reclamo
--    CONDICIONAL: dos procesadores sobre el mismo evento se resuelven a uno.
--
-- B. SIN IDENTIDAD EXTERNA NO HAY DEDUPE MÁGICO: el adaptador la fabrica con
--    un hash del payload ANTES de insertar. La base exige el identificador —
--    nulo se rechaza— porque un dedupe opcional es un dedupe que nadie ejerce.
--
-- C. LAS MÉTRICAS LEEN VENTAS REALES. Todo importe sale de sales (Bloque 2);
--    los mensajes y carritos aportan recuentos y tiempos, jamás dinero. Una
--    caída de Meta o TikTok deja eventos en failed con reintento programado y
--    NO toca venta, caja ni inventario: los dominios están desacoplados por
--    construcción.

begin;

create type public.webhook_event_status as enum (
  'received', 'processing', 'processed', 'failed', 'ignored'
);

-- ---------------------------------------------------------------------------
-- 1. Conexiones
-- ---------------------------------------------------------------------------
-- Configuración NO sensible. Tokens y secretos viven en el entorno del
-- servidor; aquí solo el estado operativo de cada integración.

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  channel_account_id uuid references public.channel_accounts(id) on delete restrict,
  display_name text not null,
  status text not null default 'active',
  config jsonb not null default '{}'::jsonb,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_connections_provider_format check (provider ~ '^[a-z0-9_]{2,30}$'),
  constraint integration_connections_status_valid check (status in ('active', 'disabled', 'error')),
  constraint integration_connections_name_not_blank check (length(trim(display_name)) > 0)
);

create index integration_connections_provider_idx
on public.integration_connections(provider, status);

create trigger integration_connections_set_updated_at
before update on public.integration_connections
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Eventos de webhook: insert-first
-- ---------------------------------------------------------------------------

create table public.integration_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  -- Decisión B: SIEMPRE hay identidad. Si el proveedor no la da, el adaptador
  -- la fabrica con un hash estable del payload.
  external_event_id text not null,
  integration_connection_id uuid references public.integration_connections(id) on delete restrict,
  status public.webhook_event_status not null default 'received',
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  next_retry_at timestamptz,
  result jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint integration_webhook_events_provider_format check (provider ~ '^[a-z0-9_]{2,30}$'),
  constraint integration_webhook_events_external_not_blank check (length(trim(external_event_id)) > 0),
  constraint integration_webhook_events_attempts_non_negative check (attempts >= 0),
  -- El dedupe del plan: mismo proveedor + mismo evento = una fila.
  constraint integration_webhook_events_unique unique (provider, external_event_id)
);

create index integration_webhook_events_status_idx
on public.integration_webhook_events(status, received_at desc);
create index integration_webhook_events_retry_idx
on public.integration_webhook_events(next_retry_at)
where status = 'failed' and next_retry_at is not null;

comment on table public.integration_webhook_events is
  'Todo webhook se INSERTA antes de procesarse. El payload es evidencia '
  'inmutable; el estado transiciona por reclamo condicional.';

-- Decisión A: la evidencia no se toca.
create or replace function public.reject_webhook_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider is distinct from old.provider
     or new.external_event_id is distinct from old.external_event_id
     or new.payload is distinct from old.payload
     or new.received_at is distinct from old.received_at then
    raise exception using
      errcode = '23514',
      message = 'La evidencia de un webhook no se reescribe: solo transiciona su estado.';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_webhook_evidence_mutation() from public, anon;

create trigger integration_webhook_events_evidence_immutable
before update on public.integration_webhook_events
for each row execute function public.reject_webhook_evidence_mutation();

-- ---------------------------------------------------------------------------
-- 3. Entregas salientes
-- ---------------------------------------------------------------------------

create table public.integration_delivery_attempts (
  id bigint generated always as identity primary key,
  provider text not null,
  channel_message_id uuid references public.channel_messages(id) on delete restrict,
  endpoint text,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  -- Resúmenes sin secretos: qué se intentó y qué respondió el proveedor.
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_delivery_attempts_status_valid check (
    status in ('pending', 'sent', 'failed', 'skipped')
  )
);

create index integration_delivery_attempts_message_idx
on public.integration_delivery_attempts(channel_message_id)
where channel_message_id is not null;
create index integration_delivery_attempts_status_idx
on public.integration_delivery_attempts(status, created_at desc);

create trigger integration_delivery_attempts_set_updated_at
before update on public.integration_delivery_attempts
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Contratos del ciclo de vida
-- ---------------------------------------------------------------------------

-- INSERT PRIMERO. El duplicado devuelve al ganador con duplicate=true; el
-- procesamiento viene después y aparte.
create or replace function public.ingest_webhook_event(
  p_provider text,
  p_external_event_id text,
  p_payload jsonb,
  p_connection_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_id bigint;
  duplicate boolean := false;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración registra webhooks a mano.';
  end if;

  insert into public.integration_webhook_events (
    provider, external_event_id, integration_connection_id, payload
  ) values (
    lower(trim(p_provider)), trim(p_external_event_id), p_connection_id, coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (provider, external_event_id) do nothing
  returning id into event_id;

  if event_id is null then
    duplicate := true;
    select id into event_id from public.integration_webhook_events
    where provider = lower(trim(p_provider)) and external_event_id = trim(p_external_event_id);
  end if;

  if p_connection_id is not null then
    update public.integration_connections
    set last_event_at = now() where id = p_connection_id;
  end if;

  return jsonb_build_object('eventId', event_id, 'duplicate', duplicate);
end;
$$;

-- Reclamo CONDICIONAL: dos procesadores sobre el mismo evento → exactamente
-- uno lo procesa. El reintento de un fallido respeta su next_retry_at.
create or replace function public.claim_webhook_event(p_event_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.integration_webhook_events%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración procesa webhooks a mano.';
  end if;

  update public.integration_webhook_events
  set status = 'processing', attempts = attempts + 1
  where id = p_event_id
    and (status = 'received'
         or (status = 'failed' and (next_retry_at is null or next_retry_at <= now())))
  returning * into claimed;

  if claimed.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'eventId', claimed.id,
    'provider', claimed.provider,
    'externalEventId', claimed.external_event_id,
    'payload', claimed.payload,
    'attempts', claimed.attempts
  );
end;
$$;

create or replace function public.complete_webhook_event(p_event_id bigint, p_result jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved boolean;
begin
  update public.integration_webhook_events
  set status = 'processed', processed_at = now(), result = coalesce(p_result, '{}'::jsonb),
      last_error = null, next_retry_at = null
  where id = p_event_id and status = 'processing';

  get diagnostics moved = row_count;
  return moved;
end;
$$;

create or replace function public.fail_webhook_event(
  p_event_id bigint,
  p_error text,
  p_retry_in interval default interval '5 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved boolean;
begin
  update public.integration_webhook_events
  set status = 'failed',
      last_error = left(coalesce(p_error, 'error desconocido'), 2000),
      next_retry_at = case when p_retry_in is null then null else now() + p_retry_in end
  where id = p_event_id and status = 'processing';

  get diagnostics moved = row_count;
  return moved;
end;
$$;

create or replace function public.ignore_webhook_event(p_event_id bigint, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved boolean;
begin
  update public.integration_webhook_events
  set status = 'ignored', last_error = left(coalesce(p_reason, 'ignorado'), 2000), processed_at = now()
  where id = p_event_id and status in ('received', 'processing');

  get diagnostics moved = row_count;
  return moved;
end;
$$;

create or replace function public.record_delivery_attempt(
  p_provider text,
  p_channel_message_id uuid,
  p_status text,
  p_endpoint text default null,
  p_error text default null,
  p_request_summary jsonb default '{}'::jsonb,
  p_response_summary jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_id bigint;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo registra entregas.';
  end if;

  insert into public.integration_delivery_attempts (
    provider, channel_message_id, endpoint, status, attempts,
    last_error, request_summary, response_summary
  ) values (
    lower(trim(p_provider)), p_channel_message_id, p_endpoint, p_status, 1,
    left(p_error, 2000), coalesce(p_request_summary, '{}'::jsonb), coalesce(p_response_summary, '{}'::jsonb)
  )
  returning id into attempt_id;

  return attempt_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Métricas operativas
-- ---------------------------------------------------------------------------
-- Decisión C: el dinero sale de sales. Lo demás aporta recuentos y tiempos.

create or replace function public.omnichannel_metrics(
  p_from date default current_date - 30,
  p_to date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  window_start timestamptz := p_from::timestamptz;
  window_end timestamptz := (p_to + 1)::timestamptz;
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Las métricas omnicanal son administrativas.';
  end if;

  select jsonb_build_object(
    'from', p_from,
    'to', p_to,

    'conversationsByChannel', coalesce((
      select jsonb_object_agg(ch.code, counts.total)
      from (
        select ca.channel_id, count(*) as total
        from public.channel_conversations c
        join public.channel_accounts ca on ca.id = c.channel_account_id
        where c.opened_at >= window_start and c.opened_at < window_end
        group by ca.channel_id
      ) counts
      join public.channels ch on ch.id = counts.channel_id
    ), '{}'::jsonb),

    'carts', (
      select jsonb_build_object(
        'created', count(*) filter (where created_at >= window_start and created_at < window_end),
        'active', count(*) filter (where status = 'active'),
        'abandoned', count(*) filter (where status = 'abandoned'),
        'converted', count(*) filter (where status = 'converted'
                                      and last_activity_at >= window_start and last_activity_at < window_end),
        'expired', count(*) filter (where status = 'expired')
      )
      from public.public_carts
    ),

    -- El dinero: SIEMPRE de sales confirmadas del Bloque 2.
    'salesByChannel', coalesce((
      select jsonb_object_agg(source_channel, jsonb_build_object(
        'count', total_count, 'revenue', revenue,
        'averageTicket', round(revenue / nullif(total_count, 0), 2)
      ))
      from (
        select s.source_channel, count(*) as total_count, sum(s.total) as revenue
        from public.sales s
        where s.status = 'confirmed'
          and s.issued_at >= window_start and s.issued_at < window_end
        group by s.source_channel
      ) by_channel
    ), '{}'::jsonb),

    'salesByCampaign', coalesce((
      select jsonb_object_agg(campaign_code, jsonb_build_object('count', total_count, 'revenue', revenue))
      from (
        select mc.code as campaign_code, count(*) as total_count, sum(s.total) as revenue
        from public.channel_attributions a
        join public.sales s on s.id = a.sale_id and s.status = 'confirmed'
        join public.marketing_campaigns mc on mc.id = coalesce(a.first_campaign_id, a.last_campaign_id)
        where s.issued_at >= window_start and s.issued_at < window_end
        group by mc.code
      ) by_campaign
    ), '{}'::jsonb),

    'salesBySeller', coalesce((
      select jsonb_object_agg(coalesce(seller_label, 'Sin registrar'),
                              jsonb_build_object('count', total_count, 'revenue', revenue))
      from (
        select s.seller_label, count(*) as total_count, sum(s.total) as revenue
        from public.sales s
        where s.status = 'confirmed'
          and s.issued_at >= window_start and s.issued_at < window_end
        group by s.seller_label
      ) by_seller
    ), '{}'::jsonb),

    'cartToSaleConversion', (
      select round(
        count(*) filter (where status = 'converted' and converted_sale_id is not null)::numeric
          / nullif(count(*), 0), 4)
      from public.public_carts
      where created_at >= window_start and created_at < window_end
    ),

    'conversationToSaleConversion', (
      select round(
        count(distinct a.conversation_id) filter (where a.sale_id is not null)::numeric
          / nullif((select count(*) from public.channel_conversations c
                    where c.opened_at >= window_start and c.opened_at < window_end), 0), 4)
      from public.channel_attributions a
      where a.conversation_id is not null
    ),

    -- Tiempo hasta la primera atención: primer mensaje saliente después del
    -- primer entrante, por conversación.
    'avgMinutesToFirstReply', (
      select round(avg(extract(epoch from first_out - first_in) / 60)::numeric, 1)
      from (
        select
          min(m.received_at) filter (where m.direction = 'inbound') as first_in,
          min(m.received_at) filter (where m.direction = 'outbound') as first_out
        from public.channel_messages m
        join public.channel_conversations c on c.id = m.conversation_id
        where c.opened_at >= window_start and c.opened_at < window_end
        group by m.conversation_id
      ) timing
      where first_in is not null and first_out is not null and first_out > first_in
    ),

    -- Tiempo del primer toque a la venta, por cadena cerrada.
    'avgHoursToSale', (
      select round(avg(extract(epoch from s.issued_at - a.first_touch_at) / 3600)::numeric, 1)
      from public.channel_attributions a
      join public.sales s on s.id = a.sale_id and s.status = 'confirmed'
      where s.issued_at >= window_start and s.issued_at < window_end
    )
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS y privilegios
-- ---------------------------------------------------------------------------

alter table public.integration_connections enable row level security;
alter table public.integration_webhook_events enable row level security;
alter table public.integration_delivery_attempts enable row level security;

create policy "admins manage integration connections"
on public.integration_connections for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins read webhook events"
on public.integration_webhook_events for select to authenticated
using (public.is_admin());

create policy "admins read delivery attempts"
on public.integration_delivery_attempts for select to authenticated
using (public.is_admin());

grant select, insert, update, delete on public.integration_connections to authenticated;
grant select on public.integration_webhook_events to authenticated;
grant select on public.integration_delivery_attempts to authenticated;

grant select, insert, update, delete on
  public.integration_connections, public.integration_webhook_events,
  public.integration_delivery_attempts
to service_role;

revoke all on public.integration_connections, public.integration_webhook_events,
  public.integration_delivery_attempts
from anon;

revoke truncate on public.integration_connections, public.integration_webhook_events,
  public.integration_delivery_attempts
from anon, authenticated, service_role;

revoke all on function public.ingest_webhook_event(text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.claim_webhook_event(bigint) from public, anon, authenticated;
revoke all on function public.complete_webhook_event(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fail_webhook_event(bigint, text, interval) from public, anon, authenticated;
revoke all on function public.ignore_webhook_event(bigint, text) from public, anon, authenticated;
revoke all on function public.record_delivery_attempt(text, uuid, text, text, text, jsonb, jsonb) from public, anon;
revoke all on function public.omnichannel_metrics(date, date) from public, anon;

-- El ciclo de webhooks es del SERVIDOR (service_role) y de administración para
-- reintentos manuales.
grant execute on function public.ingest_webhook_event(text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.claim_webhook_event(bigint) to authenticated, service_role;
grant execute on function public.complete_webhook_event(bigint, jsonb) to authenticated, service_role;
grant execute on function public.fail_webhook_event(bigint, text, interval) to authenticated, service_role;
grant execute on function public.ignore_webhook_event(bigint, text) to authenticated, service_role;
grant execute on function public.record_delivery_attempt(text, uuid, text, text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.omnichannel_metrics(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Auditoría
-- ---------------------------------------------------------------------------
-- Las conexiones son decisiones administrativas. Los eventos son evidencia con
-- su propio trigger de inmutabilidad; auditarlos duplicaría cada webhook.

select public.attach_audit('public.integration_connections');

commit;
