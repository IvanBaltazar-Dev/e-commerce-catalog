-- 0110 - Escala humana sublineal para el motor semantico universal.
-- Los problemas se detectan por claim/producto, pero la Mesa solo recibe
-- ambiguedades bloqueantes agregadas por regla o causa compartida.

begin;

create table public.catalog_semantic_problem_groups (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  group_key text not null unique,
  aggregation_key text not null,
  aggregation_basis text not null,
  aggregation_value text not null,
  rule_code text,
  partition_key text,
  non_aggregation_justification text,
  status text not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_problem_groups_aggregation_basis_allowed check (
    aggregation_basis in ('rule_code', 'technical_type', 'dimension', 'root_cause')
  ),
  constraint catalog_semantic_problem_groups_keys_not_blank check (
    length(trim(group_key)) > 0
    and length(trim(aggregation_key)) > 0
    and length(trim(aggregation_value)) > 0
  ),
  constraint catalog_semantic_problem_groups_rule_not_blank check (
    rule_code is null or length(trim(rule_code)) > 0
  ),
  constraint catalog_semantic_problem_groups_partition_proven check (
    (partition_key is null and non_aggregation_justification is null)
    or (
      partition_key is not null
      and length(trim(partition_key)) > 0
      and non_aggregation_justification is not null
      and length(trim(non_aggregation_justification)) >= 30
    )
  ),
  constraint catalog_semantic_problem_groups_status_allowed check (
    status in ('open', 'resolved', 'superseded')
  ),
  constraint catalog_semantic_problem_groups_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (research_run_id, aggregation_key)
);

create index catalog_semantic_problem_groups_rule_idx
  on public.catalog_semantic_problem_groups(research_run_id, rule_code, status)
  where rule_code is not null;

create table public.catalog_semantic_problems (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  problem_group_id uuid not null references public.catalog_semantic_problem_groups(id) on delete restrict,
  problem_key text not null,
  observation_id uuid references public.catalog_observations(id) on delete restrict,
  reference_product_id uuid not null references public.catalog_reference_products(id) on delete restrict,
  epistemic_state text not null,
  problem_kind text not null,
  root_cause_code text not null,
  rule_code text,
  technical_type text,
  dimension text,
  decision_blocking boolean not null default false,
  requires_human_judgment boolean not null default false,
  material_fingerprint text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint catalog_semantic_problems_key_not_blank check (length(trim(problem_key)) > 0),
  constraint catalog_semantic_problems_epistemic_state_allowed check (
    epistemic_state in (
      'source_observation', 'normalized_source', 'derived', 'inferred_uncertain',
      'canonical', 'unknown', 'not_stated', 'not_applicable', 'contradicted',
      'needs_evidence', 'rejected', 'superseded'
    )
  ),
  constraint catalog_semantic_problems_kind_not_blank check (length(trim(problem_kind)) > 0),
  constraint catalog_semantic_problems_root_cause_not_blank check (
    length(trim(root_cause_code)) > 0
  ),
  constraint catalog_semantic_problems_optional_values_not_blank check (
    (rule_code is null or length(trim(rule_code)) > 0)
    and (technical_type is null or length(trim(technical_type)) > 0)
    and (dimension is null or length(trim(dimension)) > 0)
  ),
  constraint catalog_semantic_problems_human_requires_blocker check (
    not requires_human_judgment or decision_blocking
  ),
  constraint catalog_semantic_problems_fingerprint_not_blank check (
    length(trim(material_fingerprint)) >= 16
  ),
  constraint catalog_semantic_problems_status_allowed check (
    status in ('active', 'resolved', 'superseded')
  ),
  constraint catalog_semantic_problems_metadata_object check (jsonb_typeof(metadata) = 'object'),
  unique (research_run_id, problem_key)
);

create index catalog_semantic_problems_group_status_idx
  on public.catalog_semantic_problems(problem_group_id, status, reference_product_id);
create index catalog_semantic_problems_rule_dimension_idx
  on public.catalog_semantic_problems(research_run_id, rule_code, dimension, status);
create index catalog_semantic_problems_product_idx
  on public.catalog_semantic_problems(reference_product_id, research_run_id, status);

