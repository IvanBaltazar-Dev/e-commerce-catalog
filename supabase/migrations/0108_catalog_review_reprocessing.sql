-- ---------------------------------------------------------------------------
-- 0108 · Etapa 3: reprocesamiento global de la Mesa como cola de excepciones
-- ---------------------------------------------------------------------------
-- El preview es inmutable y apply exige exactamente el fingerprint observado.
-- Las reglas automáticas solo cierran incertidumbre objetiva; jamás publican,
-- crean artículos comerciales ni reescriben decisiones históricas.

begin;

alter table public.catalog_review_work_items
  add column handling_class text not null default 'human_exception';

alter table public.catalog_review_work_items
  add constraint catalog_review_handling_class_allowed check (handling_class in (
    'human_exception', 'automatic_debt', 'physical_capture', 'waiting_external'
  ));

update public.catalog_review_work_items
set handling_class = case work_kind
  when 'capture' then 'physical_capture'
  when 'waiting_external' then 'waiting_external'
  else 'human_exception'
end;

create index catalog_review_work_handling_idx
  on public.catalog_review_work_items(handling_class, status, purpose);

create or replace function public.default_catalog_review_handling_class()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.handling_class = 'human_exception' then
    new.handling_class := case new.work_kind
      when 'capture' then 'physical_capture'
      when 'waiting_external' then 'waiting_external'
      else 'human_exception'
    end;
  end if;
  return new;
end;
$function$;

create trigger catalog_review_work_items_default_handling
before insert on public.catalog_review_work_items
for each row execute function public.default_catalog_review_handling_class();

-- El origen operativo también se bloquea. Si un productor heredado calcula
-- otra familia para el mismo source, conserva el trabajo activo ya registrado;
-- la evidencia material de ese origen continúa bajo el productor que lo creó.
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
  active_source_item public.catalog_review_work_items%rowtype;
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
  if p_source_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      p_source_type || ':' || p_source_id::text, 0
    ));
  end if;

  select * into current_item
  from public.catalog_review_work_items item
  where item.work_family_key = p_work_family_key
  order by item.problem_version desc
  limit 1
  for update;

  if p_source_id is not null then
    select * into active_source_item
    from public.catalog_review_work_items item
    where item.source_type = p_source_type
      and item.source_id = p_source_id
      and item.status in ('open', 'in_progress')
    order by item.problem_version desc, item.created_at desc
    limit 1
    for update;
    if found and (current_item.id is null or active_source_item.id <> current_item.id) then
      return active_source_item;
    end if;
  end if;

  if current_item.id is not null
     and current_item.material_fingerprint = p_material_fingerprint then
    return current_item;
  end if;

  if current_item.id is not null then
    next_problem_version := current_item.problem_version + 1;
    if current_item.status in ('open', 'in_progress') then
      update public.catalog_review_work_items
      set status = 'superseded',
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
        idempotency_key, request_fingerprint, prior_version, new_version, payload
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
  ) returning * into registered_item;

  insert into public.catalog_review_events(
    work_item_id, work_key, event_type, action_code,
    idempotency_key, request_fingerprint, prior_version, new_version, payload
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

-- Una corrección de alcance puede superseder el trabajo de identidad de
-- producto y crear el trabajo exacto de variante. El proyector anterior aún
-- usaba ese trabajo superseded como prerequisito y bloqueaba el reemplazo.
-- Se conserva el mismo contrato, excluyendo terminales que ya no pueden
-- satisfacer la condición de aprobación.
create or replace function public.refresh_catalog_review_dependencies_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  projected_count integer := 0;
  changed_priorities integer := 0;
begin
  delete from public.catalog_review_dependencies
  where origin = 'projection';

  with dependent_products as (
    select item.id as dependent_id, item.subject_id as product_id
    from public.catalog_review_work_items item
    where item.subject_type = 'product'
      and item.subject_id is not null
      and item.status in ('open', 'in_progress')
      and not (item.purpose = 'identity' and item.source_type = 'reconciliation_case')

    union

    select item.id, variant.product_id
    from public.catalog_review_work_items item
    join public.product_variants variant on variant.id = item.subject_id
    where item.subject_type = 'variant'
      and item.status in ('open', 'in_progress')

    union

    select item.id, variant.product_id
    from public.catalog_review_work_items item
    join public.product_variants variant on variant.color_shade_id = item.subject_id
    where item.subject_type = 'shade'
      and item.status in ('open', 'in_progress')

    union

    select item.id, candidate.source_product_id
    from public.catalog_review_work_items item
    join public.catalog_relation_candidates candidate
      on item.source_type = 'relation_candidate' and item.source_id = candidate.id
    where item.status in ('open', 'in_progress')

    union

    select item.id, candidate.target_product_id
    from public.catalog_review_work_items item
    join public.catalog_relation_candidates candidate
      on item.source_type = 'relation_candidate' and item.source_id = candidate.id
    where item.status in ('open', 'in_progress')
  ), identity_prerequisites as (
    select item.id as prerequisite_id, item.subject_id as product_id
    from public.catalog_review_work_items item
    where item.source_type = 'reconciliation_case'
      and item.purpose = 'identity'
      and item.subject_type = 'product'
      and item.status not in ('superseded', 'cancelled')
  )
  insert into public.catalog_review_dependencies(
    dependent_work_item_id, prerequisite_work_item_id,
    dependency_type, group_key, condition, origin
  )
  select
    dependent.dependent_id,
    prerequisite.prerequisite_id,
    'requires_any',
    'product-identity:' || dependent.product_id::text,
    '{"resolution_codes":["approve","approved"]}'::jsonb,
    'projection'
  from dependent_products dependent
  join identity_prerequisites prerequisite
    on prerequisite.product_id = dependent.product_id
  where dependent.dependent_id <> prerequisite.prerequisite_id
  on conflict (dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key)
  do nothing;

  get diagnostics projected_count = row_count;

  with impact as (
    select prerequisite.id,
      count(distinct dependency.dependent_work_item_id)::integer as unlock_count
    from public.catalog_review_work_items prerequisite
    left join public.catalog_review_dependencies dependency
      on dependency.prerequisite_work_item_id = prerequisite.id
     and dependency.origin = 'projection'
    where prerequisite.source_type = 'reconciliation_case'
      and prerequisite.purpose = 'identity'
      and prerequisite.subject_type = 'product'
    group by prerequisite.id
  )
  update public.catalog_review_work_items item
  set unlock_count = impact.unlock_count
  from impact
  where item.id = impact.id
    and item.unlock_count is distinct from impact.unlock_count;

  get diagnostics changed_priorities = row_count;

  return jsonb_build_object(
    'projectedDependencies', projected_count,
    'identityImpactsUpdated', changed_priorities,
    'blockedWorkItems', (
      select count(*) from public.catalog_review_queue_v1 where queue_state = 'blocked'
    )
  );
end;
$function$;

alter table public.catalog_review_events
  drop constraint catalog_review_event_type_allowed;

alter table public.catalog_review_events
  add constraint catalog_review_event_type_allowed check (event_type in (
    'work_created', 'work_superseded', 'work_started', 'work_deferred',
    'work_resumed', 'decision_taken', 'decision_superseded',
    'source_status_synchronized', 'work_reclassified', 'work_auto_resolved',
    'historical_contradiction_detected'
  ));

create table public.catalog_review_reprocess_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'previewed',
  engine_version text not null default 'stage3-v1',
  snapshot_fingerprint text not null,
  preview_fingerprint text,
  logical_fingerprint text,
  preview_idempotency_key text not null unique,
  application_idempotency_key text unique,
  metrics_before jsonb not null default '{}'::jsonb,
  metrics_after jsonb,
  action_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint catalog_review_reprocess_status_allowed check (
    status in ('previewed', 'applied', 'expired', 'cancelled')
  ),
  constraint catalog_review_reprocess_fingerprints_not_blank check (
    length(snapshot_fingerprint) = 64
    and (preview_fingerprint is null or length(preview_fingerprint) = 64)
    and (logical_fingerprint is null or length(logical_fingerprint) = 64)
  ),
  constraint catalog_review_reprocess_metrics_objects check (
    jsonb_typeof(metrics_before) = 'object'
    and (metrics_after is null or jsonb_typeof(metrics_after) = 'object')
    and jsonb_typeof(action_counts) = 'object'
  ),
  constraint catalog_review_reprocess_application_consistent check (
    (status = 'applied' and application_idempotency_key is not null and applied_at is not null and metrics_after is not null)
    or (status <> 'applied' and applied_at is null)
  )
);

