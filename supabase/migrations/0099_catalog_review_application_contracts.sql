-- ---------------------------------------------------------------------------
-- 0099 · Contratos de aplicación para Catálogo → Revisar
-- ---------------------------------------------------------------------------
-- La UI no ordena trabajo ni muta estados directamente. PostgreSQL decide el
-- siguiente caso, conserva aplazamientos y registra cada transición.

begin;

alter table public.catalog_review_work_items
  add column assigned_to uuid references auth.users(id) on delete set null,
  add column started_at timestamptz,
  add column deferred_until timestamptz,
  add column defer_reason text;

alter table public.catalog_review_work_items
  add constraint catalog_review_defer_consistent check (
    (deferred_until is null and defer_reason is null)
    or (deferred_until is not null and defer_reason is not null and length(trim(defer_reason)) > 0)
  );

create index catalog_review_work_deferred_idx
  on public.catalog_review_work_items(deferred_until, status)
  where deferred_until is not null;

alter table public.catalog_review_events
  drop constraint catalog_review_event_type_allowed;

alter table public.catalog_review_events
  add constraint catalog_review_event_type_allowed check (event_type in (
    'work_created', 'work_superseded', 'work_started', 'work_deferred',
    'work_resumed', 'decision_taken', 'decision_superseded',
    'source_status_synchronized'
  ));

-- Vista operativa: mantiene intacto el contrato de motor y agrega solo estado
-- de sesión/aplazamiento para la capa de aplicación.
create or replace view public.catalog_review_operational_queue_v1
with (security_invoker = true) as
select
  queue.*,
  item.assigned_to,
  item.started_at,
  item.deferred_until,
  item.defer_reason,
  item.deferred_until is not null and item.deferred_until > now() as is_deferred
from public.catalog_review_queue_v1 queue
join public.catalog_review_work_items item on item.id = queue.id;

create or replace view public.catalog_review_summary_v1
with (security_invoker = true) as
select
  count(*) filter (
    where queue_state = 'reviewable' and not is_deferred
  )::bigint as reviewable_count,
  count(*) filter (
    where queue_state = 'capture_required' and not is_deferred
  )::bigint as capture_count,
  count(*) filter (
    where queue_state = 'waiting_external' and not is_deferred
  )::bigint as waiting_count,
  count(*) filter (where status = 'resolved')::bigint as completed_count,
  count(*) filter (where queue_state = 'blocked')::bigint as blocked_count,
  coalesce(sum(unlock_count) filter (
    where queue_state = 'reviewable' and not is_deferred
  ), 0)::bigint as reviewable_unlock_count
from public.catalog_review_operational_queue_v1;

-- Orden lexicográfico congelado: riesgo → contradicción → resolubilidad →
-- desbloqueo → relevancia → antigüedad → esfuerzo. Los filtros opcionales no
-- cambian el significado de “Continuar revisión”.
create or replace function public.next_catalog_review_item_v1(
  p_exclude_ids uuid[] default '{}'::uuid[],
  p_work_kind text default null,
  p_purpose text default null,
  p_group_key text default null
)
returns setof public.catalog_review_operational_queue_v1
language sql
stable
security invoker
set search_path = ''
as $function$
  select queue.*
  from public.catalog_review_operational_queue_v1 queue
  where queue.queue_state = 'reviewable'
    and queue.can_resolve_now
    and not queue.is_deferred
    and not (queue.id = any(coalesce(p_exclude_ids, '{}'::uuid[])))
    and (p_work_kind is null or queue.work_kind = p_work_kind)
    and (p_purpose is null or queue.purpose = p_purpose)
    and (p_group_key is null or queue.group_key = p_group_key)
  order by
    case queue.risk_level
      when 'critical' then 0
      when 'high' then 1
      when 'normal' then 2
      else 3
    end,
    queue.has_contradiction desc,
    queue.can_resolve_now desc,
    queue.unlock_count desc,
    queue.business_relevance desc,
    queue.created_at asc,
    queue.estimated_effort asc,
    queue.id asc
  limit 1;
$function$;