-- Una regla conocida domina la clave de agrupacion. Solo una particion
-- justificada puede producir mas de un conjunto para la misma regla/campana.
create or replace function public.validate_catalog_semantic_problem_group()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.rule_code is not null and new.aggregation_basis <> 'rule_code' then
    raise exception using errcode = '23514',
      message = 'Un problema con rule_code debe agregarse primero a nivel de regla.';
  end if;

  if new.partition_key is not null and (
    new.non_aggregation_justification is null
    or length(trim(new.non_aggregation_justification)) < 30
  ) then
    raise exception using errcode = '23514',
      message = 'Dividir una regla exige demostrar por que un unico conjunto afectado no basta.';
  end if;

  return new;
end;
$function$;

create trigger catalog_semantic_problem_groups_validate
before insert or update on public.catalog_semantic_problem_groups
for each row execute function public.validate_catalog_semantic_problem_group();

create or replace function public.register_catalog_semantic_problem_v1(
  p_research_run_id uuid,
  p_problem_key text,
  p_reference_product_id uuid,
  p_epistemic_state text,
  p_problem_kind text,
  p_root_cause_code text,
  p_rule_code text default null,
  p_technical_type text default null,
  p_dimension text default null,
  p_observation_id uuid default null,
  p_decision_blocking boolean default false,
  p_requires_human_judgment boolean default false,
  p_aggregation_basis text default null,
  p_partition_key text default null,
  p_non_aggregation_justification text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.catalog_semantic_problems
language plpgsql
security definer
set search_path = ''
as $function$
declare
  resolved_basis text;
  resolved_value text;
  resolved_type text;
  resolved_rule text := nullif(trim(coalesce(p_rule_code, '')), '');
  resolved_dimension text := nullif(trim(coalesce(p_dimension, '')), '');
  resolved_partition text := nullif(trim(coalesce(p_partition_key, '')), '');
  aggregation_key_value text;
  deterministic_group_key text;
  problem_fingerprint text;
  registered_group public.catalog_semantic_problem_groups%rowtype;
  registered_problem public.catalog_semantic_problems%rowtype;
  existing_problem public.catalog_semantic_problems%rowtype;
  observed public.catalog_observations%rowtype;
begin
  if p_research_run_id is null or not exists (
    select 1 from public.catalog_research_runs where id = p_research_run_id
  ) then
    raise exception using errcode = '23503', message = 'La campana semantica no existe.';
  end if;
  if p_reference_product_id is null then
    raise exception using errcode = '22023', message = 'El problema debe identificar el producto afectado.';
  end if;
  if nullif(trim(coalesce(p_problem_key, '')), '') is null
     or nullif(trim(coalesce(p_problem_kind, '')), '') is null
     or nullif(trim(coalesce(p_root_cause_code, '')), '') is null then
    raise exception using errcode = '22023',
      message = 'Problema, tipo y causa raiz son obligatorios.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Los metadatos del problema deben ser un objeto.';
  end if;
  if p_requires_human_judgment and not p_decision_blocking then
    raise exception using errcode = '23514',
      message = 'El criterio humano solo puede solicitarse para una decision bloqueada.';
  end if;

  select product.product_type into resolved_type
  from public.catalog_reference_products product
  where product.id = p_reference_product_id;
  if not found then
    raise exception using errcode = '23503', message = 'El producto de referencia no existe.';
  end if;
  resolved_type := coalesce(nullif(trim(coalesce(p_technical_type, '')), ''), resolved_type);

  if p_observation_id is not null then
    select * into observed from public.catalog_observations where id = p_observation_id;
    if not found then
      raise exception using errcode = '23503', message = 'El claim observado no existe.';
    end if;
    if observed.research_run_id is distinct from p_research_run_id
       or coalesce(
         observed.reference_product_id,
         (select variant.reference_product_id
          from public.catalog_reference_variants variant
          where variant.id = observed.reference_variant_id)
       ) is distinct from p_reference_product_id then
      raise exception using errcode = '23514',
        message = 'El claim no pertenece a la campana y producto declarados.';
    end if;
  end if;

  if resolved_rule is not null then
    if p_aggregation_basis is not null and p_aggregation_basis <> 'rule_code' then
      raise exception using errcode = '23514',
        message = 'Antes de particionar, los fallos con rule_code deben representarse como un problema de regla.';
    end if;
    resolved_basis := 'rule_code';
    resolved_value := resolved_rule;
  else
    resolved_basis := coalesce(nullif(trim(coalesce(p_aggregation_basis, '')), ''), 'root_cause');
    if resolved_basis = 'technical_type' then
      resolved_value := resolved_type;
    elsif resolved_basis = 'dimension' then
      resolved_value := resolved_dimension;
    elsif resolved_basis = 'root_cause' then
      resolved_value := trim(p_root_cause_code);
    else
      raise exception using errcode = '22023',
        message = 'Sin rule_code solo se puede agrupar por tipo tecnico, dimension o causa raiz.';
    end if;
    if nullif(trim(coalesce(resolved_value, '')), '') is null then
      raise exception using errcode = '22023',
        message = 'La dimension elegida para agrupar no tiene valor.';
    end if;
  end if;

  if resolved_partition is not null and (
    p_non_aggregation_justification is null
    or length(trim(p_non_aggregation_justification)) < 30
  ) then
    raise exception using errcode = '23514',
      message = 'Dividir una regla exige demostrar por que un unico conjunto afectado no basta.';
  end if;

  aggregation_key_value := resolved_basis || ':' || lower(trim(resolved_value));
  if resolved_partition is not null then
    aggregation_key_value := aggregation_key_value || ':partition:' || md5(lower(resolved_partition));
  end if;
  deterministic_group_key := 'semantic_problem:'
    || replace(p_research_run_id::text, '-', '') || ':' || md5(aggregation_key_value);

  insert into public.catalog_semantic_problem_groups(
    research_run_id, group_key, aggregation_key, aggregation_basis,
    aggregation_value, rule_code, partition_key, non_aggregation_justification,
    metadata
  ) values (
    p_research_run_id, deterministic_group_key, aggregation_key_value, resolved_basis,
    trim(resolved_value), resolved_rule, resolved_partition,
    case when resolved_partition is null then null else trim(p_non_aggregation_justification) end,
    jsonb_build_object('createdBy', 'register_catalog_semantic_problem_v1')
  )
  on conflict (research_run_id, aggregation_key) do update
    set updated_at = now()
  returning * into registered_group;

  problem_fingerprint := md5(jsonb_build_object(
    'researchRunId', p_research_run_id,
    'problemKey', trim(p_problem_key),
    'productId', p_reference_product_id,
    'observationId', p_observation_id,
    'epistemicState', p_epistemic_state,
    'problemKind', trim(p_problem_kind),
    'rootCause', trim(p_root_cause_code),
    'ruleCode', resolved_rule,
    'technicalType', resolved_type,
    'dimension', resolved_dimension,
    'decisionBlocking', p_decision_blocking,
    'requiresHumanJudgment', p_requires_human_judgment,
    'groupId', registered_group.id,
    'metadata', coalesce(p_metadata, '{}'::jsonb)
  )::text);

  insert into public.catalog_semantic_problems(
    research_run_id, problem_group_id, problem_key, observation_id,
    reference_product_id, epistemic_state, problem_kind, root_cause_code,
    rule_code, technical_type, dimension, decision_blocking,
    requires_human_judgment, material_fingerprint, metadata
  ) values (
    p_research_run_id, registered_group.id, trim(p_problem_key), p_observation_id,
    p_reference_product_id, p_epistemic_state, trim(p_problem_kind), trim(p_root_cause_code),
    resolved_rule, resolved_type, resolved_dimension, p_decision_blocking,
    p_requires_human_judgment, problem_fingerprint, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (research_run_id, problem_key) do nothing
  returning * into registered_problem;

  if registered_problem.id is null then
    select * into existing_problem
    from public.catalog_semantic_problems
    where research_run_id = p_research_run_id and problem_key = trim(p_problem_key);
    if existing_problem.material_fingerprint <> problem_fingerprint then
      raise exception using errcode = '23505',
        message = 'La clave del problema ya representa otra evidencia material.';
    end if;
    return existing_problem;
  end if;

  return registered_problem;
end;
$function$;

-- Conserva el contrato de Mesa existente. El origen sigue siendo manual,
-- pero queda identificado inequivocamente en context como un conjunto
-- semantico; nunca se crea un trabajo por miembro/producto.
alter table public.catalog_review_work_items
  drop constraint catalog_review_subject_type_allowed;
alter table public.catalog_review_work_items
  add constraint catalog_review_subject_type_allowed check (subject_type in (
    'product', 'variant', 'shade', 'brand', 'class', 'system',
    'relation', 'source_record', 'rule', 'other'
  ));

create or replace view public.catalog_semantic_problem_groups_v1
with (security_invoker = true) as
select
  problem_group.id,
  problem_group.research_run_id,
  problem_group.group_key,
  problem_group.aggregation_key,
  problem_group.aggregation_basis,
  problem_group.aggregation_value,
  problem_group.rule_code,
  problem_group.partition_key,
  problem_group.non_aggregation_justification,
  problem_group.status,
  counts.problem_count,
  counts.affected_product_count,
  counts.affected_claim_count,
  counts.decision_blocking_count,
  counts.human_judgment_count,
  counts.technical_types,
  counts.dimensions,
  counts.root_causes,
  counts.epistemic_states,
  counts.affected_set_fingerprint,
  review.id as review_work_item_id,
  review.work_key as review_work_key,
  review.status as review_status,
  review.handling_class as review_handling_class,
  review.human_actionable,
  problem_group.created_at,
  problem_group.updated_at
from public.catalog_semantic_problem_groups problem_group
cross join lateral (
  select
    count(*)::bigint as problem_count,
    count(distinct problem.reference_product_id)::bigint as affected_product_count,
    count(*) filter (where problem.observation_id is not null)::bigint as affected_claim_count,
    count(*) filter (where problem.decision_blocking)::bigint as decision_blocking_count,
    count(*) filter (where problem.requires_human_judgment)::bigint as human_judgment_count,
    coalesce(jsonb_agg(distinct problem.technical_type)
      filter (where problem.technical_type is not null), '[]'::jsonb) as technical_types,
    coalesce(jsonb_agg(distinct problem.dimension)
      filter (where problem.dimension is not null), '[]'::jsonb) as dimensions,
    coalesce(jsonb_agg(distinct problem.root_cause_code), '[]'::jsonb) as root_causes,
    coalesce(jsonb_agg(distinct problem.epistemic_state), '[]'::jsonb) as epistemic_states,
    md5(coalesce(string_agg(problem.material_fingerprint, '|' order by problem.material_fingerprint), ''))
      as affected_set_fingerprint
  from public.catalog_semantic_problems problem
  where problem.problem_group_id = problem_group.id and problem.status = 'active'
) counts
left join lateral (
  select queue.id, queue.work_key, queue.status, queue.handling_class, queue.human_actionable
  from public.catalog_review_queue_v1 queue
  where queue.source_type = 'manual'
    and queue.source_id = problem_group.id
    and queue.context->>'semanticOrigin' = 'problem_group'
  order by queue.problem_version desc
  limit 1
) review on true;

create or replace function public.validate_catalog_semantic_review_work()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  semantic_group public.catalog_semantic_problem_groups_v1%rowtype;
begin
  if new.context->>'semanticOrigin' is distinct from 'problem_group' then
    if new.source_type = 'manual' and new.source_id is not null and exists (
      select 1 from public.catalog_semantic_problem_groups where id = new.source_id
    ) then
      raise exception using errcode = '23514',
        message = 'Un grupo semantico no puede entrar a Mesa por una ruta individual o sin contrato de agregacion.';
    end if;
    return new;
  end if;

  if new.source_type <> 'manual' or new.source_id is null then
    raise exception using errcode = '23514',
      message = 'Una excepcion semantica debe representar un grupo completo en la Mesa existente.';
  end if;

  select * into semantic_group
  from public.catalog_semantic_problem_groups_v1
  where id = new.source_id;
  if not found or semantic_group.problem_count = 0 then
    raise exception using errcode = '23514',
      message = 'La excepcion semantica no tiene un conjunto afectado vigente.';
  end if;
  if semantic_group.decision_blocking_count = 0 or semantic_group.human_judgment_count = 0 then
    raise exception using errcode = '23514',
      message = 'UNKNOWN, NOT_STATED, DERIVED o incertidumbre no crean por si solos una excepcion humana.';
  end if;
  if new.work_kind <> 'decision' or new.subject_type <> 'rule' or new.subject_id is not null
     or new.group_key is distinct from semantic_group.group_key
     or new.handling_class <> 'human_exception' then
    raise exception using errcode = '23514',
      message = 'La Mesa debe decidir la regla agregada, no revisar productos individuales.';
  end if;
  if new.context->>'affectedSetFingerprint' is distinct from semantic_group.affected_set_fingerprint
     and not (
       tg_op = 'UPDATE'
       and new.status = 'superseded'
       and new.resolution_code = 'material_evidence_changed'
     ) then
    raise exception using errcode = '40001',
      message = 'El conjunto afectado cambio; reconstruye la excepcion agregada.';
  end if;
  if tg_op = 'UPDATE' and new.status = 'resolved' and old.status <> 'resolved'
     and nullif(trim(coalesce(new.resolution_payload->>'reason', '')), '') is null then
    raise exception using errcode = '22023',
      message = 'La decision de regla exige explicar el criterio humano aplicado.';
  end if;

  return new;
end;
$function$;

create trigger catalog_review_work_items_semantic_guard
before insert or update of source_type, source_id, work_kind, subject_type,
  subject_id, group_key, handling_class, context, status, resolution_payload
on public.catalog_review_work_items
for each row execute function public.validate_catalog_semantic_review_work();

create or replace function public.escalate_catalog_semantic_problem_group_v1(
  p_problem_group_id uuid,
  p_question text,
  p_recommendation text default null,
  p_priority_tier text default 'normal',
  p_risk_level text default 'normal'
)
returns public.catalog_review_work_items
language plpgsql
security definer
set search_path = ''
as $function$
declare
  semantic_group public.catalog_semantic_problem_groups_v1%rowtype;
  registered_work public.catalog_review_work_items%rowtype;
begin
  select * into semantic_group
  from public.catalog_semantic_problem_groups_v1
  where id = p_problem_group_id;

  if not found or semantic_group.problem_count = 0 then
    raise exception using errcode = 'P0002', message = 'El grupo semantico no existe o esta vacio.';
  end if;
  if semantic_group.status <> 'open' then
    raise exception using errcode = '23514', message = 'El grupo semantico ya no esta abierto.';
  end if;
  if semantic_group.decision_blocking_count = 0 or semantic_group.human_judgment_count = 0 then
    raise exception using errcode = '23514',
      message = 'La Mesa solo recibe ambiguedades que bloquean una decision y requieren criterio humano.';
  end if;
  if nullif(trim(coalesce(p_question, '')), '') is null then
    raise exception using errcode = '22023', message = 'La ambiguedad bloqueante exige una pregunta concreta.';
  end if;

  select * into registered_work
  from public.register_catalog_review_work_item_v1(
    'semantic_problem_group:' || md5(semantic_group.group_key),
    'manual', semantic_group.id, 'decision', 'other', 'rule', null,
    md5(semantic_group.group_key || '|' || semantic_group.affected_set_fingerprint),
    trim(p_question), nullif(trim(coalesce(p_recommendation, '')), ''),
    semantic_group.group_key, p_priority_tier, p_risk_level,
    'contradicted' = any(
      select jsonb_array_elements_text(semantic_group.epistemic_states)
    ),
    semantic_group.affected_product_count::integer,
    least(100, greatest(0, semantic_group.affected_product_count))::numeric,
    1::smallint,
    jsonb_build_object(
      'semanticOrigin', 'problem_group',
      'semanticProblemGroupId', semantic_group.id,
      'title', coalesce(semantic_group.rule_code, semantic_group.aggregation_value),
      'aggregationKey', semantic_group.aggregation_key,
      'aggregationBasis', semantic_group.aggregation_basis,
      'ruleCode', semantic_group.rule_code,
      'partitionKey', semantic_group.partition_key,
      'nonAggregationJustification', semantic_group.non_aggregation_justification,
      'affectedProductCount', semantic_group.affected_product_count,
      'affectedClaimCount', semantic_group.affected_claim_count,
      'problemCount', semantic_group.problem_count,
      'decisionBlockingCount', semantic_group.decision_blocking_count,
      'humanJudgmentCount', semantic_group.human_judgment_count,
      'affectedSetFingerprint', semantic_group.affected_set_fingerprint,
      'technicalTypes', semantic_group.technical_types,
      'dimensions', semantic_group.dimensions,
      'rootCauses', semantic_group.root_causes,
      'epistemicStates', semantic_group.epistemic_states
    )
  );

  return registered_work;
end;
$function$;

create or replace view public.catalog_semantic_campaign_funnel_v1
with (security_invoker = true) as
with investigated_products as (
  select product.first_seen_run_id as research_run_id, product.id as reference_product_id
  from public.catalog_reference_products product
  union
  select product.last_seen_run_id, product.id
  from public.catalog_reference_products product
  union
  select observation.research_run_id,
         coalesce(observation.reference_product_id, variant.reference_product_id)
  from public.catalog_observations observation
  left join public.catalog_reference_variants variant
    on variant.id = observation.reference_variant_id
  where observation.research_run_id is not null
    and coalesce(observation.reference_product_id, variant.reference_product_id) is not null
  union
  select problem.research_run_id, problem.reference_product_id
  from public.catalog_semantic_problems problem
), product_counts as (
  select research_run_id, count(distinct reference_product_id)::bigint as products_investigated
  from investigated_products group by research_run_id
), claim_counts as (
  select observation.research_run_id, count(*)::bigint as claims
  from public.catalog_observations observation
  where observation.research_run_id is not null
    and observation.observation_kind = 'semantic_claim'
  group by observation.research_run_id
), problem_counts as (
  select
    problem.research_run_id,
    count(*) filter (where problem.status = 'active')::bigint as problems_detected,
    count(distinct problem.problem_group_id) filter (where problem.status = 'active')::bigint
      as problems_grouped,
    count(distinct problem.rule_code) filter (
      where problem.status = 'active' and problem.rule_code is not null
    )::bigint as rules_affected
  from public.catalog_semantic_problems problem
  group by problem.research_run_id
), exception_counts as (
  select problem_group.research_run_id,
         count(distinct problem_group.id)::bigint as human_exceptions
  from public.catalog_semantic_problem_groups problem_group
  join public.catalog_review_work_items work
    on work.source_type = 'manual'
   and work.source_id = problem_group.id
   and work.context->>'semanticOrigin' = 'problem_group'
   and work.handling_class = 'human_exception'
   and work.status not in ('superseded', 'cancelled')
  group by problem_group.research_run_id
)
select
  run.id as research_run_id,
  run.run_key,
  run.status as research_status,
  coalesce(product_counts.products_investigated, 0)::bigint as products_investigated,
  coalesce(claim_counts.claims, 0)::bigint as claims,
  coalesce(problem_counts.problems_detected, 0)::bigint as problems_detected,
  coalesce(problem_counts.problems_grouped, 0)::bigint as problems_grouped,
  coalesce(problem_counts.rules_affected, 0)::bigint as rules_affected,
  coalesce(exception_counts.human_exceptions, 0)::bigint as human_exceptions,
  case when coalesce(product_counts.products_investigated, 0) = 0 then 0::numeric
    else round(1000 * coalesce(exception_counts.human_exceptions, 0)::numeric
      / product_counts.products_investigated::numeric, 4)
  end as human_exceptions_per_1000_products,
  case when coalesce(problem_counts.problems_detected, 0) = 0 then 0::numeric
    else round(1 - coalesce(exception_counts.human_exceptions, 0)::numeric
      / problem_counts.problems_detected::numeric, 4)
  end as individual_review_avoidance_ratio,
  run.started_at,
  run.finished_at
from public.catalog_research_runs run
left join product_counts on product_counts.research_run_id = run.id
left join claim_counts on claim_counts.research_run_id = run.id
left join problem_counts on problem_counts.research_run_id = run.id
left join exception_counts on exception_counts.research_run_id = run.id;

create or replace view public.catalog_semantic_scaling_v1
with (security_invoker = true) as
with campaign_points as (
  select
    funnel.*,
    coalesce(funnel.finished_at, now()) as measured_at,
    (
      select count(*)::bigint
      from public.catalog_reference_products product
      where product.first_seen_at <= coalesce(funnel.finished_at, now())
    ) as reference_universe_size
  from public.catalog_semantic_campaign_funnel_v1 funnel
), cumulative_points as (
  select
    point.*,
    sum(point.human_exceptions) over (
      order by point.measured_at, point.research_run_id rows unbounded preceding
    )::bigint as cumulative_human_exceptions
  from campaign_points point
), compared as (
  select
    point.*,
    lag(point.reference_universe_size) over (
      order by point.measured_at, point.research_run_id
    ) as previous_reference_universe_size,
    lag(point.cumulative_human_exceptions) over (
      order by point.measured_at, point.research_run_id
    ) as previous_cumulative_human_exceptions
  from cumulative_points point
)
select
  compared.*,
  compared.reference_universe_size - compared.previous_reference_universe_size
    as reference_universe_growth,
  compared.cumulative_human_exceptions - compared.previous_cumulative_human_exceptions
    as human_exception_growth,
  case when compared.reference_universe_size = 0 then 0::numeric
    else round(1000 * compared.cumulative_human_exceptions::numeric
      / compared.reference_universe_size::numeric, 4)
  end as cumulative_human_exceptions_per_1000_products,
  case
    when compared.previous_reference_universe_size is null
      or compared.previous_reference_universe_size = 0
      or compared.previous_cumulative_human_exceptions is null then null::numeric
    when compared.cumulative_human_exceptions = compared.previous_cumulative_human_exceptions then 0::numeric
    when compared.previous_cumulative_human_exceptions = 0 then null::numeric
    when compared.reference_universe_size <= compared.previous_reference_universe_size then null::numeric
    else round(
      ((compared.cumulative_human_exceptions - compared.previous_cumulative_human_exceptions)::numeric
        / compared.previous_cumulative_human_exceptions::numeric)
      / ((compared.reference_universe_size - compared.previous_reference_universe_size)::numeric
        / compared.previous_reference_universe_size::numeric),
      4
    )
  end as exception_to_universe_growth_ratio,
  case
    when compared.previous_reference_universe_size is null then 'insufficient_baseline'
    when compared.reference_universe_size <= compared.previous_reference_universe_size then 'no_universe_growth'
    when compared.cumulative_human_exceptions = compared.previous_cumulative_human_exceptions then 'passes'
    when compared.previous_cumulative_human_exceptions = 0 then 'insufficient_baseline'
    when (
      ((compared.cumulative_human_exceptions - compared.previous_cumulative_human_exceptions)::numeric
        / compared.previous_cumulative_human_exceptions::numeric)
      < ((compared.reference_universe_size - compared.previous_reference_universe_size)::numeric
        / compared.previous_reference_universe_size::numeric)
    ) then 'passes'
    else 'fails'
  end as sublinear_growth_indicator
from compared;

create or replace function public.get_catalog_semantic_campaign_report_v1(p_research_run_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'researchRunId', funnel.research_run_id,
    'runKey', funnel.run_key,
    'status', funnel.research_status,
    'flow', jsonb_build_object(
      'productsInvestigated', funnel.products_investigated,
      'claims', funnel.claims,
      'problemsDetected', funnel.problems_detected,
      'problemsGrouped', funnel.problems_grouped,
      'rulesAffected', funnel.rules_affected,
      'humanExceptions', funnel.human_exceptions
    ),
    'humanScale', jsonb_build_object(
      'exceptionsPer1000Products', funnel.human_exceptions_per_1000_products,
      'individualReviewAvoidanceRatio', funnel.individual_review_avoidance_ratio,
      'referenceUniverseSize', scaling.reference_universe_size,
      'cumulativeHumanExceptions', scaling.cumulative_human_exceptions,
      'exceptionToUniverseGrowthRatio', scaling.exception_to_universe_growth_ratio,
      'indicator', scaling.sublinear_growth_indicator
    ),
    'problemGroups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'groupId', problem_group.id,
        'groupKey', problem_group.group_key,
        'aggregationBasis', problem_group.aggregation_basis,
        'aggregationValue', problem_group.aggregation_value,
        'ruleCode', problem_group.rule_code,
        'problemCount', problem_group.problem_count,
        'affectedProductCount', problem_group.affected_product_count,
        'affectedClaimCount', problem_group.affected_claim_count,
        'humanActionable', coalesce(problem_group.human_actionable, false),
        'partitionKey', problem_group.partition_key,
        'nonAggregationJustification', problem_group.non_aggregation_justification,
        'affectedSetFingerprint', problem_group.affected_set_fingerprint
      ) order by problem_group.aggregation_basis, problem_group.aggregation_value)
      from public.catalog_semantic_problem_groups_v1 problem_group
      where problem_group.research_run_id = funnel.research_run_id
    ), '[]'::jsonb)
  )
  from public.catalog_semantic_campaign_funnel_v1 funnel
  left join public.catalog_semantic_scaling_v1 scaling
    on scaling.research_run_id = funnel.research_run_id
  where funnel.research_run_id = p_research_run_id;