create table public.catalog_review_reprocess_items (
  id bigint generated always as identity primary key,
  reprocess_run_id uuid not null references public.catalog_review_reprocess_runs(id) on delete restrict,
  work_item_id uuid not null references public.catalog_review_work_items(id) on delete restrict,
  work_key text not null,
  expected_row_version bigint not null,
  previous_queue_state text not null,
  planned_action text not null,
  rule_code text not null,
  target_status text not null,
  target_handling_class text not null,
  target_resolution_code text,
  generated_work_family_key text,
  evidence_fingerprint text not null,
  planned_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (reprocess_run_id, work_item_id),
  constraint catalog_review_reprocess_action_allowed check (planned_action in (
    'keep', 'audit_completed', 'reclassify', 'auto_resolve', 'supersede',
    'new_historical_contradiction'
  )),
  constraint catalog_review_reprocess_target_handling_allowed check (
    target_handling_class in (
      'human_exception', 'automatic_debt', 'physical_capture', 'waiting_external'
    )
  ),
  constraint catalog_review_reprocess_item_payload_object check (
    jsonb_typeof(planned_payload) = 'object'
  ),
  constraint catalog_review_reprocess_item_fingerprint_not_blank check (
    length(evidence_fingerprint) = 64
  )
);

create index catalog_review_reprocess_items_action_idx
  on public.catalog_review_reprocess_items(reprocess_run_id, planned_action, rule_code);

create or replace function public.prevent_catalog_review_reprocess_item_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'El preview de reprocesamiento es inmutable; genere otra fotografía.';
end;
$function$;

create trigger catalog_review_reprocess_items_immutable
before update or delete on public.catalog_review_reprocess_items
for each row execute function public.prevent_catalog_review_reprocess_item_mutation();

-- Conserva las columnas históricas en el mismo orden y agrega clasificación
-- al final para no romper consumidores de la vista.
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
    when item.handling_class = 'automatic_debt' then 'automatic_debt'
    when blockers.blocked_by_count > 0 then 'blocked'
    when item.handling_class = 'physical_capture' then 'capture_required'
    when item.handling_class = 'waiting_external' then 'waiting_external'
    else 'reviewable'
  end as queue_state,
  item.status in ('open', 'in_progress')
    and item.handling_class = 'human_exception'
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
  false as price_required,
  item.handling_class,
  item.status in ('open', 'in_progress')
    and item.handling_class = 'human_exception'
    and blockers.blocked_by_count = 0
    and invalidators.invalidated_by_count = 0 as human_actionable
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

create or replace view public.catalog_review_operational_queue_v1
with (security_invoker = true) as
select
  queue.id, queue.work_key, queue.work_family_key, queue.problem_version,
  queue.source_type, queue.source_id, queue.work_kind, queue.purpose,
  queue.subject_type, queue.subject_id, queue.group_key, queue.status,
  queue.priority_tier, queue.risk_level, queue.has_contradiction,
  queue.unlock_count, queue.business_relevance, queue.estimated_effort,
  queue.question, queue.recommendation, queue.material_fingerprint,
  queue.context, queue.row_version, queue.resolution_code, queue.resolved_at,
  queue.created_at, queue.updated_at, queue.blocked_by_count,
  queue.invalidated_by_count, queue.queue_state, queue.can_resolve_now,
  queue.priority_bucket, queue.price_required,
  item.assigned_to,
  item.started_at,
  item.deferred_until,
  item.defer_reason,
  item.deferred_until is not null and item.deferred_until > now() as is_deferred,
  queue.handling_class,
  queue.human_actionable
