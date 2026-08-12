-- ---------------------------------------------------------------------------
-- 0097 · Motor estable de revisión del catálogo
-- ---------------------------------------------------------------------------
-- La cola coordina trabajo; no sustituye al catálogo, la evidencia ni los
-- casos canónicos. Sus claves son deterministas, las decisiones son
-- transaccionales y los eventos conservan la historia sin convertir el
-- sistema en event sourcing.

begin;

-- Una excepción que deja de ser emitida no está "resuelta" por criterio
-- humano: queda superseded y puede reaparecer como una nueva versión del
-- problema si el pipeline vuelve a observarla.
alter table public.catalog_enrichment_exceptions
  drop constraint catalog_enrichment_exceptions_status_allowed,
  drop constraint catalog_enrichment_exceptions_resolution_consistent;

alter table public.catalog_enrichment_exceptions
  add constraint catalog_enrichment_exceptions_status_allowed check (
    status in ('open', 'in_review', 'resolved', 'waived', 'superseded')
  ),
  add constraint catalog_enrichment_exceptions_resolution_consistent check (
    (status in ('open', 'in_review') and resolved_at is null)
    or (status in ('resolved', 'waived', 'superseded') and resolved_at is not null)
  );

create table public.catalog_review_work_items (
  id uuid primary key default gen_random_uuid(),
  work_family_key text not null,
  problem_version integer not null,
  work_key text generated always as (
    work_family_key || ':v' || problem_version::text
  ) stored,
  source_type text not null,
  source_id uuid,
  work_kind text not null,
  purpose text not null,
  subject_type text not null,
  subject_id uuid,
  group_key text,
  status text not null default 'open',
  priority_tier text not null default 'normal',
  risk_level text not null default 'normal',
  has_contradiction boolean not null default false,
  unlock_count integer not null default 0,
  business_relevance numeric(8,4) not null default 0,
  estimated_effort smallint not null default 1,
  question text not null,
  recommendation text,
  material_fingerprint text not null,
  context jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  supersedes_work_item_id uuid references public.catalog_review_work_items(id) on delete restrict,
  resolution_code text,
  resolution_payload jsonb,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_family_key, problem_version),
  unique (work_key),
  constraint catalog_review_work_family_key_format check (
    work_family_key ~ '^[a-z0-9][a-z0-9:_-]*$'
  ),
  constraint catalog_review_problem_version_positive check (problem_version > 0),
  constraint catalog_review_source_type_allowed check (source_type in (
    'reconciliation_case', 'enrichment_exception', 'relation_candidate',
    'knowledge_gap', 'manual'
  )),
  constraint catalog_review_source_reference_consistent check (
    source_type = 'manual' or source_id is not null
  ),
  constraint catalog_review_work_kind_allowed check (work_kind in (
    'decision', 'capture', 'waiting_external', 'audit'
  )),
  constraint catalog_review_purpose_allowed check (purpose in (
    'identity', 'variant_structure', 'tone', 'image', 'attribute',
    'classification', 'relation', 'source_verification', 'other'
  )),
  constraint catalog_review_subject_type_allowed check (subject_type in (
    'product', 'variant', 'shade', 'brand', 'class', 'system',
    'relation', 'source_record', 'other'
  )),
  constraint catalog_review_status_allowed check (status in (
    'open', 'in_progress', 'resolved', 'superseded', 'cancelled'
  )),
  constraint catalog_review_priority_allowed check (priority_tier in (
    'critical', 'high', 'normal', 'low'
  )),
  constraint catalog_review_risk_allowed check (risk_level in (
    'critical', 'high', 'normal', 'low'
  )),
  constraint catalog_review_unlock_nonnegative check (unlock_count >= 0),
  constraint catalog_review_relevance_range check (
    business_relevance >= 0 and business_relevance <= 100
  ),
  constraint catalog_review_effort_range check (estimated_effort between 1 and 10),
  constraint catalog_review_question_not_blank check (length(trim(question)) > 0),
  constraint catalog_review_recommendation_not_blank check (
    recommendation is null or length(trim(recommendation)) > 0
  ),
  constraint catalog_review_fingerprint_not_blank check (
    length(trim(material_fingerprint)) >= 16
  ),
  constraint catalog_review_group_key_not_blank check (
    group_key is null or length(trim(group_key)) > 0
  ),
  constraint catalog_review_context_object check (jsonb_typeof(context) = 'object'),
  constraint catalog_review_resolution_payload_object check (
    resolution_payload is null or jsonb_typeof(resolution_payload) = 'object'
  ),
  constraint catalog_review_resolution_consistent check (
    (status in ('open', 'in_progress')
      and resolution_code is null and resolution_payload is null
      and resolved_by is null and resolved_at is null)
    or (status = 'resolved'
      and resolution_code is not null and resolution_payload is not null
      and resolved_at is not null)
    or (status in ('superseded', 'cancelled') and resolved_at is not null)
  ),
  constraint catalog_review_not_self_superseding check (
    supersedes_work_item_id is null or supersedes_work_item_id <> id
  )
);

create unique index catalog_review_active_source_unique_idx
  on public.catalog_review_work_items(source_type, source_id)
  where source_id is not null and status in ('open', 'in_progress');
create index catalog_review_work_queue_idx
  on public.catalog_review_work_items(status, work_kind, priority_tier, created_at);
create index catalog_review_work_group_idx
  on public.catalog_review_work_items(group_key, status)
  where group_key is not null;
create index catalog_review_work_subject_idx
  on public.catalog_review_work_items(subject_type, subject_id)
  where subject_id is not null;

create table public.catalog_review_dependencies (
  id uuid primary key default gen_random_uuid(),
  dependent_work_item_id uuid not null references public.catalog_review_work_items(id) on delete cascade,
  prerequisite_work_item_id uuid not null references public.catalog_review_work_items(id) on delete cascade,
  dependency_type text not null,
  group_key text not null default 'default',
  condition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key),
  constraint catalog_review_dependency_not_self check (
    dependent_work_item_id <> prerequisite_work_item_id
  ),
  constraint catalog_review_dependency_type_allowed check (dependency_type in (
    'requires_all', 'requires_any', 'invalidated_by'
  )),
  constraint catalog_review_dependency_group_not_blank check (length(trim(group_key)) > 0),
  constraint catalog_review_dependency_condition_object check (jsonb_typeof(condition) = 'object'),
  constraint catalog_review_dependency_resolution_codes_array check (
    not (condition ? 'resolution_codes')
    or jsonb_typeof(condition -> 'resolution_codes') = 'array'
  )
);

create index catalog_review_dependencies_prerequisite_idx
  on public.catalog_review_dependencies(prerequisite_work_item_id, dependency_type);