$function$;

-- El grafo recibe un nodo por problema compartido, no una arista por producto.
create or replace view public.graph_semantic_problem_group_nodes_v1
with (security_invoker = true) as
select
  'semantic_problem_group:' || problem_group.id::text as node_key,
  'SemanticProblemGroup'::text as node_type,
  problem_group.id as entity_id,
  coalesce(problem_group.rule_code, problem_group.aggregation_value) as label,
  'workflow'::text as layer,
  jsonb_build_object(
    'researchRunId', problem_group.research_run_id,
    'aggregationBasis', problem_group.aggregation_basis,
    'aggregationValue', problem_group.aggregation_value,
    'ruleCode', problem_group.rule_code,
    'problemCount', problem_group.problem_count,
    'affectedProductCount', problem_group.affected_product_count,
    'affectedClaimCount', problem_group.affected_claim_count,
    'affectedSetFingerprint', problem_group.affected_set_fingerprint,
    'reviewWorkItemId', problem_group.review_work_item_id,
    'humanActionable', coalesce(problem_group.human_actionable, false)
  ) as properties
from public.catalog_semantic_problem_groups_v1 problem_group;

create or replace view public.graph_semantic_problem_group_edges_v1
with (security_invoker = true) as
select
  'semantic-problem-review:' || problem_group.review_work_item_id::text as edge_key,
  'semantic_problem_group:' || problem_group.id::text as source_key,
  'ESCALATED_AS'::text as predicate,
  'review_work:' || problem_group.review_work_item_id::text as target_key,
  'workflow'::text as layer,
  jsonb_build_object(
    'aggregationBasis', problem_group.aggregation_basis,
    'affectedSetFingerprint', problem_group.affected_set_fingerprint
  ) as properties