from public.catalog_review_queue_v1 queue
join public.catalog_review_work_items item on item.id = queue.id;

create or replace view public.catalog_review_summary_v1
with (security_invoker = true) as
select
  count(*) filter (where queue_state = 'reviewable' and not is_deferred)::bigint as reviewable_count,
  count(*) filter (where queue_state = 'capture_required' and not is_deferred)::bigint as capture_count,
  count(*) filter (where queue_state = 'waiting_external' and not is_deferred)::bigint as waiting_count,
  count(*) filter (where status = 'resolved')::bigint as completed_count,
  count(*) filter (where queue_state = 'blocked')::bigint as blocked_count,
  coalesce(sum(unlock_count) filter (
    where queue_state = 'reviewable' and not is_deferred
  ), 0)::bigint as reviewable_unlock_count,
  count(*) filter (where queue_state = 'automatic_debt')::bigint as automatic_debt_count,
  case
    when count(*) filter (where status in ('open', 'in_progress')) = 0 then 0::numeric
    else round(
      (count(*) filter (where queue_state = 'reviewable' and not is_deferred))::numeric
      / (count(*) filter (where status in ('open', 'in_progress')))::numeric,
      4
    )
  end as human_share_of_active
from public.catalog_review_operational_queue_v1;

create or replace function public.catalog_review_reprocess_metrics_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with metrics as (
    select
      count(*)::integer as total_work,
      count(*) filter (where queue.queue_state = 'reviewable' and not queue.is_deferred)::integer as human_actionable,
      count(*) filter (where queue.queue_state = 'automatic_debt')::integer as automatic_debt,
      count(*) filter (where queue.queue_state = 'capture_required')::integer as physical_capture,
      count(*) filter (where queue.queue_state = 'waiting_external')::integer as waiting_external,
      count(*) filter (where queue.queue_state = 'blocked')::integer as blocked,
      count(*) filter (where queue.status = 'resolved')::integer as completed,
      count(*) filter (where queue.status = 'superseded')::integer as superseded,
      count(*) filter (
        where queue.status in ('open', 'in_progress')
          and queue.context->>'reprocessOrigin' = 'historical_contradiction'
      )::integer as historical_contradictions,
      count(*) filter (where queue.status in ('open', 'in_progress'))::integer as active_work
    from public.catalog_review_operational_queue_v1 queue
  )
  select jsonb_build_object(
    'totalWork', total_work,
    'humanActionable', human_actionable,
    'automaticDebt', automatic_debt,
    'physicalCapture', physical_capture,
    'waitingExternal', waiting_external,
    'blocked', blocked,
    'completed', completed,
    'superseded', superseded,
    'historicalContradictions', historical_contradictions,
    'activeWork', active_work,
    'humanShareOfActive', case when active_work = 0 then 0
      else round(human_actionable::numeric / active_work, 4) end
  )
  from metrics;
$function$;

create or replace function public.catalog_review_reprocess_state_fingerprint_v1()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'work', coalesce((
      select jsonb_agg(jsonb_build_array(
        item.id, item.work_key, item.row_version, item.status, item.work_kind,
        item.handling_class, item.purpose, item.material_fingerprint,
        item.resolution_code, item.resolution_payload
      ) order by item.work_key)
      from public.catalog_review_work_items item
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(jsonb_build_array(
        dependency.dependent_work_item_id, dependency.prerequisite_work_item_id,
        dependency.dependency_type, dependency.group_key, dependency.condition
      ) order by dependency.dependent_work_item_id, dependency.prerequisite_work_item_id,
                 dependency.dependency_type, dependency.group_key)
      from public.catalog_review_dependencies dependency
    ), '[]'::jsonb),
    'reconciliations', coalesce((
      select jsonb_agg(jsonb_build_array(
        reconciliation.id, reconciliation.status, reconciliation.score,
        reconciliation.algorithm, reconciliation.evidence
      ) order by reconciliation.id)
      from public.catalog_reconciliation_cases reconciliation
    ), '[]'::jsonb),
    'exceptions', coalesce((
      select jsonb_agg(jsonb_build_array(
        exception.id, exception.status, exception.exception_type, exception.details
      ) order by exception.id)
      from public.catalog_enrichment_exceptions exception
    ), '[]'::jsonb),
    'gaps', coalesce((
      select jsonb_agg(jsonb_build_array(
        gap.id, gap.status, gap.resolved_evidence_set_id, gap.metadata
      ) order by gap.id)
      from public.catalog_knowledge_gaps gap
    ), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_array(
        evidence.id, evidence.decision_status, evidence.confidence, evidence.metadata
      ) order by evidence.id)
      from public.catalog_evidence_sets evidence
    ), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex');
$function$;