create table public.catalog_review_events (
  id bigint generated always as identity primary key,
  work_item_id uuid not null,
  work_key text not null,
  event_type text not null,
  action_code text,
  actor_id uuid,
  actor_label text,
  idempotency_key text not null unique,
  request_fingerprint text not null,
  prior_version bigint,
  new_version bigint,
  payload jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint catalog_review_event_type_allowed check (event_type in (
    'work_created', 'work_superseded', 'decision_taken',
    'decision_superseded', 'source_status_synchronized'
  )),
  constraint catalog_review_event_action_not_blank check (
    action_code is null or length(trim(action_code)) > 0
  ),
  constraint catalog_review_event_idempotency_not_blank check (
    length(trim(idempotency_key)) >= 8
  ),
  constraint catalog_review_event_fingerprint_not_blank check (
    length(trim(request_fingerprint)) >= 16
  ),
  constraint catalog_review_event_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint catalog_review_event_evidence_array check (jsonb_typeof(evidence) = 'array')
);

create index catalog_review_events_work_idx
  on public.catalog_review_events(work_item_id, occurred_at desc);
create index catalog_review_events_actor_idx
  on public.catalog_review_events(actor_id, occurred_at desc)
  where actor_id is not null;

create table public.catalog_review_batches (
  id uuid primary key default gen_random_uuid(),
  group_key text not null,
  status text not null default 'previewed',
  action_code text not null,
  decision_payload jsonb not null default '{}'::jsonb,
  snapshot_fingerprint text not null,
  snapshot_count integer not null,
  preview_idempotency_key text not null unique,
  preview_request_fingerprint text not null,
  application_idempotency_key text unique,
  created_by uuid references auth.users(id) on delete set null,
  applied_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint catalog_review_batch_group_not_blank check (length(trim(group_key)) > 0),
  constraint catalog_review_batch_status_allowed check (status in (
    'previewed', 'applied', 'expired', 'cancelled'
  )),
  constraint catalog_review_batch_action_not_blank check (length(trim(action_code)) > 0),
  constraint catalog_review_batch_payload_object check (jsonb_typeof(decision_payload) = 'object'),
  constraint catalog_review_batch_snapshot_count_positive check (snapshot_count > 0),
  constraint catalog_review_batch_application_consistent check (
    (status = 'previewed' and applied_at is null and applied_by is null and application_idempotency_key is null)
    or (status = 'applied' and applied_at is not null and application_idempotency_key is not null)
    or (status in ('expired', 'cancelled') and applied_at is null)
  )
);

create table public.catalog_review_batch_items (
  batch_id uuid not null references public.catalog_review_batches(id) on delete cascade,
  work_item_id uuid not null references public.catalog_review_work_items(id) on delete restrict,
  expected_version bigint not null,
  material_fingerprint text not null,
  primary key (batch_id, work_item_id),
  constraint catalog_review_batch_expected_version_positive check (expected_version > 0)
);

create index catalog_review_batch_items_work_idx
  on public.catalog_review_batch_items(work_item_id);