from public.catalog_semantic_problem_groups_v1 problem_group
where problem_group.review_work_item_id is not null;

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select
  node.node_key,
  node.node_type,
  node.entity_id,
  node.label,
  node.layer,
  node.properties,
  md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|' || node.label || '|' || node.properties::text)
    as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all select * from public.graph_identity_case_nodes_v1
  union all select * from public.graph_review_work_nodes_v1
  union all select * from public.graph_semantic_term_nodes_v1
  union all select * from public.graph_semantic_problem_group_nodes_v1
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
  md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|' || edge.target_key || '|' || edge.layer || '|' || edge.properties::text)
    as projection_fingerprint
from (
  select * from public.graph_edges_v2_base where edge_key not like 'reference-match:%'
  union all select * from public.graph_identity_case_edges_v1
  union all select * from public.graph_review_work_edges_v1
  union all select * from public.graph_semantic_term_edges_v1
  union all select * from public.graph_semantic_problem_group_edges_v1
) edge;

alter table public.catalog_semantic_problem_groups enable row level security;
alter table public.catalog_semantic_problems enable row level security;

create policy "admins read semantic problem groups"
on public.catalog_semantic_problem_groups for select to authenticated
using (public.is_admin(auth.uid()));
create policy "admins read semantic problems"
on public.catalog_semantic_problems for select to authenticated
using (public.is_admin(auth.uid()));