-- Una sola vista expresa las reglas aprobadas. No contiene marcas, productos,
-- SKUs ni nombres particulares.
create or replace view public.catalog_review_reprocess_plan_v1
with (security_invoker = true) as
with classified as (
  select
    item.*,
    queue.queue_state as previous_queue_state,
    reconciliation.status as reconciliation_status,
    reconciliation.algorithm,
    reconciliation.score,
    reconciliation.evidence as reconciliation_evidence,
    exception.status as exception_status,
    gap.status as gap_status,
    case
      when item.source_type = 'reconciliation_case'
        and item.status = 'resolved'
        and reconciliation.status = 'approved'
        and coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'historical_contradiction'
      when item.source_type = 'reconciliation_case'
        and reconciliation.status = 'superseded'
        then 'source_superseded'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'exact_normalized_tone_or_official_code_v1'
        and reconciliation.score = 1
        and public.search_normalize(reconciliation.evidence->>'internal_tone') =
            public.search_normalize(reconciliation.evidence->>'official_tone')
        and reconciliation.evidence->>'official_url' ~ '^https?://'
        then 'objective_tone_identity'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'official_product_name_and_code_v1'
        and reconciliation.score = 1
        and not coalesce((reconciliation.evidence->>'ambiguous')::boolean, false)
        and reconciliation.evidence->>'source_match_status' = 'CONFIRMADO_OFICIAL'
        and reconciliation.evidence->>'official_url' ~ '^https?://'
        then 'objective_product_identity'
      when item.handling_class = 'physical_capture'
        and coalesce((item.context->>'officialEvidenceSatisfiesPhysicalCapture')::boolean, false)
        and exists (
          select 1 from public.catalog_evidence_sets evidence
          where evidence.id::text = item.context->>'evidenceSetId'
            and evidence.decision_status = 'approved'
            and evidence.evidence_type in ('official_sources', 'physical_packaging')
        )
        then 'official_evidence_resolves_capture'
      when item.handling_class = 'waiting_external'
        and coalesce((item.context->>'externalDependencySatisfied')::boolean, false)
        and exists (
          select 1 from public.catalog_evidence_sets evidence
          where evidence.id::text = item.context->>'evidenceSetId'
            and evidence.decision_status = 'approved'
        )
        then 'approved_evidence_resolves_wait'
      when item.source_type = 'relation_candidate'
        then 'relation_deferred_stage4'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'official_identity_v1'
        and reconciliation.status = 'proposed'
        and not coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'external_candidate_signal'
      when item.status in ('open', 'in_progress')
        and item.purpose = 'image'
        and not item.has_contradiction
        and not coalesce((item.context->>'requiresOwnPhotography')::boolean, false)
        and coalesce(item.context->'details'->>'source_exception_type', '') <> 'REQUIERE_FOTOGRAFIA_PROPIA'
        and coalesce(item.context->'details'->>'required_action', '') not in (
          'INCLUIR_EN_SESION_FOTOGRAFICA', 'FOTOGRAFIAR_FRENTE_REVERSO_CODIGO_Y_MEDIDAS'
        )
        then 'image_automatic_debt'
      else 'unchanged'
    end as rule_code
  from public.catalog_review_work_items item
  join public.catalog_review_queue_v1 queue on queue.id = item.id
  left join public.catalog_reconciliation_cases reconciliation
    on item.source_type = 'reconciliation_case' and reconciliation.id = item.source_id
  left join public.catalog_enrichment_exceptions exception
    on item.source_type = 'enrichment_exception' and exception.id = item.source_id
  left join public.catalog_knowledge_gaps gap
    on item.source_type = 'knowledge_gap' and gap.id = item.source_id
), desired as (
  select
    classified.*,
    case
      when rule_code in (
        'objective_tone_identity', 'objective_product_identity',
        'official_evidence_resolves_capture', 'approved_evidence_resolves_wait'
      ) then 'resolved'
      when rule_code = 'source_superseded' then 'superseded'
      else status
    end as target_status,
    case
      when rule_code in ('relation_deferred_stage4', 'external_candidate_signal', 'image_automatic_debt')
        then 'automatic_debt'
      else handling_class
    end as target_handling_class,
    case rule_code
      when 'objective_tone_identity' then 'auto_verified_identity'
      when 'objective_product_identity' then 'auto_verified_identity'
      when 'official_evidence_resolves_capture' then 'official_evidence_satisfied'
      when 'approved_evidence_resolves_wait' then 'external_evidence_satisfied'
      when 'source_superseded' then 'source_signal_superseded'
      else resolution_code
    end as target_resolution_code,
    case when rule_code = 'historical_contradiction' then
      'historical-contradiction:' || id::text || ':' || substr(md5(reconciliation_evidence::text), 1, 16)
    end as generated_work_family_key
  from classified
)
select
  desired.id as work_item_id,
  desired.work_key,
  desired.row_version as expected_row_version,
  desired.previous_queue_state,
  case
    when desired.rule_code = 'historical_contradiction' and not exists (
      select 1 from public.catalog_review_work_items existing
      where existing.work_family_key = desired.generated_work_family_key
    ) then 'new_historical_contradiction'
    when desired.status in ('resolved', 'superseded', 'cancelled') then 'audit_completed'
    when desired.target_status = 'resolved' then 'auto_resolve'
    when desired.target_status = 'superseded' then 'supersede'
    when desired.target_handling_class <> desired.handling_class then 'reclassify'
    else 'keep'
  end as planned_action,
  desired.rule_code,
  desired.target_status,
  desired.target_handling_class,
  desired.target_resolution_code,
  desired.generated_work_family_key,
  encode(extensions.digest(convert_to(jsonb_build_object(
    'workKey', desired.work_key,
    'rule', desired.rule_code,
    'targetStatus', desired.target_status,
    'targetHandlingClass', desired.target_handling_class,
    'targetResolutionCode', desired.target_resolution_code,
    'sourceStatus', coalesce(desired.reconciliation_status, desired.exception_status, desired.gap_status),
    'evidence', desired.reconciliation_evidence,
    'context', desired.context
  )::text, 'UTF8'), 'sha256'), 'hex') as evidence_fingerprint,
  jsonb_strip_nulls(jsonb_build_object(
    'previousStatus', desired.status,
    'previousHandlingClass', desired.handling_class,
    'previousQueueState', desired.previous_queue_state,
    'sourceType', desired.source_type,
    'sourceId', desired.source_id,
    'purpose', desired.purpose,
    'subjectType', desired.subject_type,
    'subjectId', desired.subject_id,
    'groupKey', desired.group_key,
    'question', desired.question,
    'recommendation', desired.recommendation,
    'hasContradiction', desired.has_contradiction,
    'historicalEvidence', desired.reconciliation_evidence
  )) as planned_payload
from desired;