-- Listado navegable para búsquedas administrativas. El cursor estable es el
-- par (created_at, id); nunca se usa offset sobre miles de trabajos.
create or replace function public.list_catalog_review_items_v1(
  p_queue_state text default null,
  p_work_kind text default null,
  p_purpose text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns setof public.catalog_review_operational_queue_v1
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'El límite debe estar entre 1 y 100.';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'El cursor está incompleto.';
  end if;

  return query
  select queue.*
  from public.catalog_review_operational_queue_v1 queue
  where (p_queue_state is null or queue.queue_state = p_queue_state)
    and (p_work_kind is null or queue.work_kind = p_work_kind)
    and (p_purpose is null or queue.purpose = p_purpose)
    and (
      p_cursor_created_at is null
      or (queue.created_at, queue.id) > (p_cursor_created_at, p_cursor_id)
    )
  order by queue.created_at, queue.id
  limit p_limit;
end;
$function$;

create or replace function public.transition_catalog_review_item_v1(
  p_work_item_id uuid,
  p_expected_version bigint,
  p_action_code text,
  p_reason text,
  p_idempotency_key text,
  p_defer_minutes integer default 1440,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := coalesce(auth.uid(), p_actor_id);
  actor_name text;
  item public.catalog_review_work_items%rowtype;
  changed public.catalog_review_work_items%rowtype;
  prior_event public.catalog_review_events%rowtype;
  request_fingerprint text;
  reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'No puedes actuar en nombre de otra persona.';
  end if;
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501', message = 'Solo administración puede organizar revisiones del catálogo.';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'La transición exige la versión observada.';
  end if;
  if p_action_code not in ('start', 'defer', 'resume') then
    raise exception using errcode = '22023', message = 'La transición solo admite iniciar, posponer o reanudar.';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'La clave idempotente es obligatoria.';
  end if;
  if p_action_code = 'defer' and reason is null then
    raise exception using errcode = '22023', message = 'Posponer exige explicar qué evidencia falta.';
  end if;
  if p_action_code = 'defer' and (p_defer_minutes < 5 or p_defer_minutes > 10080) then
    raise exception using errcode = '22023', message = 'El aplazamiento debe estar entre 5 minutos y 7 días.';
  end if;

  request_fingerprint := md5(jsonb_build_object(
    'workItemId', p_work_item_id,
    'expectedVersion', p_expected_version,
    'actionCode', p_action_code,
    'reason', reason,
    'deferMinutes', p_defer_minutes
  )::text);

  select * into prior_event
  from public.catalog_review_events event
  where event.idempotency_key = p_idempotency_key;

  if found then
    if prior_event.request_fingerprint <> request_fingerprint
       or prior_event.work_item_id <> p_work_item_id then
      raise exception using errcode = '23505', message = 'La clave idempotente ya fue utilizada para otra operación.';
    end if;
    select * into item from public.catalog_review_work_items where id = p_work_item_id;
    return jsonb_build_object(
      'workItemId', item.id,
      'status', item.status,
      'rowVersion', item.row_version,
      'deferredUntil', item.deferred_until,
      'idempotentReplay', true
    );
  end if;

  select * into item
  from public.catalog_review_work_items
  where id = p_work_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'El trabajo de revisión no existe.';
  end if;
  if item.row_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Este caso cambió desde que lo abriste. Revisa la información actual.';
  end if;
  if item.status not in ('open', 'in_progress') then
    raise exception using errcode = '23514', message = 'Este caso ya no admite cambios de sesión.';
  end if;

  if p_action_code = 'start' then
    update public.catalog_review_work_items
    set status = 'in_progress', assigned_to = actor,
        started_at = coalesce(started_at, now()),
        deferred_until = null, defer_reason = null
    where id = item.id
    returning * into changed;
  elsif p_action_code = 'defer' then
    update public.catalog_review_work_items
    set status = 'open', assigned_to = null,
        deferred_until = now() + make_interval(mins => p_defer_minutes),
        defer_reason = reason
    where id = item.id
    returning * into changed;
  else
    update public.catalog_review_work_items
    set status = 'open', assigned_to = null,
        deferred_until = null, defer_reason = null
    where id = item.id
    returning * into changed;
  end if;

  select full_name into actor_name from public.admin_profiles where id = actor;

  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id, actor_label,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  ) values (
    changed.id, changed.work_key,
    case p_action_code
      when 'start' then 'work_started'
      when 'defer' then 'work_deferred'
      else 'work_resumed'
    end,
    p_action_code, actor, actor_name, p_idempotency_key, request_fingerprint,
    item.row_version, changed.row_version,
    jsonb_strip_nulls(jsonb_build_object(
      'reason', reason,
      'deferredUntil', changed.deferred_until
    ))
  );

  return jsonb_build_object(
    'workItemId', changed.id,
    'status', changed.status,
    'rowVersion', changed.row_version,
    'deferredUntil', changed.deferred_until,
    'idempotentReplay', false
  );
end;
$function$;

-- Registra en el propio evento el impacto visible inmediatamente después de
-- una decisión. No reescribe historia: completa NEW antes de insertar.
create or replace function public.attach_catalog_review_event_impact()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  unlocked_count integer := 0;
  invalidated_count integer := 0;
begin
  if new.event_type <> 'decision_taken' then return new; end if;

  select count(distinct dependency.dependent_work_item_id)::integer
  into unlocked_count
  from public.catalog_review_dependencies dependency
  join public.catalog_review_queue_v1 queue
    on queue.id = dependency.dependent_work_item_id
  where dependency.prerequisite_work_item_id = new.work_item_id
    and queue.queue_state in ('reviewable', 'capture_required', 'waiting_external');

  select count(distinct dependency.dependent_work_item_id)::integer
  into invalidated_count
  from public.catalog_review_dependencies dependency
  join public.catalog_review_work_items dependent
    on dependent.id = dependency.dependent_work_item_id
  where dependency.prerequisite_work_item_id = new.work_item_id
    and dependency.dependency_type = 'invalidated_by'
    and dependent.status in ('open', 'in_progress')
    and (
      not (dependency.condition ? 'resolution_codes')
      or new.action_code in (
        select jsonb_array_elements_text(dependency.condition -> 'resolution_codes')
      )
    );

  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object(
    '_impact', jsonb_build_object(
      'unlockedCount', unlocked_count,
      'invalidatedCount', invalidated_count
    )
  );
  return new;
end;
$function$;

create trigger catalog_review_event_impact
before insert on public.catalog_review_events
for each row execute function public.attach_catalog_review_event_impact();

create or replace view public.catalog_review_activity_summary_v1
with (security_invoker = true) as
select
  count(*) filter (
    where event.event_type = 'decision_taken'
      and event.occurred_at >= date_trunc('day', now())
  )::bigint as decisions_today,
  coalesce(sum(
    case when event.event_type = 'decision_taken'
      and event.occurred_at >= date_trunc('day', now())
      then coalesce((event.payload -> '_impact' ->> 'unlockedCount')::integer, 0)
      else 0 end
  ), 0)::bigint as unlocked_today,
  count(distinct item.subject_id) filter (
    where event.event_type = 'decision_taken'
      and event.occurred_at >= date_trunc('day', now())
      and item.subject_id is not null
  )::bigint as entities_advanced_today
from public.catalog_review_events event
join public.catalog_review_work_items item on item.id = event.work_item_id;

alter table public.catalog_review_work_items enable row level security;

grant select on public.catalog_review_operational_queue_v1,
  public.catalog_review_activity_summary_v1 to authenticated, service_role;

revoke all on function public.next_catalog_review_item_v1(uuid[],text,text,text)
from public, anon;
grant execute on function public.next_catalog_review_item_v1(uuid[],text,text,text)
to authenticated, service_role;

revoke all on function public.list_catalog_review_items_v1(text,text,text,timestamptz,uuid,integer)
from public, anon;
grant execute on function public.list_catalog_review_items_v1(text,text,text,timestamptz,uuid,integer)
to authenticated, service_role;

revoke all on function public.transition_catalog_review_item_v1(uuid,bigint,text,text,text,integer,uuid)
from public, anon;
grant execute on function public.transition_catalog_review_item_v1(uuid,bigint,text,text,text,integer,uuid)
to authenticated, service_role;

revoke all on function public.attach_catalog_review_event_impact()
from public, anon, authenticated;

comment on view public.catalog_review_operational_queue_v1 is
  'Contrato administrativo de lectura: cola del motor más estado de sesión, sin lógica de presentación React.';
comment on function public.next_catalog_review_item_v1(uuid[],text,text,text) is
  'Selecciona exactamente un caso según el orden lexicográfico congelado de Continuar revisión.';
comment on function public.transition_catalog_review_item_v1(uuid,bigint,text,text,text,integer,uuid) is
  'Inicia, aplaza o reanuda sin convertir falta de evidencia en una resolución falsa.';

commit;