grant select on public.catalog_semantic_problem_groups,
  public.catalog_semantic_problems,
  public.catalog_semantic_problem_groups_v1,
  public.catalog_semantic_campaign_funnel_v1,
  public.catalog_semantic_scaling_v1,
  public.graph_semantic_problem_group_nodes_v1,
  public.graph_semantic_problem_group_edges_v1
to authenticated, service_role;
grant insert, update on public.catalog_semantic_problem_groups,
  public.catalog_semantic_problems to service_role;

revoke all on function public.validate_catalog_semantic_problem_group()
from public, anon, authenticated;
revoke all on function public.validate_catalog_semantic_review_work()
from public, anon, authenticated;
revoke all on function public.register_catalog_semantic_problem_v1(
  uuid,text,uuid,text,text,text,text,text,text,uuid,boolean,boolean,text,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.register_catalog_semantic_problem_v1(
  uuid,text,uuid,text,text,text,text,text,text,uuid,boolean,boolean,text,text,text,jsonb
) to service_role;
revoke all on function public.escalate_catalog_semantic_problem_group_v1(uuid,text,text,text,text)
from public, anon, authenticated;
grant execute on function public.escalate_catalog_semantic_problem_group_v1(uuid,text,text,text,text)
to service_role;
revoke execute on function public.get_catalog_semantic_campaign_report_v1(uuid)
from public, anon;
grant execute on function public.get_catalog_semantic_campaign_report_v1(uuid)
to authenticated, service_role;

comment on table public.catalog_semantic_problem_groups is
  'Problemas semanticos compartidos agregados por regla, tipo, dimension o causa; una particion adicional exige justificacion.';
comment on table public.catalog_semantic_problems is
  'Detecciones individuales que permanecen fuera de Mesa y pertenecen obligatoriamente a un conjunto agregado.';
comment on function public.escalate_catalog_semantic_problem_group_v1(uuid,text,text,text,text) is
  'Crea como maximo una excepcion humana activa por conjunto y solo si una decision esta bloqueada y exige criterio humano.';
comment on view public.catalog_semantic_campaign_funnel_v1 is
  'Embudo obligatorio: productos investigados -> claims -> problemas -> grupos -> reglas -> excepciones humanas.';
comment on view public.catalog_semantic_scaling_v1 is
  'Compara crecimiento acumulado de excepciones humanas con el Universo de Referencia.';

commit;