create or replace function public.preview_catalog_review_reprocess_v1(
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing public.catalog_review_reprocess_runs%rowtype;
  created public.catalog_review_reprocess_runs%rowtype;
  snapshot_hash text;
  preview_hash text;
  logical_hash text;
  counts jsonb;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'El preview exige una clave idempotente.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('catalog-review-reprocess-v1', 0));

  select * into existing
  from public.catalog_review_reprocess_runs run
  where run.preview_idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'previewId', existing.id,
      'status', existing.status,
      'snapshotFingerprint', existing.snapshot_fingerprint,
      'previewFingerprint', existing.preview_fingerprint,
      'logicalFingerprint', existing.logical_fingerprint,
      'metricsBefore', existing.metrics_before,
      'actionCounts', existing.action_counts,
      'idempotentReplay', true
    );
  end if;

  snapshot_hash := public.catalog_review_reprocess_state_fingerprint_v1();
  insert into public.catalog_review_reprocess_runs(
    snapshot_fingerprint, preview_idempotency_key, metrics_before
  ) values (
    snapshot_hash, p_idempotency_key, public.catalog_review_reprocess_metrics_v1()
  ) returning * into created;

  insert into public.catalog_review_reprocess_items(
    reprocess_run_id, work_item_id, work_key, expected_row_version,
    previous_queue_state, planned_action, rule_code, target_status,
    target_handling_class, target_resolution_code, generated_work_family_key,
    evidence_fingerprint, planned_payload
  )
  select
    created.id, plan.work_item_id, plan.work_key, plan.expected_row_version,
    plan.previous_queue_state, plan.planned_action, plan.rule_code, plan.target_status,
    plan.target_handling_class, plan.target_resolution_code,
    plan.generated_work_family_key, plan.evidence_fingerprint, plan.planned_payload
  from public.catalog_review_reprocess_plan_v1 plan
  order by plan.work_key;

  select encode(extensions.digest(convert_to(coalesce(string_agg(
    concat_ws('|', item.work_key, item.expected_row_version, item.planned_action,
      item.rule_code, item.target_status, item.target_handling_class,
      item.evidence_fingerprint), E'\n' order by item.work_key
  ), ''), 'UTF8'), 'sha256'), 'hex')
  into preview_hash
  from public.catalog_review_reprocess_items item
  where item.reprocess_run_id = created.id;

  -- Excluye trabajos generados por una contradicción anterior y representa el
  -- destino lógico desde la decisión histórica que los originó. Así, aplicar
  -- y volver a ejecutar conserva la misma huella lógica.
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    concat_ws('|', item.work_key, item.rule_code, item.target_status,
      item.target_handling_class, item.target_resolution_code,
      coalesce(item.generated_work_family_key, '')), E'\n' order by item.work_key
  ) filter (where item.planned_payload->>'sourceType' <> 'manual'
      or item.work_key not like 'historical-contradiction:%'), ''), 'UTF8'), 'sha256'), 'hex')
  into logical_hash
  from public.catalog_review_reprocess_items item
  where item.reprocess_run_id = created.id;

  select coalesce(jsonb_object_agg(planned_action, total), '{}'::jsonb)
  into counts
  from (
    select planned_action, count(*)::integer as total
    from public.catalog_review_reprocess_items
    where reprocess_run_id = created.id
    group by planned_action
  ) grouped;

  update public.catalog_review_reprocess_runs
  set preview_fingerprint = preview_hash,
      logical_fingerprint = logical_hash,
      action_counts = counts
  where id = created.id
  returning * into created;

  return jsonb_build_object(
    'previewId', created.id,
    'status', created.status,
    'snapshotFingerprint', created.snapshot_fingerprint,
    'previewFingerprint', created.preview_fingerprint,
    'logicalFingerprint', created.logical_fingerprint,
    'metricsBefore', created.metrics_before,
    'actionCounts', created.action_counts,
    'idempotentReplay', false
  );
end;
$function$;