-- Estado materializado y versión optimista. Cada UPDATE real cambia la versión;
-- el frontend nunca puede sobrescribir una pantalla antigua silenciosamente.
create or replace function public.touch_catalog_review_work_item()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function public.preview_catalog_review_batch_v1(
  p_group_key text,
  p_action_code text,
  p_decision_payload jsonb,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := coalesce(auth.uid(), p_actor_id);
  existing_batch public.catalog_review_batches%rowtype;
  created_batch public.catalog_review_batches%rowtype;
  request_fingerprint text;
  snapshot_fingerprint text;
  snapshot_count integer;
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'No puedes previsualizar en nombre de otra persona.';
  end if;
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501', message = 'Solo administración puede preparar decisiones masivas.';
  end if;
  if nullif(trim(coalesce(p_group_key, '')), '') is null
     or nullif(trim(coalesce(p_action_code, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'El grupo, la acción y la clave idempotente son obligatorios.';
  end if;
  if jsonb_typeof(coalesce(p_decision_payload, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'La decisión masiva tiene un formato inválido.';
  end if;

  request_fingerprint := md5(jsonb_build_object(
    'groupKey', p_group_key,
    'actionCode', p_action_code,
    'decisionPayload', coalesce(p_decision_payload, '{}'::jsonb)
  )::text);

  select * into existing_batch
  from public.catalog_review_batches batch
  where batch.preview_idempotency_key = p_idempotency_key;

  if found then
    if existing_batch.preview_request_fingerprint <> request_fingerprint then
      raise exception using errcode = '23505', message = 'La clave idempotente ya fue utilizada para otra previsualización.';
    end if;
    return jsonb_build_object(
      'batchId', existing_batch.id,
      'groupKey', existing_batch.group_key,
      'status', existing_batch.status,
      'snapshotFingerprint', existing_batch.snapshot_fingerprint,
      'snapshotCount', existing_batch.snapshot_count,
      'idempotentReplay', true
    );
  end if;

  -- La selección exacta queda bloqueada en modo compartido mientras se calcula
  -- y se copia. Cambios posteriores son detectados al aplicar.
  perform 1
  from public.catalog_review_work_items item
  where item.id in (
    select queue.id
    from public.catalog_review_queue_v1 queue
    where queue.group_key = p_group_key and queue.can_resolve_now
  )
  order by item.id
  for share;

  select
    count(*)::integer,
    md5(string_agg(
      queue.id::text || ':' || queue.row_version::text || ':' || queue.material_fingerprint,
      '|' order by queue.id
    ))
  into snapshot_count, snapshot_fingerprint
  from public.catalog_review_queue_v1 queue
  where queue.group_key = p_group_key and queue.can_resolve_now;

  if coalesce(snapshot_count, 0) = 0 then
    raise exception using errcode = '23514', message = 'El grupo no contiene decisiones disponibles.';
  end if;

  insert into public.catalog_review_batches(
    group_key, action_code, decision_payload, snapshot_fingerprint,
    snapshot_count, preview_idempotency_key, preview_request_fingerprint,
    created_by
  ) values (
    p_group_key, p_action_code, coalesce(p_decision_payload, '{}'::jsonb),
    snapshot_fingerprint, snapshot_count, p_idempotency_key,
    request_fingerprint, actor
  )
  returning * into created_batch;

  insert into public.catalog_review_batch_items(
    batch_id, work_item_id, expected_version, material_fingerprint
  )
  select
    created_batch.id, queue.id, queue.row_version, queue.material_fingerprint
  from public.catalog_review_queue_v1 queue
  where queue.group_key = p_group_key and queue.can_resolve_now
  order by queue.id;

  return jsonb_build_object(
    'batchId', created_batch.id,
    'groupKey', created_batch.group_key,
    'status', created_batch.status,
    'snapshotFingerprint', created_batch.snapshot_fingerprint,
    'snapshotCount', created_batch.snapshot_count,
    'idempotentReplay', false
  );
end;
$function$;

create or replace function public.apply_catalog_review_batch_v1(
  p_batch_id uuid,
  p_expected_fingerprint text,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := coalesce(auth.uid(), p_actor_id);
  batch public.catalog_review_batches%rowtype;
  member record;
  current_fingerprint text;
  current_count integer;
  applied_count integer := 0;
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'No puedes aplicar un lote en nombre de otra persona.';
  end if;
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501', message = 'Solo administración puede aplicar decisiones masivas.';
  end if;
  if nullif(trim(coalesce(p_expected_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'La aplicación exige la huella revisada y una clave idempotente.';
  end if;

  select * into batch
  from public.catalog_review_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'La previsualización masiva no existe.';
  end if;

  if batch.status = 'applied' then
    if batch.application_idempotency_key = p_idempotency_key then
      return jsonb_build_object(
        'batchId', batch.id,
        'status', batch.status,
        'appliedCount', batch.snapshot_count,
        'idempotentReplay', true
      );
    end if;
    raise exception using errcode = '23514', message = 'Este lote ya fue aplicado con otra operación.';
  end if;

  if batch.status <> 'previewed' then
    raise exception using errcode = '23514', message = 'Esta previsualización ya no puede aplicarse.';
  end if;

  if batch.snapshot_fingerprint <> p_expected_fingerprint then
    raise exception using errcode = '40001', message = 'La huella aprobada no corresponde a esta previsualización.';
  end if;

  perform 1
  from public.catalog_review_work_items item
  where item.id in (
    select queue.id
    from public.catalog_review_queue_v1 queue
    where queue.group_key = batch.group_key and queue.can_resolve_now
  )
  order by item.id
  for update;

  select
    count(*)::integer,
    md5(string_agg(
      queue.id::text || ':' || queue.row_version::text || ':' || queue.material_fingerprint,
      '|' order by queue.id
    ))
  into current_count, current_fingerprint
  from public.catalog_review_queue_v1 queue
  where queue.group_key = batch.group_key and queue.can_resolve_now;

  if current_count <> batch.snapshot_count
     or current_fingerprint is distinct from batch.snapshot_fingerprint then
    raise exception using
      errcode = '40001',
      message = format(
        'El grupo cambió desde la revisión. Antes tenía %s casos y ahora tiene %s.',
        batch.snapshot_count, coalesce(current_count, 0)
      );
  end if;

  for member in
    select snapshot.*
    from public.catalog_review_batch_items snapshot
    where snapshot.batch_id = batch.id
    order by snapshot.work_item_id
  loop
    perform public.resolve_catalog_review_item_v1(
      member.work_item_id,
      member.expected_version,
      batch.action_code,
      batch.decision_payload,
      '[]'::jsonb,
      p_idempotency_key || ':item:' || member.work_item_id::text,
      actor
    );
    applied_count := applied_count + 1;
  end loop;

  update public.catalog_review_batches
  set
    status = 'applied',
    application_idempotency_key = p_idempotency_key,
    applied_by = actor,
    applied_at = now()
  where id = batch.id
  returning * into batch;

  return jsonb_build_object(
    'batchId', batch.id,
    'status', batch.status,
    'appliedCount', applied_count,
    'idempotentReplay', false
  );
end;
$function$;


-- Proyecta las fuentes canónicas a trabajo operativo. Las imágenes faltantes
-- normales se excluyen: cobertura pendiente no equivale a decisión humana.
-- Las relaciones sin evidencia quedan en espera, no en la cola accionable.
create or replace function public.sync_catalog_review_work_items_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_row record;
  registered public.catalog_review_work_items%rowtype;
  registered_count integer := 0;
  synchronized_count integer := 0;
  affected_count integer := 0;
begin
  for source_row in
    select
      reconciliation.*,
      coalesce(reconciliation.product_id, reconciliation.variant_id, reconciliation.shade_id) as subject_id,
      case reconciliation.entity_type
        when 'product' then 1 + (
          select count(*)::integer
          from public.product_variants variant
          where variant.product_id = reconciliation.product_id and variant.is_active
        )
        else 1
      end as impact
    from public.catalog_reconciliation_cases reconciliation
  loop
    select * into registered
    from public.register_catalog_review_work_item_v1(
      'reconciliation:' || source_row.entity_type || ':' || source_row.subject_id::text || ':' ||
        lower(regexp_replace(source_row.algorithm, '[^a-zA-Z0-9_-]+', '-', 'g')),
      'reconciliation_case', source_row.id, 'decision',
      case when source_row.entity_type = 'shade' then 'tone' else 'identity' end,
      source_row.entity_type, source_row.subject_id,
      md5(jsonb_build_object(
        'sourceRecordId', source_row.source_record_id,
        'algorithm', source_row.algorithm,
        'score', source_row.score,
        'evidence', source_row.evidence
      )::text),
      case source_row.entity_type
        when 'product' then '¿Este registro oficial corresponde al producto interno?'
        when 'variant' then '¿Este registro oficial corresponde a la variante interna?'
        else '¿El tono interno y el tono oficial representan el mismo color comercial?'
      end,
      case
        when source_row.evidence ? 'official_title' then source_row.evidence ->> 'official_title'
        when source_row.evidence ? 'official_tone' then source_row.evidence ->> 'official_tone'
        else null
      end,
      'reconciliation:' || source_row.entity_type || ':' ||
        lower(regexp_replace(source_row.algorithm, '[^a-zA-Z0-9_-]+', '-', 'g')),
      case
        when coalesce((source_row.evidence ->> 'ambiguous')::boolean, false) then 'high'
        else 'normal'
      end,
      case
        when coalesce((source_row.evidence ->> 'ambiguous')::boolean, false) then 'high'
        else 'normal'
      end,
      coalesce((source_row.evidence ->> 'ambiguous')::boolean, false),
      source_row.impact,
      0::numeric, 1::smallint,
      jsonb_build_object(
        'score', source_row.score,
        'algorithm', source_row.algorithm,
        'evidence', source_row.evidence,
        'canonicalStatus', source_row.status
      )
    );
    registered_count := registered_count + 1;
  end loop;

  for source_row in
    select exception.*
    from public.catalog_enrichment_exceptions exception
    where exception.exception_type <> 'image_missing'
      and not (
        exception.exception_type = 'image_ambiguous'
        and exception.details ->> 'source_exception_type' =
          'VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL'
      )
  loop
    select * into registered
    from public.register_catalog_review_work_item_v1(
      'exception:' || source_row.id::text || ':' ||
        case source_row.exception_type
          when 'identity_ambiguous' then 'identity'
          when 'sku_conflict' then 'identity'
          when 'barcode_conflict' then 'identity'
          when 'tone_missing' then 'tone'
          when 'image_ambiguous' then 'image'
          when 'physical_capture_required' then 'capture'
          when 'relation_requires_evidence' then 'relation'
          else 'source-verification'
        end,
      'enrichment_exception', source_row.id,
      case
        when source_row.exception_type = 'physical_capture_required' then 'capture'
        when source_row.exception_type in ('source_fetch_failed', 'product_not_in_current_source', 'tone_missing')
          then 'waiting_external'
        when source_row.exception_type = 'image_ambiguous' then 'audit'
        else 'decision'
      end,
      case source_row.exception_type
        when 'identity_ambiguous' then 'identity'
        when 'sku_conflict' then 'identity'
        when 'barcode_conflict' then 'identity'
        when 'tone_missing' then 'tone'
        when 'image_ambiguous' then 'image'
        when 'physical_capture_required' then 'image'
        when 'relation_requires_evidence' then 'relation'
        else 'source_verification'
      end,
      case
        when source_row.product_id is not null then 'product'
        when source_row.variant_id is not null then 'variant'
        when source_row.shade_id is not null then 'shade'
        when source_row.brand_id is not null then 'brand'
        else 'other'
      end,
      coalesce(source_row.product_id, source_row.variant_id, source_row.shade_id, source_row.brand_id),
      md5(jsonb_build_object(
        'exceptionType', source_row.exception_type,
        'severity', source_row.severity,
        'title', source_row.title,
        'details', source_row.details
      )::text),
      source_row.title,
      nullif(source_row.details ->> 'required_action', ''),
      'exception:' || source_row.exception_type || ':' || coalesce(source_row.brand_id::text, 'unscoped'),
      case source_row.severity
        when 'critical' then 'critical'
        when 'high' then 'high'
        when 'low' then 'low'
        else 'normal'
      end,
      case source_row.severity
        when 'critical' then 'critical'
        when 'high' then 'high'
        when 'low' then 'low'
        else 'normal'
      end,
      source_row.exception_type in ('identity_ambiguous', 'sku_conflict', 'barcode_conflict', 'image_ambiguous'),
      1, 0::numeric,
      (case when source_row.exception_type = 'physical_capture_required' then 3 else 1 end)::smallint,
      jsonb_build_object(
        'exceptionKey', source_row.exception_key,
        'details', source_row.details,
        'canonicalStatus', source_row.status
      )
    );
    registered_count := registered_count + 1;
  end loop;

  for source_row in
    select
      candidate.*,
      source_product.name as source_product_name,
      target_product.name as target_product_name
    from public.catalog_relation_candidates candidate
    join public.products source_product on source_product.id = candidate.source_product_id
    join public.products target_product on target_product.id = candidate.target_product_id
  loop
    select * into registered
    from public.register_catalog_review_work_item_v1(
      'relation-candidate:' || source_row.id::text || ':' ||
        lower(regexp_replace(source_row.rule_code, '[^a-zA-Z0-9_-]+', '-', 'g')),
      'relation_candidate', source_row.id, 'waiting_external', 'relation',
      'relation', source_row.id,
      md5(jsonb_build_object(
        'sourceProductId', source_row.source_product_id,
        'targetProductId', source_row.target_product_id,
        'relationType', source_row.relation_type,
        'ruleCode', source_row.rule_code,
        'rationale', source_row.rationale,
        'evidence', source_row.evidence
      )::text),
      format(
        '¿Qué evidencia demuestra la relación %s entre %s y %s?',
        source_row.relation_type, source_row.source_product_name, source_row.target_product_name
      ),
      'No aprobar la pareja hasta disponer de evidencia explícita.',
      'relation:' || lower(regexp_replace(source_row.rule_code, '[^a-zA-Z0-9_-]+', '-', 'g')) || ':' || source_row.confidence,
      case when source_row.relation_type = 'requires' then 'high' else 'normal' end,
      'normal',
      false, 1, 0::numeric, 5::smallint,
      jsonb_build_object(
        'sourceProductId', source_row.source_product_id,
        'targetProductId', source_row.target_product_id,
        'relationType', source_row.relation_type,
        'confidence', source_row.confidence,
        'rationale', source_row.rationale,
        'evidence', source_row.evidence,
        'canonicalStatus', source_row.status
      )
    );
    registered_count := registered_count + 1;
  end loop;

  for source_row in
    select gap.*
    from public.catalog_knowledge_gaps gap
  loop
    select * into registered
    from public.register_catalog_review_work_item_v1(
      'knowledge-gap:' || lower(source_row.gap_key) || ':' || source_row.gap_type,
      'knowledge_gap', source_row.id,
      case
        when source_row.metadata ? 'required_photos'
          or source_row.resolution_requirement ~* 'fotograf' then 'capture'
        when source_row.status = 'blocked_external' then 'waiting_external'
        else 'decision'
      end,
      case source_row.gap_type
        when 'identity' then 'identity'
        when 'media' then 'image'
        when 'membership' then 'classification'
        when 'compatibility' then 'relation'
        when 'incompatibility' then 'relation'
        else 'attribute'
      end,
      case
        when source_row.product_id is not null then 'product'
        when source_row.class_id is not null then 'class'
        else 'system'
      end,
      coalesce(source_row.product_id, source_row.class_id, source_row.system_id),
      md5(jsonb_build_object(
        'question', source_row.question,
        'requirement', source_row.resolution_requirement,
        'metadata', source_row.metadata
      )::text),
      source_row.question,
      source_row.resolution_requirement,
      'knowledge:' || source_row.system_id::text || ':' || source_row.gap_type,
      case source_row.priority
        when 'critical' then 'critical'
        when 'high' then 'high'
        when 'low' then 'low'
        else 'normal'
      end,
      case source_row.priority
        when 'critical' then 'critical'
        when 'high' then 'high'
        when 'low' then 'low'
        else 'normal'
      end,
      coalesce((source_row.metadata ->> 'identity_conflict')::boolean, false),
      1, 0::numeric, 3::smallint,
      jsonb_build_object(
        'gapKey', source_row.gap_key,
        'gapType', source_row.gap_type,
        'metadata', source_row.metadata,
        'canonicalStatus', source_row.status
      )
    );
    registered_count := registered_count + 1;
  end loop;

  -- Refleja decisiones canónicas ya tomadas sin reescribir su significado.
  with changed as (
    update public.catalog_review_work_items item
    set
      status = case when reconciliation.status = 'superseded' then 'superseded' else 'resolved' end,
      resolution_code = reconciliation.status,
      resolution_payload = jsonb_build_object(
        'canonicalStatus', reconciliation.status,
        'reason', reconciliation.decision_reason
      ),
      resolved_by = reconciliation.decided_by,
      resolved_at = reconciliation.decided_at
    from public.catalog_reconciliation_cases reconciliation
    where item.source_type = 'reconciliation_case'
      and item.source_id = reconciliation.id
      and reconciliation.status in ('approved', 'rejected', 'superseded')
      and item.status in ('open', 'in_progress')
    returning item.*
  )
  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  )
  select
    changed.id, changed.work_key, 'source_status_synchronized', changed.resolution_code,
    changed.resolved_by, 'system:source-sync:' || changed.id::text || ':' || changed.resolution_code,
    md5('source-sync:' || changed.id::text || ':' || changed.resolution_code),
    changed.row_version - 1, changed.row_version, changed.resolution_payload
  from changed
  on conflict (idempotency_key) do nothing;
  get diagnostics synchronized_count = row_count;

  with changed as (
    update public.catalog_review_work_items item
    set
      status = case when exception.status = 'superseded' then 'superseded' else 'resolved' end,
      resolution_code = exception.status,
      resolution_payload = jsonb_build_object(
        'canonicalStatus', exception.status,
        'notes', exception.resolution_notes
      ),
      resolved_by = exception.resolved_by,
      resolved_at = exception.resolved_at
    from public.catalog_enrichment_exceptions exception
    where item.source_type = 'enrichment_exception'
      and item.source_id = exception.id
      and exception.status in ('resolved', 'waived', 'superseded')
      and item.status in ('open', 'in_progress')
    returning item.*
  )
  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  )
  select
    changed.id, changed.work_key, 'source_status_synchronized', changed.resolution_code,
    changed.resolved_by, 'system:source-sync:' || changed.id::text || ':' || changed.resolution_code,
    md5('source-sync:' || changed.id::text || ':' || changed.resolution_code),
    changed.row_version - 1, changed.row_version, changed.resolution_payload
  from changed
  on conflict (idempotency_key) do nothing;
  get diagnostics affected_count = row_count;
  synchronized_count := synchronized_count + affected_count;

  with changed as (
    update public.catalog_review_work_items item
    set
      status = 'resolved',
      resolution_code = candidate.status,
      resolution_payload = jsonb_build_object(
        'canonicalStatus', candidate.status,
        'resolutionKind', candidate.resolution_kind
      ),
      resolved_by = candidate.decided_by,
      resolved_at = candidate.decided_at
    from public.catalog_relation_candidates candidate
    where item.source_type = 'relation_candidate'
      and item.source_id = candidate.id
      and candidate.status in ('approved', 'rejected', 'promoted')
      and item.status in ('open', 'in_progress')
    returning item.*
  )
  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  )
  select
    changed.id, changed.work_key, 'source_status_synchronized', changed.resolution_code,
    changed.resolved_by, 'system:source-sync:' || changed.id::text || ':' || changed.resolution_code,
    md5('source-sync:' || changed.id::text || ':' || changed.resolution_code),
    changed.row_version - 1, changed.row_version, changed.resolution_payload
  from changed
  on conflict (idempotency_key) do nothing;
  get diagnostics affected_count = row_count;
  synchronized_count := synchronized_count + affected_count;

  with changed as (
    update public.catalog_review_work_items item
    set
      status = case when gap.status = 'dismissed' then 'superseded' else 'resolved' end,
      resolution_code = gap.status,
      resolution_payload = jsonb_build_object(
        'canonicalStatus', gap.status,
        'evidenceSetId', gap.resolved_evidence_set_id
      ),
      resolved_by = gap.decided_by,
      resolved_at = gap.resolved_at
    from public.catalog_knowledge_gaps gap
    where item.source_type = 'knowledge_gap'
      and item.source_id = gap.id
      and gap.status in ('resolved', 'dismissed')
      and item.status in ('open', 'in_progress')
    returning item.*
  )
  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  )
  select
    changed.id, changed.work_key, 'source_status_synchronized', changed.resolution_code,
    changed.resolved_by, 'system:source-sync:' || changed.id::text || ':' || changed.resolution_code,
    md5('source-sync:' || changed.id::text || ':' || changed.resolution_code),
    changed.row_version - 1, changed.row_version, changed.resolution_payload
  from changed
  on conflict (idempotency_key) do nothing;
  get diagnostics affected_count = row_count;
  synchronized_count := synchronized_count + affected_count;

  return jsonb_build_object(
    'registeredSources', registered_count,
    'synchronizedOutcomes', synchronized_count,
    'workItems', (select count(*) from public.catalog_review_work_items)
  );
end;
$function$;

create or replace function public.resolve_catalog_review_item_v1(
  p_work_item_id uuid,
  p_expected_version bigint,
  p_action_code text,
  p_decision_payload jsonb,
  p_evidence jsonb,
  p_idempotency_key text,
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
  decided_item public.catalog_review_work_items%rowtype;
  prior_event public.catalog_review_events%rowtype;
  request_fingerprint text;
  resolved_reason text := nullif(trim(coalesce(p_decision_payload ->> 'reason', '')), '');
  evidence_set_id uuid;
  invalidated_count integer := 0;
  unlocked_count integer := 0;
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'No puedes decidir en nombre de otra persona.';
  end if;

  if actor is null or not public.is_admin(actor) then
    raise exception using errcode = '42501', message = 'Solo administración puede resolver revisiones del catálogo.';
  end if;

  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'La decisión exige la versión que se revisó.';
  end if;

  if nullif(trim(coalesce(p_action_code, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'La acción y su clave idempotente son obligatorias.';
  end if;

  if jsonb_typeof(coalesce(p_decision_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'La decisión o la evidencia tienen un formato inválido.';
  end if;

  request_fingerprint := md5(jsonb_build_object(
    'workItemId', p_work_item_id,
    'actionCode', p_action_code,
    'decisionPayload', coalesce(p_decision_payload, '{}'::jsonb),
    'evidence', coalesce(p_evidence, '[]'::jsonb)
  )::text);

  select * into prior_event
  from public.catalog_review_events event
  where event.idempotency_key = p_idempotency_key;

  if found then
    if prior_event.request_fingerprint <> request_fingerprint
       or prior_event.work_item_id <> p_work_item_id then
      raise exception using
        errcode = '23505',
        message = 'La clave idempotente ya fue utilizada para otra operación.';
    end if;

    select * into item
    from public.catalog_review_work_items
    where id = p_work_item_id;

    return jsonb_build_object(
      'workItemId', item.id,
      'workKey', item.work_key,
      'status', item.status,
      'rowVersion', item.row_version,
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
    raise exception using
      errcode = '40001',
      message = 'Este caso cambió desde que lo abriste. Revisa la información actual.';
  end if;

  if item.status not in ('open', 'in_progress') then
    raise exception using errcode = '23514', message = 'Este caso ya no está disponible para decidir.';
  end if;

  if item.work_kind not in ('decision', 'audit') then
    raise exception using
      errcode = '23514',
      message = 'Este trabajo necesita captura o información externa antes de una decisión.';
  end if;

  if not exists (
    select 1
    from public.catalog_review_queue_v1 queue
    where queue.id = item.id and queue.can_resolve_now
  ) then
    raise exception using errcode = '23514', message = 'Este caso todavía depende de otro trabajo.';
  end if;

  if item.source_type = 'reconciliation_case' then
    if p_action_code not in ('approve', 'reject') then
      raise exception using errcode = '22023', message = 'La reconciliación solo admite aprobar o rechazar.';
    end if;
    if resolved_reason is null then
      raise exception using errcode = '22023', message = 'Explica brevemente la decisión de identidad.';
    end if;

    update public.catalog_reconciliation_cases
    set
      status = case p_action_code when 'approve' then 'approved' else 'rejected' end,
      decision_reason = resolved_reason,
      decided_by = actor,
      decided_at = now()
    where id = item.source_id
      and status in ('proposed', 'needs_review');

    if not found then
      raise exception using errcode = '40001', message = 'El caso canónico cambió antes de aplicar la decisión.';
    end if;
  elsif item.source_type = 'enrichment_exception' then
    if p_action_code not in ('resolve', 'waive') then
      raise exception using errcode = '22023', message = 'La excepción solo admite resolver o descartar justificadamente.';
    end if;
    if resolved_reason is null then
      raise exception using errcode = '22023', message = 'La excepción exige una nota de resolución.';
    end if;

    update public.catalog_enrichment_exceptions
    set
      status = case p_action_code when 'resolve' then 'resolved' else 'waived' end,
      resolution_notes = resolved_reason,
      resolved_by = actor,
      resolved_at = now()
    where id = item.source_id
      and status in ('open', 'in_review');

    if not found then
      raise exception using errcode = '40001', message = 'La excepción cambió antes de aplicar la decisión.';
    end if;
  elsif item.source_type = 'relation_candidate' then
    if p_action_code <> 'reject'
       or p_decision_payload ->> 'resolutionKind' not in ('incorrect', 'insufficient_evidence') then
      raise exception using
        errcode = '22023',
        message = 'Una relación solo puede rechazarse aquí; su promoción exige el flujo de evidencia.';
    end if;
    if resolved_reason is null then
      raise exception using errcode = '22023', message = 'El rechazo de una relación exige una razón.';
    end if;

    update public.catalog_relation_candidates
    set
      status = 'rejected',
      resolution_kind = p_decision_payload ->> 'resolutionKind',
      decided_by = actor,
      decided_at = now(),
      evidence = evidence || jsonb_build_object('decisionReason', resolved_reason)
    where id = item.source_id
      and status in ('proposed', 'needs_evidence');

    if not found then
      raise exception using errcode = '40001', message = 'La relación cambió antes de aplicar la decisión.';
    end if;
  elsif item.source_type = 'knowledge_gap' then
    if p_action_code = 'dismiss' then
      if resolved_reason is null then
        raise exception using errcode = '22023', message = 'Descartar una brecha exige una razón.';
      end if;
      update public.catalog_knowledge_gaps
      set status = 'dismissed', decided_by = actor, resolved_at = now(),
          metadata = metadata || jsonb_build_object('dismissReason', resolved_reason)
      where id = item.source_id and status in ('open', 'in_progress', 'blocked_external');
    elsif p_action_code = 'resolve' then
      begin
        evidence_set_id := (p_decision_payload ->> 'evidenceSetId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'La brecha exige un conjunto de evidencia válido.';
      end;
      if evidence_set_id is null then
        raise exception using errcode = '22023', message = 'La brecha exige evidencia aprobada.';
      end if;
      update public.catalog_knowledge_gaps
      set status = 'resolved', resolved_evidence_set_id = evidence_set_id,
          decided_by = actor, resolved_at = now()
      where id = item.source_id and status in ('open', 'in_progress', 'blocked_external');
    else
      raise exception using errcode = '22023', message = 'La brecha solo admite resolver o descartar.';
    end if;

    if not found then
      raise exception using errcode = '40001', message = 'La brecha cambió antes de aplicar la decisión.';
    end if;
  elsif item.source_type <> 'manual' then
    raise exception using errcode = '22023', message = 'Este origen todavía no tiene un comando de decisión.';
  end if;

  update public.catalog_review_work_items
  set
    status = 'resolved',
    resolution_code = p_action_code,
    resolution_payload = coalesce(p_decision_payload, '{}'::jsonb),
    resolved_by = actor,
    resolved_at = now()
  where id = item.id
  returning * into decided_item;

  select full_name into actor_name
  from public.admin_profiles
  where id = actor;

  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id, actor_label,
    idempotency_key, request_fingerprint, prior_version, new_version,
    payload, evidence
  ) values (
    decided_item.id, decided_item.work_key, 'decision_taken', p_action_code,
    actor, actor_name, p_idempotency_key, request_fingerprint,
    item.row_version, decided_item.row_version,
    coalesce(p_decision_payload, '{}'::jsonb), coalesce(p_evidence, '[]'::jsonb)
  );

  with invalidated as (
    update public.catalog_review_work_items dependent
    set
      status = 'superseded',
      resolution_code = 'invalidated_by_dependency',
      resolution_payload = jsonb_build_object(
        'prerequisiteWorkItemId', decided_item.id,
        'prerequisiteResolutionCode', p_action_code
      ),
      resolved_at = now()
    from public.catalog_review_dependencies dependency
    where dependency.prerequisite_work_item_id = decided_item.id
      and dependency.dependent_work_item_id = dependent.id
      and dependency.dependency_type = 'invalidated_by'
      and dependent.status in ('open', 'in_progress')
      and (
        not (dependency.condition ? 'resolution_codes')
        or p_action_code in (
          select jsonb_array_elements_text(dependency.condition -> 'resolution_codes')
        )
      )
    returning dependent.*
  )
  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code, actor_id, actor_label,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
  )
  select
    invalidated.id, invalidated.work_key, 'decision_superseded',
    'invalidated_by_dependency', actor, actor_name,
    p_idempotency_key || ':invalidate:' || invalidated.id::text,
    md5(p_idempotency_key || ':invalidate:' || invalidated.id::text),
    invalidated.row_version - 1, invalidated.row_version,
    invalidated.resolution_payload
  from invalidated;
  get diagnostics invalidated_count = row_count;

  select count(*)::integer into unlocked_count
  from public.catalog_review_dependencies dependency
  join public.catalog_review_queue_v1 queue
    on queue.id = dependency.dependent_work_item_id
  where dependency.prerequisite_work_item_id = decided_item.id
    and queue.queue_state in ('reviewable', 'capture_required', 'waiting_external');

  return jsonb_build_object(
    'workItemId', decided_item.id,
    'workKey', decided_item.work_key,
    'status', decided_item.status,
    'rowVersion', decided_item.row_version,
    'unlockedCount', unlocked_count,
    'invalidatedCount', invalidated_count,
    'idempotentReplay', false
  );
end;
$function$;



create trigger catalog_review_work_items_touch
before update on public.catalog_review_work_items
for each row execute function public.touch_catalog_review_work_item();

create or replace function public.prevent_catalog_review_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'Los eventos de revisión son inmutables; registre un evento posterior.';
end;
$function$;

create trigger catalog_review_events_immutable
before update or delete on public.catalog_review_events
for each row execute function public.prevent_catalog_review_event_mutation();

create or replace function public.prevent_catalog_review_batch_item_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'El conjunto previsualizado es inmutable; genere una nueva previsualización.';
end;
$function$;

create trigger catalog_review_batch_items_immutable
before update or delete on public.catalog_review_batch_items
for each row execute function public.prevent_catalog_review_batch_item_mutation();

create or replace function public.prevent_catalog_review_dependency_cycle()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    with recursive reachable(work_item_id) as (
      select new.dependent_work_item_id
      union
      select dependency.dependent_work_item_id
      from public.catalog_review_dependencies dependency
      join reachable current
        on dependency.prerequisite_work_item_id = current.work_item_id
      where dependency.id <> coalesce(new.id, gen_random_uuid())
    )
    select 1
    from reachable
    where work_item_id = new.prerequisite_work_item_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'La dependencia crearía un ciclo permanente en la cola.';
  end if;

  return new;
end;
$function$;

create trigger catalog_review_dependencies_prevent_cycle
before insert or update on public.catalog_review_dependencies
for each row execute function public.prevent_catalog_review_dependency_cycle();

-- Ninguna de estas funciones de trigger es una RPC.
revoke execute on function public.touch_catalog_review_work_item() from public, anon, authenticated;
revoke execute on function public.prevent_catalog_review_event_mutation() from public, anon, authenticated;
revoke execute on function public.prevent_catalog_review_batch_item_mutation() from public, anon, authenticated;
revoke execute on function public.prevent_catalog_review_dependency_cycle() from public, anon, authenticated;

-- La vista resuelve bloqueos desde las dependencias. requires_all exige cada
-- antecedente; cada grupo requires_any exige al menos uno. invalidated_by no
-- bloquea: vuelve obsoleto el trabajo cuando se cumple su condición.
create or replace view public.catalog_review_queue_v1
with (security_invoker = true) as
select
  item.id,
  item.work_key,
  item.work_family_key,
  item.problem_version,
  item.source_type,
  item.source_id,
  item.work_kind,
  item.purpose,
  item.subject_type,
  item.subject_id,
  item.group_key,
  item.status,
  item.priority_tier,
  item.risk_level,
  item.has_contradiction,
  item.unlock_count,
  item.business_relevance,
  item.estimated_effort,
  item.question,
  item.recommendation,
  item.material_fingerprint,
  item.context,
  item.row_version,
  item.resolution_code,
  item.resolved_at,
  item.created_at,
  item.updated_at,
  blockers.blocked_by_count,
  invalidators.invalidated_by_count,
  case
    when item.status in ('resolved', 'superseded', 'cancelled') then item.status
    when invalidators.invalidated_by_count > 0 then 'superseded_pending'
    when blockers.blocked_by_count > 0 then 'blocked'
    when item.work_kind = 'capture' then 'capture_required'
    when item.work_kind = 'waiting_external' then 'waiting_external'
    else 'reviewable'
  end as queue_state,
  item.status in ('open', 'in_progress')
    and item.work_kind in ('decision', 'audit')
    and blockers.blocked_by_count = 0
    and invalidators.invalidated_by_count = 0 as can_resolve_now,
  case
    when item.risk_level = 'critical' then 0
    when item.has_contradiction then 1
    when item.risk_level = 'high' then 2
    when item.priority_tier = 'high' then 3
    when item.priority_tier = 'normal' then 4
    else 5
  end as priority_bucket,
  false as price_required
from public.catalog_review_work_items item
cross join lateral (
  select
    (
      select count(*)::integer
      from public.catalog_review_dependencies dependency
      join public.catalog_review_work_items prerequisite
        on prerequisite.id = dependency.prerequisite_work_item_id
      where dependency.dependent_work_item_id = item.id
        and dependency.dependency_type = 'requires_all'
        and not (
          prerequisite.status = 'resolved'
          and (
            not (dependency.condition ? 'resolution_codes')
            or prerequisite.resolution_code in (
              select jsonb_array_elements_text(dependency.condition -> 'resolution_codes')
            )
          )
        )
    )
    +
    (
      select count(*)::integer
      from (
        select dependency.group_key
        from public.catalog_review_dependencies dependency
        join public.catalog_review_work_items prerequisite
          on prerequisite.id = dependency.prerequisite_work_item_id
        where dependency.dependent_work_item_id = item.id
          and dependency.dependency_type = 'requires_any'
        group by dependency.group_key
        having not bool_or(
          prerequisite.status = 'resolved'
          and (
            not (dependency.condition ? 'resolution_codes')
            or prerequisite.resolution_code in (
              select jsonb_array_elements_text(dependency.condition -> 'resolution_codes')
            )
          )
        )
      ) unsatisfied_any_group
    ) as blocked_by_count
) blockers
cross join lateral (
  select count(*)::integer as invalidated_by_count
  from public.catalog_review_dependencies dependency
  join public.catalog_review_work_items prerequisite
    on prerequisite.id = dependency.prerequisite_work_item_id
  where dependency.dependent_work_item_id = item.id
    and dependency.dependency_type = 'invalidated_by'
    and prerequisite.status = 'resolved'
    and (
      not (dependency.condition ? 'resolution_codes')
      or prerequisite.resolution_code in (
        select jsonb_array_elements_text(dependency.condition -> 'resolution_codes')
      )
    )
) invalidators;

create or replace view public.catalog_review_summary_v1
with (security_invoker = true) as
select
  count(*) filter (where queue_state = 'reviewable')::bigint as reviewable_count,
  count(*) filter (where queue_state = 'capture_required')::bigint as capture_count,
  count(*) filter (where queue_state = 'waiting_external')::bigint as waiting_count,
  count(*) filter (where status = 'resolved')::bigint as completed_count,
  count(*) filter (where queue_state = 'blocked')::bigint as blocked_count,
  coalesce(sum(unlock_count) filter (where queue_state = 'reviewable'), 0)::bigint
    as reviewable_unlock_count
from public.catalog_review_queue_v1;

-- El registrador usa un advisory lock por familia. Dos corridas concurrentes
-- no pueden crear simultáneamente v1. La misma huella devuelve la misma fila;
-- una huella materialmente distinta crea la versión siguiente y preserva la
-- historia anterior.
create or replace function public.register_catalog_review_work_item_v1(
  p_work_family_key text,
  p_source_type text,
  p_source_id uuid,
  p_work_kind text,
  p_purpose text,
  p_subject_type text,
  p_subject_id uuid,
  p_material_fingerprint text,
  p_question text,
  p_recommendation text default null,
  p_group_key text default null,
  p_priority_tier text default 'normal',
  p_risk_level text default 'normal',
  p_has_contradiction boolean default false,
  p_unlock_count integer default 0,
  p_business_relevance numeric default 0,
  p_estimated_effort smallint default 1,
  p_context jsonb default '{}'::jsonb
)
returns public.catalog_review_work_items
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_item public.catalog_review_work_items%rowtype;
  registered_item public.catalog_review_work_items%rowtype;
  next_problem_version integer := 1;
  superseded_item public.catalog_review_work_items%rowtype;
begin
  if nullif(trim(coalesce(p_work_family_key, '')), '') is null
     or p_work_family_key !~ '^[a-z0-9][a-z0-9:_-]*$' then
    raise exception using errcode = '22023', message = 'La familia de trabajo no es válida.';
  end if;

  if nullif(trim(coalesce(p_material_fingerprint, '')), '') is null then
    raise exception using errcode = '22023', message = 'El trabajo exige una huella material.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_work_family_key, 0));

  select * into current_item
  from public.catalog_review_work_items item
  where item.work_family_key = p_work_family_key
  order by item.problem_version desc
  limit 1
  for update;

  if found and current_item.material_fingerprint = p_material_fingerprint then
    return current_item;
  end if;

  if found then
    next_problem_version := current_item.problem_version + 1;

    if current_item.status in ('open', 'in_progress') then
      update public.catalog_review_work_items
      set
        status = 'superseded',
        resolution_code = 'material_evidence_changed',
        resolution_payload = jsonb_build_object(
          'nextFingerprint', p_material_fingerprint,
          'reason', 'Nueva evidencia cambió materialmente el problema.'
        ),
        resolved_at = now()
      where id = current_item.id
      returning * into superseded_item;

      insert into public.catalog_review_events(
        work_item_id, work_key, event_type, action_code,
        idempotency_key, request_fingerprint, prior_version, new_version,
        payload
      ) values (
        superseded_item.id, superseded_item.work_key, 'work_superseded',
        'material_evidence_changed',
        'system:work-superseded:' || superseded_item.id::text || ':' || p_material_fingerprint,
        md5('material_evidence_changed:' || p_material_fingerprint),
        superseded_item.row_version - 1, superseded_item.row_version,
        superseded_item.resolution_payload
      ) on conflict (idempotency_key) do nothing;
    end if;
  end if;

  insert into public.catalog_review_work_items(
    work_family_key, problem_version, source_type, source_id,
    work_kind, purpose, subject_type, subject_id, group_key,
    priority_tier, risk_level, has_contradiction, unlock_count,
    business_relevance, estimated_effort, question, recommendation,
    material_fingerprint, context, supersedes_work_item_id
  ) values (
    p_work_family_key, next_problem_version, p_source_type, p_source_id,
    p_work_kind, p_purpose, p_subject_type, p_subject_id, p_group_key,
    p_priority_tier, p_risk_level, p_has_contradiction, p_unlock_count,
    p_business_relevance, p_estimated_effort, p_question, p_recommendation,
    p_material_fingerprint, coalesce(p_context, '{}'::jsonb),
    case when current_item.id is not null then current_item.id end
  )
  returning * into registered_item;

  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code,
    idempotency_key, request_fingerprint, prior_version, new_version,
    payload
  ) values (
    registered_item.id, registered_item.work_key, 'work_created', 'registered',
    'system:work-created:' || registered_item.id::text,
    md5('work-created:' || registered_item.work_key || ':' || registered_item.material_fingerprint),
    null, registered_item.row_version,
    jsonb_build_object(
      'sourceType', registered_item.source_type,
      'sourceId', registered_item.source_id,
      'workKind', registered_item.work_kind,
      'purpose', registered_item.purpose
    )
  );

  return registered_item;
end;
$function$;

alter table public.catalog_review_work_items enable row level security;
alter table public.catalog_review_dependencies enable row level security;
alter table public.catalog_review_events enable row level security;
alter table public.catalog_review_batches enable row level security;
alter table public.catalog_review_batch_items enable row level security;

create policy "admins read catalog review work" on public.catalog_review_work_items
for select to authenticated using (public.is_admin());
create policy "admins read catalog review dependencies" on public.catalog_review_dependencies
for select to authenticated using (public.is_admin());
create policy "admins read catalog review events" on public.catalog_review_events
for select to authenticated using (public.is_admin());
create policy "admins read catalog review batches" on public.catalog_review_batches
for select to authenticated using (public.is_admin());
create policy "admins read catalog review batch items" on public.catalog_review_batch_items
for select to authenticated using (public.is_admin());

grant select on
  public.catalog_review_work_items,
  public.catalog_review_dependencies,
  public.catalog_review_events,
  public.catalog_review_batches,
  public.catalog_review_batch_items,
  public.catalog_review_queue_v1,
  public.catalog_review_summary_v1
to authenticated, service_role;

grant insert, update, delete on
  public.catalog_review_work_items,
  public.catalog_review_dependencies,
  public.catalog_review_batches,
  public.catalog_review_batch_items
to service_role;

grant insert on public.catalog_review_events to service_role;
grant usage, select on sequence public.catalog_review_events_id_seq to service_role;

revoke all on function public.register_catalog_review_work_item_v1(
  text, text, uuid, text, text, text, uuid, text, text, text, text,
  text, text, boolean, integer, numeric, smallint, jsonb
) from public, anon, authenticated;
grant execute on function public.register_catalog_review_work_item_v1(
  text, text, uuid, text, text, text, uuid, text, text, text, text,
  text, text, boolean, integer, numeric, smallint, jsonb
) to service_role;

revoke all on function public.sync_catalog_review_work_items_v1()
from public, anon, authenticated;
grant execute on function public.sync_catalog_review_work_items_v1()
to service_role;

revoke all on function public.resolve_catalog_review_item_v1(
  uuid, bigint, text, jsonb, jsonb, text, uuid
) from public, anon;
grant execute on function public.resolve_catalog_review_item_v1(
  uuid, bigint, text, jsonb, jsonb, text, uuid
) to authenticated, service_role;

revoke all on function public.preview_catalog_review_batch_v1(
  text, text, jsonb, text, uuid
) from public, anon;
grant execute on function public.preview_catalog_review_batch_v1(
  text, text, jsonb, text, uuid
) to authenticated, service_role;

revoke all on function public.apply_catalog_review_batch_v1(
  uuid, text, text, uuid
) from public, anon;
grant execute on function public.apply_catalog_review_batch_v1(
  uuid, text, text, uuid
) to authenticated, service_role;

comment on table public.catalog_review_work_items is
  'Estado operativo materializado de la Mesa de revisión. Coordina trabajo y nunca reemplaza la verdad canónica.';
comment on column public.catalog_review_work_items.work_key is
  'Identidad determinista: familia origen+entidad+propósito y versión material del problema.';
comment on table public.catalog_review_dependencies is
  'Dependencias semánticas requires_all, requires_any e invalidated_by, protegidas contra ciclos.';
comment on table public.catalog_review_events is
  'Historia inmutable de la revisión. Audita cambios, pero el estado vigente continúa materializado.';
comment on table public.catalog_review_batches is
  'Previsualización congelada de una decisión masiva; aplicar exige el mismo conjunto y versiones.';
comment on view public.catalog_review_queue_v1 is
  'Contrato estable administrativo de lectura. Automático no es un work_kind y nunca entra a la cola humana.';
comment on function public.resolve_catalog_review_item_v1(uuid, bigint, text, jsonb, jsonb, text, uuid) is
  'Comando administrativo transaccional con expected_version e idempotency_key; React no coordina escrituras múltiples.';

-- Convierte el estado existente en trabajo desde la propia migración. En una
-- base vacía devuelve cero; después de cada staging el script vuelve a llamar
-- el mismo contrato idempotente.
select public.sync_catalog_review_work_items_v1();

commit;