create or replace function public.apply_catalog_review_reprocess_v1(
  p_preview_id uuid,
  p_preview_fingerprint text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run public.catalog_review_reprocess_runs%rowtype;
  planned record;
  changed public.catalog_review_work_items%rowtype;
  generated public.catalog_review_work_items%rowtype;
  current_snapshot text;
  before_metrics jsonb;
  after_metrics jsonb;
  changed_count integer := 0;
  new_count integer := 0;
  historical_count integer := 0;
  unblocked_count integer := 0;
  events_before bigint;
  events_after bigint;
begin
  if p_preview_id is null or nullif(trim(coalesce(p_preview_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'Apply exige preview, huella y clave idempotente.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('catalog-review-reprocess-v1', 0));
  select * into run
  from public.catalog_review_reprocess_runs current_run
  where current_run.id = p_preview_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'El preview no existe.';
  end if;
  if run.preview_fingerprint <> p_preview_fingerprint then
    raise exception using errcode = '40001', message = 'La huella no corresponde al preview congelado.';
  end if;
  if run.status = 'applied' then
    if run.application_idempotency_key <> p_idempotency_key then
      raise exception using errcode = '23505', message = 'El preview ya fue aplicado con otra clave.';
    end if;
    return jsonb_build_object(
      'previewId', run.id,
      'status', run.status,
      'logicalFingerprint', run.logical_fingerprint,
      'metricsBefore', run.metrics_before,
      'metricsAfter', run.metrics_after,
      'actionCounts', run.action_counts,
      'idempotentReplay', true
    );
  end if;
  if run.status <> 'previewed' then
    raise exception using errcode = '23514', message = 'El preview ya no puede aplicarse.';
  end if;

  current_snapshot := public.catalog_review_reprocess_state_fingerprint_v1();
  if current_snapshot <> run.snapshot_fingerprint then
    update public.catalog_review_reprocess_runs set status = 'expired' where id = run.id;
    raise exception using errcode = '40001', message = 'La Mesa o su evidencia cambiaron; genera un preview nuevo.';
  end if;

  before_metrics := public.catalog_review_reprocess_metrics_v1();
  select count(*) into events_before from public.catalog_review_events;

  for planned in
    select preview_item.*
    from public.catalog_review_reprocess_items preview_item
    where preview_item.reprocess_run_id = run.id
      and preview_item.planned_action not in ('keep', 'audit_completed')
    order by case preview_item.planned_action
      when 'auto_resolve' then 1
      when 'supersede' then 2
      when 'reclassify' then 3
      else 4 end,
      preview_item.work_key
  loop
    if planned.planned_action = 'reclassify' then
      update public.catalog_review_work_items
      set handling_class = planned.target_handling_class,
          context = context || jsonb_build_object(
            'reprocessRule', planned.rule_code,
            'reprocessClassification', planned.target_handling_class
          )
      where id = planned.work_item_id
        and row_version = planned.expected_row_version
        and status in ('open', 'in_progress')
      returning * into changed;
      if not found then
        raise exception using errcode = '40001', message = 'Un trabajo cambió después del preview.';
      end if;
      insert into public.catalog_review_events(
        work_item_id, work_key, event_type, action_code, actor_label,
        idempotency_key, request_fingerprint, prior_version, new_version, payload
      ) values (
        changed.id, changed.work_key, 'work_reclassified', planned.rule_code,
        'stage3-reprocess-v1',
        'reprocess:' || run.id::text || ':' || changed.id::text || ':reclassify',
        md5(planned.evidence_fingerprint || ':reclassify'),
        planned.expected_row_version, changed.row_version,
        jsonb_build_object(
          'handlingClass', planned.target_handling_class,
          'rule', planned.rule_code,
          'previewId', run.id
        )
      );
      changed_count := changed_count + 1;

    elsif planned.planned_action = 'auto_resolve' then
      if planned.planned_payload->>'sourceType' = 'reconciliation_case' then
        update public.catalog_reconciliation_cases
        set status = 'approved',
            decision_reason = 'Verificación objetiva automática: ' || planned.rule_code,
            decided_at = now()
        where id = (planned.planned_payload->>'sourceId')::uuid
          and status in ('proposed', 'needs_review');
      elsif planned.planned_payload->>'sourceType' = 'enrichment_exception' then
        update public.catalog_enrichment_exceptions
        set status = 'resolved',
            resolution_notes = 'Evidencia material verificada por ' || planned.rule_code,
            resolved_at = now()
        where id = (planned.planned_payload->>'sourceId')::uuid
          and status in ('open', 'in_review');
      end if;

      update public.catalog_review_work_items
      set status = 'resolved',
          resolution_code = planned.target_resolution_code,
          resolution_payload = jsonb_build_object(
            'rule', planned.rule_code,
            'evidenceFingerprint', planned.evidence_fingerprint,
            'previewId', run.id,
            'commercialEffect', 'none'
          ),
          resolved_at = now(),
          context = context || jsonb_build_object('reprocessRule', planned.rule_code)
      where id = planned.work_item_id
        and row_version = planned.expected_row_version
        and status in ('open', 'in_progress')
      returning * into changed;
      if not found then
        raise exception using errcode = '40001', message = 'Un trabajo cambió después del preview.';
      end if;
      insert into public.catalog_review_events(
        work_item_id, work_key, event_type, action_code, actor_label,
        idempotency_key, request_fingerprint, prior_version, new_version,
        payload, evidence
      ) values (
        changed.id, changed.work_key, 'work_auto_resolved',
        planned.target_resolution_code, 'stage3-reprocess-v1',
        'reprocess:' || run.id::text || ':' || changed.id::text || ':resolve',
        md5(planned.evidence_fingerprint || ':resolve'),
        planned.expected_row_version, changed.row_version,
        changed.resolution_payload,
        jsonb_build_array(jsonb_build_object(
          'kind', 'reprocess_rule', 'rule', planned.rule_code,
          'fingerprint', planned.evidence_fingerprint
        ))
      );
      changed_count := changed_count + 1;

    elsif planned.planned_action = 'supersede' then
      update public.catalog_review_work_items
      set status = 'superseded',
          resolution_code = planned.target_resolution_code,
          resolution_payload = jsonb_build_object('rule', planned.rule_code, 'previewId', run.id),
          resolved_at = now()
      where id = planned.work_item_id
        and row_version = planned.expected_row_version
        and status in ('open', 'in_progress')
      returning * into changed;
      if not found then
        raise exception using errcode = '40001', message = 'Un trabajo cambió después del preview.';
      end if;
      insert into public.catalog_review_events(
        work_item_id, work_key, event_type, action_code, actor_label,
        idempotency_key, request_fingerprint, prior_version, new_version, payload
      ) values (
        changed.id, changed.work_key, 'work_superseded', planned.target_resolution_code,
        'stage3-reprocess-v1',
        'reprocess:' || run.id::text || ':' || changed.id::text || ':supersede',
        md5(planned.evidence_fingerprint || ':supersede'),
        planned.expected_row_version, changed.row_version, changed.resolution_payload
      );
      changed_count := changed_count + 1;

    elsif planned.planned_action = 'new_historical_contradiction' then
      select * into generated
      from public.register_catalog_review_work_item_v1(
        planned.generated_work_family_key,
        'manual', null, 'audit',
        planned.planned_payload->>'purpose',
        planned.planned_payload->>'subjectType',
        nullif(planned.planned_payload->>'subjectId', '')::uuid,
        planned.evidence_fingerprint,
        'Evidencia nueva contradice una decisión histórica. ¿Qué hecho vigente debe revisarse?',
        'Revisar la evidencia nueva sin modificar la decisión histórica.',
        planned.planned_payload->>'groupKey',
        'critical', 'critical', true, 0, 100::numeric, 2::smallint,
        jsonb_build_object(
          'reprocessOrigin', 'historical_contradiction',
          'previousWorkItemId', planned.work_item_id,
          'previousWorkKey', planned.work_key,
          'evidenceFingerprint', planned.evidence_fingerprint,
          'evidence', planned.planned_payload->'historicalEvidence'
        )
      );
      insert into public.catalog_review_events(
        work_item_id, work_key, event_type, action_code, actor_label,
        idempotency_key, request_fingerprint, prior_version, new_version, payload, evidence
      ) values (
        planned.work_item_id, planned.work_key, 'historical_contradiction_detected',
        'new_evidence_conflict', 'stage3-reprocess-v1',
        'reprocess:' || run.id::text || ':' || planned.work_item_id::text || ':historical-conflict',
        md5(planned.evidence_fingerprint || ':historical-conflict'),
        planned.expected_row_version, planned.expected_row_version,
        jsonb_build_object(
          'newWorkItemId', generated.id,
          'newWorkKey', generated.work_key,
          'previewId', run.id
        ),
        jsonb_build_array(planned.planned_payload->'historicalEvidence')
      );
      new_count := new_count + 1;
      historical_count := historical_count + 1;
    end if;
  end loop;

  -- Las transiciones anteriores pueden satisfacer o invalidar prerequisitos.
  -- Reutiliza el proyector canónico de dependencias dentro del mismo apply para
  -- que la Mesa aplicada ya sea el estado final y no cambie en la siguiente
  -- recarga idéntica.
  perform public.refresh_catalog_review_dependencies_v1();

  select count(*)::integer into unblocked_count
  from public.catalog_review_reprocess_items preview_item
  join public.catalog_review_queue_v1 queue on queue.id = preview_item.work_item_id
  where preview_item.reprocess_run_id = run.id
    and preview_item.previous_queue_state = 'blocked'
    and queue.queue_state in ('reviewable', 'capture_required', 'waiting_external', 'automatic_debt');

  after_metrics := public.catalog_review_reprocess_metrics_v1()
    || jsonb_build_object(
      'newFromEvidence', new_count,
      'unblocked', unblocked_count,
      'historicalContradictionsNew', historical_count
    );
  select count(*) into events_after from public.catalog_review_events;

  update public.catalog_review_reprocess_runs
  set status = 'applied',
      application_idempotency_key = p_idempotency_key,
      metrics_after = after_metrics,
      action_counts = action_counts || jsonb_build_object(
        'changed', changed_count,
        'newFromEvidence', new_count,
        'unblocked', unblocked_count,
        'eventsCreated', events_after - events_before
      ),
      applied_at = now()
  where id = run.id
  returning * into run;

  return jsonb_build_object(
    'previewId', run.id,
    'status', run.status,
    'snapshotFingerprint', run.snapshot_fingerprint,
    'previewFingerprint', run.preview_fingerprint,
    'logicalFingerprint', run.logical_fingerprint,
    'metricsBefore', before_metrics,
    'metricsAfter', run.metrics_after,
    'actionCounts', run.action_counts,
    'idempotentReplay', false
  );
end;
$function$;

create or replace function public.get_catalog_review_reprocess_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'currentMetrics', public.catalog_review_reprocess_metrics_v1(),
    'cumulative', jsonb_build_object(
      'newFromEvidenceSinceFirstPreview', case
        when exists (
          select 1 from public.catalog_review_reprocess_runs run
          where run.status = 'applied'
        ) then greatest(
          0,
          coalesce((public.catalog_review_reprocess_metrics_v1()->>'totalWork')::integer, 0)
          - (
          select (run.metrics_before->>'totalWork')::integer
          from public.catalog_review_reprocess_runs run
          where run.status = 'applied'
          order by run.applied_at
          limit 1
          )
        )
        else 0
      end,
      'unblocked', coalesce((
        select sum(coalesce((run.action_counts->>'unblocked')::integer, 0))
        from public.catalog_review_reprocess_runs run where run.status = 'applied'
      ), 0),
      'historicalContradictionsNew', coalesce((
        select sum(coalesce((run.metrics_after->>'historicalContradictionsNew')::integer, 0))
        from public.catalog_review_reprocess_runs run where run.status = 'applied'
      ), 0)
    ),
    'baselineRun', (
      select jsonb_build_object(
        'id', run.id,
        'status', run.status,
        'engineVersion', run.engine_version,
        'snapshotFingerprint', run.snapshot_fingerprint,
        'previewFingerprint', run.preview_fingerprint,
        'logicalFingerprint', run.logical_fingerprint,
        'metricsBefore', run.metrics_before,
        'metricsAfter', run.metrics_after,
        'actionCounts', run.action_counts,
        'createdAt', run.created_at,
        'appliedAt', run.applied_at
      )
      from public.catalog_review_reprocess_runs run
      where run.status = 'applied'
      order by run.applied_at
      limit 1
    ),
    'latestRun', (
      select jsonb_build_object(
        'id', run.id,
        'status', run.status,
        'engineVersion', run.engine_version,
        'snapshotFingerprint', run.snapshot_fingerprint,
        'previewFingerprint', run.preview_fingerprint,
        'logicalFingerprint', run.logical_fingerprint,
        'metricsBefore', run.metrics_before,
        'metricsAfter', run.metrics_after,
        'actionCounts', run.action_counts,
        'createdAt', run.created_at,
        'appliedAt', run.applied_at
      )
      from public.catalog_review_reprocess_runs run
      order by run.created_at desc
      limit 1
    ),
    'lastChangeRun', (
      select jsonb_build_object(
        'id', run.id,
        'status', run.status,
        'engineVersion', run.engine_version,
        'snapshotFingerprint', run.snapshot_fingerprint,
        'previewFingerprint', run.preview_fingerprint,
        'logicalFingerprint', run.logical_fingerprint,
        'metricsBefore', run.metrics_before,
        'metricsAfter', run.metrics_after,
        'actionCounts', run.action_counts,
        'createdAt', run.created_at,
        'appliedAt', run.applied_at
      )
      from public.catalog_review_reprocess_runs run
      where run.status = 'applied'
        and coalesce((run.action_counts->>'changed')::integer, 0)
          + coalesce((run.action_counts->>'newFromEvidence')::integer, 0) > 0
      order by run.applied_at desc
      limit 1
    ),
    'distribution', coalesce((
      select jsonb_agg(jsonb_build_object(
        'handlingClass', grouped.handling_class,
        'purpose', grouped.purpose,
        'status', grouped.status,
        'total', grouped.total
      ) order by grouped.handling_class, grouped.purpose, grouped.status)
      from (
        select item.handling_class, item.purpose, item.status, count(*)::integer as total
        from public.catalog_review_work_items item
        group by item.handling_class, item.purpose, item.status
      ) grouped
    ), '[]'::jsonb)
  );
$function$;

-- La Mesa forma parte del conocimiento operacional proyectado, pero queda en
-- una capa workflow distinta de hechos, referencias, candidatas y evidencia.
create or replace view public.graph_review_work_nodes_v1
with (security_invoker = true) as
select
  'review_work:' || queue.id::text as node_key,
  'ReviewWork'::text as node_type,
  queue.id as entity_id,
  queue.work_key as label,
  'workflow'::text as layer,
  jsonb_build_object(
    'status', queue.status,
    'queueState', queue.queue_state,
    'handlingClass', queue.handling_class,
    'workKind', queue.work_kind,
    'purpose', queue.purpose,
    'sourceType', queue.source_type,
    'riskLevel', queue.risk_level,
    'hasContradiction', queue.has_contradiction,
    'blockedByCount', queue.blocked_by_count,
    'humanActionable', queue.human_actionable,
    'resolutionCode', queue.resolution_code
  ) as properties
from public.catalog_review_queue_v1 queue;

create or replace view public.graph_review_work_edges_v1
with (security_invoker = true) as
select
  'review-dependency:' || dependency.id::text as edge_key,
  'review_work:' || dependency.prerequisite_work_item_id::text as source_key,
  case dependency.dependency_type
    when 'invalidated_by' then 'INVALIDATES'
    else 'BLOCKS'
  end as predicate,
  'review_work:' || dependency.dependent_work_item_id::text as target_key,
  'workflow'::text as layer,
  jsonb_build_object(
    'dependencyType', dependency.dependency_type,
    'groupKey', dependency.group_key,
    'condition', dependency.condition
  ) as properties
from public.catalog_review_dependencies dependency
union all
select
  'review-historical-contradiction:' || item.id::text,
  'review_work:' || item.id::text,
  'CONTRADICTS_DECISION'::text,
  'review_work:' || (item.context->>'previousWorkItemId')::uuid::text,
  'workflow'::text,
  jsonb_build_object('evidenceFingerprint', item.context->>'evidenceFingerprint')
from public.catalog_review_work_items item
where item.context->>'reprocessOrigin' = 'historical_contradiction'
  and item.context->>'previousWorkItemId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select
  node.node_key,
  node.node_type,
  node.entity_id,
  node.label,
  node.layer,
  node.properties,
  md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|' || node.label || '|' || node.properties::text) as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all
  select * from public.graph_identity_case_nodes_v1
  union all
  select * from public.graph_review_work_nodes_v1
) node;

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select
  edge.edge_key,
  edge.source_key,
  edge.predicate,
  edge.target_key,
  edge.layer,
  edge.properties,
  md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|' || edge.target_key || '|' || edge.layer || '|' || edge.properties::text) as projection_fingerprint
from (
  select * from public.graph_edges_v2_base where edge_key not like 'reference-match:%'
  union all
  select * from public.graph_identity_case_edges_v1
  union all
  select * from public.graph_review_work_edges_v1
) edge;

alter table public.catalog_review_reprocess_runs enable row level security;
alter table public.catalog_review_reprocess_items enable row level security;

create policy "admins read catalog review reprocess runs"
on public.catalog_review_reprocess_runs for select to authenticated
using (public.is_admin(auth.uid()));
create policy "admins read catalog review reprocess items"
on public.catalog_review_reprocess_items for select to authenticated
using (public.is_admin(auth.uid()));

grant select on public.catalog_review_reprocess_runs,
  public.catalog_review_reprocess_items,
  public.catalog_review_reprocess_plan_v1,
  public.graph_review_work_nodes_v1,
  public.graph_review_work_edges_v1 to authenticated, service_role;

revoke all on function public.prevent_catalog_review_reprocess_item_mutation()
from public, anon, authenticated;
revoke all on function public.default_catalog_review_handling_class()
from public, anon, authenticated;
revoke all on function public.preview_catalog_review_reprocess_v1(text)
from public, anon, authenticated;
grant execute on function public.preview_catalog_review_reprocess_v1(text)
to service_role;
revoke all on function public.apply_catalog_review_reprocess_v1(uuid,text,text)
from public, anon, authenticated;
grant execute on function public.apply_catalog_review_reprocess_v1(uuid,text,text)
to service_role;
revoke execute on function public.catalog_review_reprocess_state_fingerprint_v1() from public, anon;
revoke execute on function public.catalog_review_reprocess_metrics_v1() from public, anon;
revoke execute on function public.get_catalog_review_reprocess_report_v1() from public, anon;
grant execute on function public.catalog_review_reprocess_state_fingerprint_v1(),
  public.catalog_review_reprocess_metrics_v1(),
  public.get_catalog_review_reprocess_report_v1() to authenticated, service_role;

comment on column public.catalog_review_work_items.handling_class is
  'Clasifica trabajo incompleto en excepción humana, deuda automática, captura física o espera externa.';
comment on table public.catalog_review_reprocess_runs is
  'Fotografía, preview congelado y resultado idempotente del reproceso global de la Mesa.';
comment on function public.apply_catalog_review_reprocess_v1(uuid,text,text) is
  'Aplica exactamente un preview vigente; conserva decisiones históricas y no produce efectos comerciales.';

commit;
