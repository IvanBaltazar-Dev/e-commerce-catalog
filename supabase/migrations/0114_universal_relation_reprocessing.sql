-- ---------------------------------------------------------------------------
-- 0114 · Reprocesamiento universal de relaciones historicas
-- ---------------------------------------------------------------------------
-- El motor congela las candidatas diferidas, reconstruye su contexto y produce
-- una clasificacion explicable. El apply solo activa el analisis congelado: no
-- aprueba, rechaza ni promueve conocimiento en las tablas canonicas.

begin;

create table public.catalog_relation_endpoint_profiles (
  code text primary key,
  proposed_class_code text not null,
  system_code_hint text,
  stage_code_hint text,
  role_code_hint text,
  name_pattern text not null,
  exclusion_pattern text,
  description text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_relation_endpoint_profiles_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint catalog_relation_endpoint_profiles_class_format check (proposed_class_code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_relation_endpoint_profiles_hints_format check (
    (system_code_hint is null or system_code_hint ~ '^[A-Z][A-Z0-9_]*$')
    and (stage_code_hint is null or stage_code_hint ~ '^[A-Z][A-Z0-9_]*$')
    and (role_code_hint is null or role_code_hint ~ '^[A-Z][A-Z0-9_]*$')
  ),
  constraint catalog_relation_endpoint_profiles_patterns_not_blank check (
    length(trim(name_pattern)) > 0
    and (exclusion_pattern is null or length(trim(exclusion_pattern)) > 0)
  ),
  constraint catalog_relation_endpoint_profiles_description_not_blank check (length(trim(description)) > 0),
  constraint catalog_relation_endpoint_profiles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_relation_endpoint_profiles(
  code, proposed_class_code, system_code_hint, stage_code_hint, role_code_hint,
  name_pattern, exclusion_pattern, description
) values
  ('drill', 'NAIL_DRILL_EQUIPMENT', 'NAIL_DRILL', 'OPERATION', 'EQUIPMENT',
   '(^| )(drill|torno)( |$)', '(broca|brocas|repuesto|lima en disco)',
   'Equipo motorizado de torno o drill; no incluye brocas ni repuestos.'),
  ('drill_bit', 'NAIL_DRILL_BIT', 'NAIL_DRILL', 'OPERATION', 'CONSUMABLE',
   '(^| )(broca|brocas|punta|lima en disco)( |$)', null,
   'Broca, punta o consumible que trabaja con un torno de unas.'),
  ('gel_color', 'GEL_COLOR_PRODUCT', 'GEL_COLOR', 'COLOR', 'COLOR_COMPONENT',
   '(esmalte gel|gel evolution)', '(base|top|removedor)',
   'Color gel o semipermanente; excluye bases, tops y removedores.'),
  ('gel_base', 'GEL_BASE_PRODUCT', 'GEL_COLOR', 'BASE', 'ADHESION_AGENT',
   '(base coat|gel base|foundation)', '(top|finish)',
   'Base declarada para un proceso gel.'),
  ('gel_top', 'GEL_TOP_PRODUCT', 'GEL_COLOR', 'FINISHING', 'FINISHING_PRODUCT',
   '(top|brillo gel|sellante)', '(base coat|gel base)',
   'Top, brillo o sellante de finalizacion.'),
  ('lamp_uv_led', 'UV_LED_CURING_LAMP', 'UV_LED_CURING', 'CURING', 'EQUIPMENT',
   '(lampara uv|lampara led|cabina uv|cabina led)', '(guante|media luna|de mesa|iluminacion)',
   'Equipo UV o LED que declara capacidad de curado; no es iluminacion ni proteccion.'),
  ('lash_extension', 'PROFESSIONAL_LASH_EXTENSION', 'LASH_EXTENSION', 'APPLICATION', 'COMPONENT',
   '(pestana|pestanas)', '(pegamento|adhesivo|removedor|sellador|c/pega)',
   'Extension profesional; no incluye adhesivo, removedor o kit mixto.'),
  ('lash_adhesive', 'PROFESSIONAL_LASH_ADHESIVE', 'LASH_EXTENSION', 'ADHESION', 'ADHESION_AGENT',
   '((pegamento|adhesivo).*(pestana|pestanas)|(pestana|pestanas).*(pegamento|adhesivo))',
   '(banda|tira)', 'Adhesivo declarado para extension profesional, no para pestana en tira.'),
  ('lash_remover', 'PROFESSIONAL_LASH_REMOVER', 'LASH_EXTENSION', 'REMOVAL', 'REMOVAL_PRODUCT',
   '((removedor).*(pestana|pestanas)|(pestana|pestanas).*removedor)', null,
   'Removedor declarado para adhesivo o extension de pestanas.'),
  ('polygel', 'POLYGEL_CONSTRUCTION_PRODUCT', 'POLYGEL', 'CONSTRUCTION', 'CONSTRUCTION_COMPONENT',
   '(polygel|poligel|gel constructor|builder|rubber gel|gel solido)',
   '(pincel|gancho|slip solution|dilusor|acry shape|press gel|fixing nail)',
   'Componente constructor polygel; excluye herramientas, diluyentes y adhesivos.'),
  ('slip_solution', 'POLYGEL_SLIP_SOLUTION', 'POLYGEL', 'APPLICATION', 'APPLICATION_AID',
   '(slip solution|dilusor.*poligel|acry shape)', null,
   'Solucion o diluyente declarado para modelar polygel.'),
  ('soft_gel_tips', 'SOFT_GEL_TIP', 'SOFT_GEL', 'EXTENSION', 'EXTENSION_SUPPORT',
   '((tip|tips|una|unas).*soft gel|gelly tips)', '(pegamento|adhesivo|press gel|dual sistem)',
   'Tip declarado como soft gel; excluye adhesivos y moldes duales.'),
  ('nail_adhesive', 'NAIL_EXTENSION_ADHESIVE', 'SOFT_GEL', 'ADHESION', 'ADHESION_AGENT',
   '(adhesivo|pegamento|press gel)', '(joyeria|pestana|pestanas)',
   'Adhesivo para extension de unas; excluye joyeria y pestanas.'),
  ('wax', 'DEPILATORY_WAX', 'WAX_DEPILATION', 'PREPARATION', 'COMPONENT',
   '(^| )(cera|wax)( |$)', null,
   'Cera o material depilatorio que requiere preparacion termica.'),
  ('wax_warmer', 'WAX_HEATING_EQUIPMENT', 'WAX_DEPILATION', 'HEATING', 'EQUIPMENT',
   '(termostato|calentador|olla.*cera|heater)', null,
   'Equipo destinado a calentar cera depilatoria.');

create table public.catalog_relation_reprocess_profiles (
  candidate_rule_code text primary key,
  source_endpoint_code text not null references public.catalog_relation_endpoint_profiles(code) on update cascade,
  target_endpoint_code text not null references public.catalog_relation_endpoint_profiles(code) on update cascade,
  relation_kind_code text not null references public.catalog_relation_kinds(code) on update cascade,
  reverse_direction boolean not null default false,
  description text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_relation_reprocess_profiles_rule_not_blank check (length(trim(candidate_rule_code)) > 0),
  constraint catalog_relation_reprocess_profiles_description_not_blank check (length(trim(description)) > 0),
  constraint catalog_relation_reprocess_profiles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_relation_reprocess_profiles(
  candidate_rule_code, source_endpoint_code, target_endpoint_code, relation_kind_code,
  reverse_direction, description
) values
  ('drill->drill_bit', 'drill', 'drill_bit', 'COMPATIBLE_WITH', false, 'Compatibilidad estricta entre equipo y broca.'),
  ('gel_color->gel_base', 'gel_color', 'gel_base', 'PRECEDES', true, 'La base precede al color; la candidata historica viene invertida.'),
  ('gel_color->gel_top', 'gel_color', 'gel_top', 'PRECEDES', false, 'El color precede al top dentro del proceso gel.'),
  ('gel_color->lamp_uv_led', 'gel_color', 'lamp_uv_led', 'REQUIRES', false, 'El producto gel requiere capacidad de curado UV o LED.'),
  ('lash_extension->lash_adhesive', 'lash_extension', 'lash_adhesive', 'REQUIRES', false, 'La extension profesional requiere adhesivo apropiado.'),
  ('lash_extension->lash_remover', 'lash_extension', 'lash_remover', 'COMPLEMENTS', false, 'El removedor complementa el proceso de extension.'),
  ('polygel->gel_base', 'polygel', 'gel_base', 'PRECEDES', true, 'La base precede al componente constructor polygel.'),
  ('polygel->gel_top', 'polygel', 'gel_top', 'PRECEDES', false, 'El componente constructor precede al top.'),
  ('polygel->lamp_uv_led', 'polygel', 'lamp_uv_led', 'REQUIRES', false, 'El polygel curable requiere capacidad UV o LED.'),
  ('polygel->slip_solution', 'polygel', 'slip_solution', 'REQUIRES', false, 'El modelado puede requerir solucion de deslizamiento.'),
  ('soft_gel_tips->lamp_uv_led', 'soft_gel_tips', 'lamp_uv_led', 'REQUIRES', false, 'El proceso soft gel curable requiere capacidad UV o LED.'),
  ('soft_gel_tips->nail_adhesive', 'soft_gel_tips', 'nail_adhesive', 'REQUIRES', false, 'El tip soft gel requiere adhesivo apropiado.'),
  ('wax->wax_warmer', 'wax', 'wax_warmer', 'REQUIRES', false, 'La cera requiere equipo de calentamiento apropiado.');

create or replace function public.catalog_relation_endpoint_match_v1(
  p_product_name text,
  p_endpoint_code text
)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when profile.code is null then 'NO_PROFILE'
    when profile.exclusion_pattern is not null
      and public.search_normalize(coalesce(p_product_name, '')) ~ profile.exclusion_pattern
      then 'EXCLUDED'
    when public.search_normalize(coalesce(p_product_name, '')) ~ profile.name_pattern
      then 'MATCH'
    else 'NO_MATCH'
  end
  from (select p_endpoint_code as requested_code) requested
  left join public.catalog_relation_endpoint_profiles profile
    on profile.code = requested.requested_code and profile.is_active;
$function$;

create table public.catalog_relation_reprocess_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'previewed',
  engine_version text not null default 'stage4b-v1',
  expected_candidate_count integer not null,
  snapshot_fingerprint text not null,
  preview_fingerprint text,
  preview_idempotency_key text not null unique,
  application_idempotency_key text unique,
  metrics jsonb not null default '{}'::jsonb,
  metrics_after jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint catalog_relation_reprocess_runs_status_allowed check (
    status in ('previewed', 'applied', 'expired', 'superseded', 'cancelled')
  ),
  constraint catalog_relation_reprocess_runs_expected_positive check (expected_candidate_count > 0),
  constraint catalog_relation_reprocess_runs_fingerprints check (
    length(snapshot_fingerprint) = 64
    and (preview_fingerprint is null or length(preview_fingerprint) = 64)
  ),
  constraint catalog_relation_reprocess_runs_metrics_objects check (
    jsonb_typeof(metrics) = 'object'
    and (metrics_after is null or jsonb_typeof(metrics_after) = 'object')
  ),
  constraint catalog_relation_reprocess_runs_apply_consistent check (
    (status = 'applied' and application_idempotency_key is not null and applied_at is not null and metrics_after is not null)
    or (status <> 'applied' and applied_at is null)
  )
);

create table public.catalog_relation_reprocess_items (
  id bigint generated always as identity primary key,
  reprocess_run_id uuid not null references public.catalog_relation_reprocess_runs(id) on delete restrict,
  candidate_id uuid not null references public.catalog_relation_candidates(id) on delete restrict,
  ordinal integer not null,
  candidate_rule_code text,
  relation_kind_code text references public.catalog_relation_kinds(code) on update cascade,
  classification text not null,
  epistemic_result text not null,
  source_snapshot jsonb not null,
  context_snapshot jsonb not null,
  proposed_resolution jsonb not null,
  explanation jsonb not null,
  item_fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (reprocess_run_id, candidate_id),
  unique (reprocess_run_id, ordinal),
  constraint catalog_relation_reprocess_items_ordinal_positive check (ordinal > 0),
  constraint catalog_relation_reprocess_items_classification_allowed check (classification in (
    'CLASS_MEMBERSHIP', 'CLASS_RELATION', 'GENUINE_PAIR_RELATION',
    'NEEDS_EVIDENCE', 'CONTRADICTED', 'UNKNOWN', 'REJECTED'
  )),
  constraint catalog_relation_reprocess_items_epistemic_allowed check (epistemic_result in (
    'SOURCE_CLAIM', 'DERIVED_INFERRED', 'NEEDS_EVIDENCE',
    'CONTRADICTED', 'UNKNOWN', 'REJECTED'
  )),
  constraint catalog_relation_reprocess_items_json_objects check (
    jsonb_typeof(source_snapshot) = 'object'
    and jsonb_typeof(context_snapshot) = 'object'
    and jsonb_typeof(proposed_resolution) = 'object'
    and jsonb_typeof(explanation) = 'object'
  ),
  constraint catalog_relation_reprocess_items_fingerprint check (length(item_fingerprint) = 64)
);

create index catalog_relation_reprocess_items_classification_idx
  on public.catalog_relation_reprocess_items(reprocess_run_id, classification, candidate_rule_code);

create or replace function public.prevent_catalog_relation_reprocess_item_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'El preview universal de relaciones es inmutable; genere otra fotografia.';
end;
$function$;

create trigger catalog_relation_reprocess_items_immutable
before update or delete on public.catalog_relation_reprocess_items
for each row execute function public.prevent_catalog_relation_reprocess_item_mutation();

create or replace function public.catalog_relation_reprocess_state_fingerprint_v1()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_array(
        candidate.id, candidate.source_product_id, candidate.target_product_id,
        candidate.relation_type, candidate.confidence, candidate.status,
        candidate.rule_code, candidate.rationale, candidate.evidence,
        source.name, source.product_type, source.requires_lamp, source_category.name,
        target.name, target.product_type, target.requires_lamp, target_category.name
      ) order by candidate.id)
      from public.catalog_relation_candidates candidate
      join public.products source on source.id = candidate.source_product_id
      join public.categories source_category on source_category.id = source.category_id
      join public.products target on target.id = candidate.target_product_id
      join public.categories target_category on target_category.id = target.category_id
      where candidate.status = 'needs_evidence'
        and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
    ), '[]'::jsonb),
    'endpointProfiles', coalesce((
      select jsonb_agg(jsonb_build_array(
        profile.code, profile.proposed_class_code, profile.system_code_hint,
        profile.stage_code_hint, profile.role_code_hint, profile.name_pattern,
        profile.exclusion_pattern, profile.is_active
      ) order by profile.code)
      from public.catalog_relation_endpoint_profiles profile
    ), '[]'::jsonb),
    'relationProfiles', coalesce((
      select jsonb_agg(jsonb_build_array(
        profile.candidate_rule_code, profile.source_endpoint_code,
        profile.target_endpoint_code, profile.relation_kind_code,
        profile.reverse_direction, profile.is_active
      ) order by profile.candidate_rule_code)
      from public.catalog_relation_reprocess_profiles profile
    ), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_array(
        membership.id, membership.product_id, class.code,
        membership.decision_status, membership.origin, membership.evidence_set_id,
        membership.metadata
      ) order by membership.id)
      from public.catalog_class_members membership
      join public.catalog_classes class on class.id = membership.class_id
      where membership.product_id in (
        select candidate.source_product_id from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
        union
        select candidate.target_product_id from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
      )
    ), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(jsonb_build_array(
        claim.id, claim.subject_ref, claim.predicate, claim.dimension_code,
        claim.epistemic_class, claim.authority_level, claim.claim_status,
        claim.claim_fingerprint
      ) order by claim.id)
      from public.catalog_semantic_claims claim
      where claim.subject_ref in (
        select 'product:' || candidate.source_product_id::text
        from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
        union
        select 'product:' || candidate.target_product_id::text
        from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
      )
    ), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex');
$function$;

create or replace view public.catalog_relation_reprocess_plan_v1
with (security_invoker = true) as
with base as (
  select
    candidate.id as candidate_id,
    candidate.source_product_id,
    candidate.target_product_id,
    candidate.relation_type::text as legacy_relation_type,
    candidate.confidence,
    candidate.rule_code as historical_rule_code,
    candidate.rationale,
    candidate.evidence,
    source.name as source_name,
    source.product_type as source_product_type,
    source.requires_lamp as source_requires_lamp,
    source_category.name as source_category,
    target.name as target_name,
    target.product_type as target_product_type,
    target.requires_lamp as target_requires_lamp,
    target_category.name as target_category,
    profile.candidate_rule_code,
    profile.source_endpoint_code,
    profile.target_endpoint_code,
    profile.relation_kind_code,
    profile.reverse_direction,
    source_endpoint.proposed_class_code as expected_source_class_code,
    source_endpoint.system_code_hint as source_system_hint,
    source_endpoint.stage_code_hint as source_stage_hint,
    source_endpoint.role_code_hint as source_role_hint,
    target_endpoint.proposed_class_code as expected_target_class_code,
    target_endpoint.system_code_hint as target_system_hint,
    target_endpoint.stage_code_hint as target_stage_hint,
    target_endpoint.role_code_hint as target_role_hint,
    relation_kind.requires_explicit_pair_evidence,
    public.catalog_relation_endpoint_match_v1(source.name, profile.source_endpoint_code) as source_match_state,
    public.catalog_relation_endpoint_match_v1(target.name, profile.target_endpoint_code) as target_match_state
  from public.catalog_relation_candidates candidate
  join public.products source on source.id = candidate.source_product_id
  join public.categories source_category on source_category.id = source.category_id
  join public.products target on target.id = candidate.target_product_id
  join public.categories target_category on target_category.id = target.category_id
  left join public.catalog_relation_reprocess_profiles profile
    on profile.candidate_rule_code = candidate.rule_code and profile.is_active
  left join public.catalog_relation_endpoint_profiles source_endpoint
    on source_endpoint.code = profile.source_endpoint_code and source_endpoint.is_active
  left join public.catalog_relation_endpoint_profiles target_endpoint
    on target_endpoint.code = profile.target_endpoint_code and target_endpoint.is_active
  left join public.catalog_relation_kinds relation_kind
    on relation_kind.code = profile.relation_kind_code and relation_kind.is_active
  where candidate.status = 'needs_evidence'
    and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
), contextual as (
  select
    base.*,
    coalesce(source_observed.classes, '[]'::jsonb) as source_observed_classes,
    coalesce(target_observed.classes, '[]'::jsonb) as target_observed_classes,
    coalesce(source_existing.classes, '[]'::jsonb) as source_existing_classes,
    coalesce(target_existing.classes, '[]'::jsonb) as target_existing_classes,
    coalesce(source_claims.summary, jsonb_build_object('count', 0, 'claims', '[]'::jsonb)) as source_claim_summary,
    coalesce(target_claims.summary, jsonb_build_object('count', 0, 'claims', '[]'::jsonb)) as target_claim_summary,
    coalesce(pair_conflict.has_conflict, false) as has_semantic_conflict,
    case
      when base.evidence->>'explicit_pair_evidence' = 'true' then 'EXPLICIT_PAIR_EVIDENCE'
      when base.evidence ? 'source_record_id' then 'SOURCE_RECORD_DECLARED'
      when base.confidence = 'official' then 'OFFICIAL_LABEL_UNLINKED'
      else 'HEURISTIC_ONLY'
    end as authority_result,
    (base.evidence->>'explicit_pair_evidence' = 'true') as has_explicit_pair_evidence
  from base
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'endpointCode', endpoint.code,
      'classCode', endpoint.proposed_class_code,
      'systemHint', endpoint.system_code_hint,
      'stageHint', endpoint.stage_code_hint,
      'roleHint', endpoint.role_code_hint
    ) order by endpoint.code) as classes
    from public.catalog_relation_endpoint_profiles endpoint
    where endpoint.is_active
      and public.catalog_relation_endpoint_match_v1(base.source_name, endpoint.code) = 'MATCH'
  ) source_observed on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'endpointCode', endpoint.code,
      'classCode', endpoint.proposed_class_code,
      'systemHint', endpoint.system_code_hint,
      'stageHint', endpoint.stage_code_hint,
      'roleHint', endpoint.role_code_hint
    ) order by endpoint.code) as classes
    from public.catalog_relation_endpoint_profiles endpoint
    where endpoint.is_active
      and public.catalog_relation_endpoint_match_v1(base.target_name, endpoint.code) = 'MATCH'
  ) target_observed on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'classCode', class.code,
      'decisionStatus', membership.decision_status,
      'origin', membership.origin
    ) order by class.code) as classes
    from public.catalog_class_members membership
    join public.catalog_classes class on class.id = membership.class_id
    where membership.product_id = base.source_product_id
      and membership.decision_status in ('proposed', 'needs_evidence', 'approved')
  ) source_existing on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'classCode', class.code,
      'decisionStatus', membership.decision_status,
      'origin', membership.origin
    ) order by class.code) as classes
    from public.catalog_class_members membership
    join public.catalog_classes class on class.id = membership.class_id
    where membership.product_id = base.target_product_id
      and membership.decision_status in ('proposed', 'needs_evidence', 'approved')
  ) target_existing on true
  left join lateral (
    select jsonb_build_object(
      'count', count(*)::integer,
      'claims', coalesce(jsonb_agg(jsonb_build_object(
        'claimId', claim.id,
        'predicate', claim.predicate,
        'dimension', claim.dimension_code,
        'epistemicClass', claim.epistemic_class,
        'authority', claim.authority_level,
        'status', claim.claim_status
      ) order by claim.id) filter (where claim.id is not null), '[]'::jsonb)
    ) as summary
    from public.catalog_semantic_claims claim
    where claim.subject_ref = 'product:' || base.source_product_id::text
  ) source_claims on true
  left join lateral (
    select jsonb_build_object(
      'count', count(*)::integer,
      'claims', coalesce(jsonb_agg(jsonb_build_object(
        'claimId', claim.id,
        'predicate', claim.predicate,
        'dimension', claim.dimension_code,
        'epistemicClass', claim.epistemic_class,
        'authority', claim.authority_level,
        'status', claim.claim_status
      ) order by claim.id) filter (where claim.id is not null), '[]'::jsonb)
    ) as summary
    from public.catalog_semantic_claims claim
    where claim.subject_ref = 'product:' || base.target_product_id::text
  ) target_claims on true
  left join lateral (
    select exists (
      select 1
      from public.catalog_semantic_claim_relations relation
      join public.catalog_semantic_claims left_claim on left_claim.id = relation.left_claim_id
      join public.catalog_semantic_claims right_claim on right_claim.id = relation.right_claim_id
      where relation.status = 'active'
        and relation.relation_type in ('CONTRADICTS', 'EXCLUDES')
        and array[left_claim.subject_ref, right_claim.subject_ref] @>
          array['product:' || base.source_product_id::text, 'product:' || base.target_product_id::text]
    ) or base.evidence->>'relation_contradicted' = 'true' as has_conflict
  ) pair_conflict on true
), classified as (
  select
    contextual.*,
    case
      when contextual.candidate_rule_code is null or contextual.relation_kind_code is null then 'UNKNOWN'
      when contextual.has_semantic_conflict then 'CONTRADICTED'
      when contextual.source_match_state = 'MATCH'
        and contextual.target_match_state = 'MATCH'
        and contextual.requires_explicit_pair_evidence
        and contextual.has_explicit_pair_evidence then 'GENUINE_PAIR_RELATION'
      when contextual.source_match_state = 'MATCH'
        and contextual.target_match_state = 'MATCH'
        and contextual.requires_explicit_pair_evidence then 'NEEDS_EVIDENCE'
      when contextual.source_match_state = 'MATCH'
        and contextual.target_match_state = 'MATCH' then 'CLASS_RELATION'
      when (contextual.source_match_state <> 'MATCH'
          and jsonb_array_length(contextual.source_observed_classes) > 0)
        or (contextual.target_match_state <> 'MATCH'
          and jsonb_array_length(contextual.target_observed_classes) > 0) then 'CLASS_MEMBERSHIP'
      when contextual.source_match_state = 'EXCLUDED'
        or contextual.target_match_state = 'EXCLUDED' then 'REJECTED'
      else 'UNKNOWN'
    end as classification
  from contextual
), planned as (
  select
    classified.*,
    case classified.classification
      when 'GENUINE_PAIR_RELATION' then 'SOURCE_CLAIM'
      when 'CLASS_RELATION' then 'DERIVED_INFERRED'
      when 'CLASS_MEMBERSHIP' then 'DERIVED_INFERRED'
      when 'NEEDS_EVIDENCE' then 'NEEDS_EVIDENCE'
      when 'CONTRADICTED' then 'CONTRADICTED'
      when 'REJECTED' then 'REJECTED'
      else 'UNKNOWN'
    end as epistemic_result,
    jsonb_build_object(
      'candidateId', classified.candidate_id,
      'status', 'needs_evidence',
      'ruleCode', classified.historical_rule_code,
      'relationType', classified.legacy_relation_type,
      'confidence', classified.confidence,
      'rationale', classified.rationale,
      'evidence', classified.evidence,
      'source', jsonb_build_object(
        'productId', classified.source_product_id,
        'name', classified.source_name,
        'category', classified.source_category,
        'productType', classified.source_product_type,
        'requiresLamp', classified.source_requires_lamp
      ),
      'target', jsonb_build_object(
        'productId', classified.target_product_id,
        'name', classified.target_name,
        'category', classified.target_category,
        'productType', classified.target_product_type,
        'requiresLamp', classified.target_requires_lamp
      )
    ) as source_snapshot,
    jsonb_build_object(
      'source', jsonb_build_object(
        'expectedEndpoint', classified.source_endpoint_code,
        'expectedClass', classified.expected_source_class_code,
        'match', classified.source_match_state,
        'observedClasses', classified.source_observed_classes,
        'existingMemberships', classified.source_existing_classes,
        'semanticClaims', classified.source_claim_summary,
        'systemHint', classified.source_system_hint,
        'stageHint', classified.source_stage_hint,
        'roleHint', classified.source_role_hint
      ),
      'target', jsonb_build_object(
        'expectedEndpoint', classified.target_endpoint_code,
        'expectedClass', classified.expected_target_class_code,
        'match', classified.target_match_state,
        'observedClasses', classified.target_observed_classes,
        'existingMemberships', classified.target_existing_classes,
        'semanticClaims', classified.target_claim_summary,
        'systemHint', classified.target_system_hint,
        'stageHint', classified.target_stage_hint,
        'roleHint', classified.target_role_hint
      ),
      'relation', jsonb_build_object(
        'kind', classified.relation_kind_code,
        'reverseDirection', classified.reverse_direction,
        'requiresExplicitPairEvidence', classified.requires_explicit_pair_evidence,
        'hasExplicitPairEvidence', classified.has_explicit_pair_evidence,
        'signature', case when classified.reverse_direction
          then concat_ws('|', classified.expected_target_class_code,
            classified.relation_kind_code, classified.expected_source_class_code)
          else concat_ws('|', classified.expected_source_class_code,
            classified.relation_kind_code, classified.expected_target_class_code)
        end
      ),
      'authority', classified.authority_result,
      'semanticConflict', classified.has_semantic_conflict
    ) as context_snapshot,
    case classified.classification
      when 'CLASS_RELATION' then jsonb_build_object(
        'operation', 'PROPOSE_CLASS_RELATION',
        'epistemicState', 'DERIVED_INFERRED',
        'relationKind', classified.relation_kind_code,
        'sourceClass', case when classified.reverse_direction
          then classified.expected_target_class_code else classified.expected_source_class_code end,
        'targetClass', case when classified.reverse_direction
          then classified.expected_source_class_code else classified.expected_target_class_code end,
        'memberships', jsonb_build_array(
          jsonb_build_object('productId', classified.source_product_id,
            'classCode', classified.expected_source_class_code),
          jsonb_build_object('productId', classified.target_product_id,
            'classCode', classified.expected_target_class_code)
        ),
        'canonicalPromotion', false
      )
      when 'CLASS_MEMBERSHIP' then jsonb_build_object(
        'operation', 'PROPOSE_CLASS_MEMBERSHIPS_ONLY',
        'sourceProductId', classified.source_product_id,
        'sourceObservedClasses', classified.source_observed_classes,
        'targetProductId', classified.target_product_id,
        'targetObservedClasses', classified.target_observed_classes,
        'pairRelationPromoted', false,
        'canonicalPromotion', false
      )
      when 'GENUINE_PAIR_RELATION' then jsonb_build_object(
        'operation', 'PROPOSE_PAIR_RELATION',
        'relationKind', classified.relation_kind_code,
        'sourceProductId', classified.source_product_id,
        'targetProductId', classified.target_product_id,
        'canonicalPromotion', false
      )
      when 'NEEDS_EVIDENCE' then jsonb_build_object(
        'operation', 'REQUIRE_PAIR_EVIDENCE',
        'requirementKind', 'COMPATIBILITY',
        'relationKind', classified.relation_kind_code,
        'automaticDebt', true,
        'humanWorkCreated', false
      )
      when 'CONTRADICTED' then jsonb_build_object(
        'operation', 'GROUP_SEMANTIC_CONTRADICTION',
        'canonicalPromotion', false
      )
      when 'REJECTED' then jsonb_build_object(
        'operation', 'DO_NOT_PROMOTE_FALSE_PAIR',
        'candidateStatusMutated', false
      )
      else jsonb_build_object(
        'operation', 'KEEP_UNKNOWN',
        'candidateStatusMutated', false,
        'humanWorkCreated', false
      )
    end as proposed_resolution,
    jsonb_build_object(
      'engine', 'stage4b-v1',
      'path', jsonb_build_array(
        'candidate', 'subjects', 'existing_memberships', 'classes',
        'system_stage_role_context', 'semantic_claims', 'authority',
        'relation_kind', 'epistemic_result'
      ),
      'sourceMatch', classified.source_match_state,
      'targetMatch', classified.target_match_state,
      'authority', classified.authority_result,
      'reason', case classified.classification
        when 'CLASS_RELATION' then 'Ambos extremos expresan clases y la relacion no exige evidencia del par.'
        when 'CLASS_MEMBERSHIP' then 'El par no coincide con la regla, pero uno o ambos sujetos expresan otra clase reconocible.'
        when 'GENUINE_PAIR_RELATION' then 'La relacion estricta conserva evidencia explicita del par.'
        when 'NEEDS_EVIDENCE' then 'La relacion estricta coincide semanticamente, pero carece de evidencia explicita del par.'
        when 'CONTRADICTED' then 'La evidencia disponible contiene una contradiccion explicita entre los sujetos.'
        when 'REJECTED' then 'Un extremo cae en una exclusion semantica explicita del perfil esperado.'
        else 'El contexto actual no permite asignar un destino semantico estable.'
      end
    ) as explanation
  from classified
)
select
  planned.candidate_id,
  planned.candidate_rule_code,
  planned.relation_kind_code,
  planned.classification,
  planned.epistemic_result,
  planned.source_snapshot,
  planned.context_snapshot,
  planned.proposed_resolution,
  planned.explanation,
  encode(extensions.digest(convert_to(jsonb_build_object(
    'candidateId', planned.candidate_id,
    'classification', planned.classification,
    'epistemicResult', planned.epistemic_result,
    'source', planned.source_snapshot,
    'context', planned.context_snapshot,
    'resolution', planned.proposed_resolution,
    'explanation', planned.explanation
  )::text, 'UTF8'), 'sha256'), 'hex') as item_fingerprint
from planned;

create or replace function public.catalog_relation_reprocess_metrics_v1(p_run_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with items as (
    select * from public.catalog_relation_reprocess_items item
    where item.reprocess_run_id = p_run_id
  ), classification_counts as (
    select coalesce(jsonb_object_agg(classification, total order by classification), '{}'::jsonb) as value
    from (
      select classification, count(*)::integer as total
      from items group by classification
    ) grouped
  ), class_relations as (
    select
      count(*)::integer as candidate_pairs,
      count(distinct context_snapshot->'relation'->>'signature')::integer as distinct_rules
    from items where classification = 'CLASS_RELATION'
  ), memberships as (
    select distinct member.product_id, member.class_code
    from (
      select
        membership->>'productId' as product_id,
        membership->>'classCode' as class_code
      from items
      cross join lateral jsonb_array_elements(
        case when classification = 'CLASS_RELATION'
          then proposed_resolution->'memberships' else '[]'::jsonb end
      ) membership
      union all
      select
        proposed_resolution->>'sourceProductId',
        observed->>'classCode'
      from items
      cross join lateral jsonb_array_elements(
        case when classification = 'CLASS_MEMBERSHIP'
          then proposed_resolution->'sourceObservedClasses' else '[]'::jsonb end
      ) observed
      union all
      select
        proposed_resolution->>'targetProductId',
        observed->>'classCode'
      from items
      cross join lateral jsonb_array_elements(
        case when classification = 'CLASS_MEMBERSHIP'
          then proposed_resolution->'targetObservedClasses' else '[]'::jsonb end
      ) observed
    ) member
    where member.product_id is not null and member.class_code is not null
  ), totals as (
    select
      count(*)::integer as candidates,
      count(*) filter (where classification in ('CLASS_MEMBERSHIP', 'CLASS_RELATION'))::integer
        as class_expressible,
      count(*) filter (where classification = 'GENUINE_PAIR_RELATION')::integer
        as genuine_pairs,
      count(*) filter (where classification in ('NEEDS_EVIDENCE', 'CONTRADICTED', 'UNKNOWN'))::integer
        as unresolved,
      count(*) filter (where classification = 'REJECTED')::integer as rejected,
      count(*) filter (where epistemic_result = 'SOURCE_CLAIM')::integer as source_claims,
      count(*) filter (where epistemic_result = 'DERIVED_INFERRED')::integer as derived,
      count(*) filter (where epistemic_result = 'NEEDS_EVIDENCE')::integer as needs_evidence
    from items
  )
  select jsonb_build_object(
    'historicalCandidates', totals.candidates,
    'classificationCounts', classification_counts.value,
    'classVsDirect', jsonb_build_object(
      'classExpressiblePairs', totals.class_expressible,
      'classRelationCandidatePairs', class_relations.candidate_pairs,
      'distinctClassRelations', class_relations.distinct_rules,
      'distinctMemberships', (select count(*)::integer from memberships),
      'genuinePairRelations', totals.genuine_pairs,
      'unresolvedPairs', totals.unresolved,
      'rejectedPairs', totals.rejected,
      'potentialDirectPairRelationsAvoided', totals.class_expressible,
      'classRulePairCompression', greatest(class_relations.candidate_pairs - class_relations.distinct_rules, 0),
      'directPairShare', case when totals.candidates = 0 then 0
        else round(totals.genuine_pairs::numeric / totals.candidates, 4) end
    ),
    'epistemic', jsonb_build_object(
      'sourceClaims', totals.source_claims,
      'derivedInferences', totals.derived,
      'needsEvidence', totals.needs_evidence,
      'canonicalFactsCreated', 0
    ),
    'guards', jsonb_build_object(
      'candidateRowsMutated', 0,
      'canonicalPromotions', 0,
      'humanWorkItemsCreated', 0,
      'commercialEffects', 0
    )
  )
  from totals cross join classification_counts cross join class_relations;
$function$;

create or replace function public.preview_catalog_relation_reprocess_v1(
  p_idempotency_key text,
  p_expected_candidate_count integer default 323
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing public.catalog_relation_reprocess_runs%rowtype;
  created public.catalog_relation_reprocess_runs%rowtype;
  snapshot_hash text;
  preview_hash text;
  source_count integer;
  frozen_metrics jsonb;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or p_expected_candidate_count is null or p_expected_candidate_count <= 0 then
    raise exception using errcode = '22023', message = 'El preview exige clave idempotente y cantidad esperada positiva.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('catalog-relation-reprocess-stage4b-v1', 0));

  select * into existing
  from public.catalog_relation_reprocess_runs run
  where run.preview_idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'previewId', existing.id,
      'status', existing.status,
      'engineVersion', existing.engine_version,
      'snapshotFingerprint', existing.snapshot_fingerprint,
      'previewFingerprint', existing.preview_fingerprint,
      'metrics', existing.metrics,
      'idempotentReplay', true
    );
  end if;

  select count(*)::integer into source_count
  from public.catalog_relation_candidates candidate
  where candidate.status = 'needs_evidence'
    and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1';
  if source_count <> p_expected_candidate_count then
    raise exception using
      errcode = '40001',
      message = format('La cohorte historica contiene %s candidatas; se esperaban %s.',
        source_count, p_expected_candidate_count);
  end if;

  snapshot_hash := public.catalog_relation_reprocess_state_fingerprint_v1();
  insert into public.catalog_relation_reprocess_runs(
    expected_candidate_count, snapshot_fingerprint, preview_idempotency_key,
    metrics
  ) values (
    p_expected_candidate_count, snapshot_hash, p_idempotency_key,
    jsonb_build_object('historicalCandidates', source_count)
  ) returning * into created;

  insert into public.catalog_relation_reprocess_items(
    reprocess_run_id, candidate_id, ordinal, candidate_rule_code,
    relation_kind_code, classification, epistemic_result, source_snapshot,
    context_snapshot, proposed_resolution, explanation, item_fingerprint
  )
  select
    created.id, plan.candidate_id,
    row_number() over (order by plan.candidate_id)::integer,
    plan.candidate_rule_code, plan.relation_kind_code, plan.classification,
    plan.epistemic_result, plan.source_snapshot, plan.context_snapshot,
    plan.proposed_resolution, plan.explanation, plan.item_fingerprint
  from public.catalog_relation_reprocess_plan_v1 plan
  order by plan.candidate_id;

  if (select count(*) from public.catalog_relation_reprocess_items item
      where item.reprocess_run_id = created.id) <> p_expected_candidate_count then
    raise exception using errcode = '40001', message = 'El plan no cubre exactamente la cohorte congelada.';
  end if;

  select encode(extensions.digest(convert_to(coalesce(string_agg(
    concat_ws('|', item.ordinal, item.candidate_id, item.classification,
      item.epistemic_result, item.item_fingerprint), E'\n' order by item.ordinal
  ), ''), 'UTF8'), 'sha256'), 'hex')
  into preview_hash
  from public.catalog_relation_reprocess_items item
  where item.reprocess_run_id = created.id;

  frozen_metrics := public.catalog_relation_reprocess_metrics_v1(created.id);
  update public.catalog_relation_reprocess_runs
  set preview_fingerprint = preview_hash,
      metrics = frozen_metrics
  where id = created.id
  returning * into created;

  return jsonb_build_object(
    'previewId', created.id,
    'status', created.status,
    'engineVersion', created.engine_version,
    'snapshotFingerprint', created.snapshot_fingerprint,
    'previewFingerprint', created.preview_fingerprint,
    'metrics', created.metrics,
    'idempotentReplay', false
  );
end;
$function$;

create or replace function public.apply_catalog_relation_reprocess_v1(
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
  run public.catalog_relation_reprocess_runs%rowtype;
  current_snapshot text;
  current_candidates integer;
begin
  if p_preview_id is null
     or nullif(trim(coalesce(p_preview_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'Apply exige preview, huella y clave idempotente.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('catalog-relation-reprocess-stage4b-v1', 0));
  select * into run
  from public.catalog_relation_reprocess_runs current_run
  where current_run.id = p_preview_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'El preview universal no existe.';
  end if;
  if run.preview_fingerprint <> p_preview_fingerprint then
    raise exception using errcode = '40001', message = 'La huella no corresponde al preview universal congelado.';
  end if;
  if run.status = 'applied' then
    if run.application_idempotency_key <> p_idempotency_key then
      raise exception using errcode = '23505', message = 'El preview universal ya fue aplicado con otra clave.';
    end if;
    return jsonb_build_object(
      'previewId', run.id,
      'status', run.status,
      'previewFingerprint', run.preview_fingerprint,
      'metrics', run.metrics_after,
      'idempotentReplay', true,
      'knowledgePromoted', false
    );
  end if;
  if run.status <> 'previewed' then
    raise exception using errcode = '23514', message = 'El preview universal ya no puede aplicarse.';
  end if;

  current_snapshot := public.catalog_relation_reprocess_state_fingerprint_v1();
  if current_snapshot <> run.snapshot_fingerprint then
    update public.catalog_relation_reprocess_runs set status = 'expired' where id = run.id;
    raise exception using errcode = '40001', message = 'Las candidatas o su contexto cambiaron; genere un preview nuevo.';
  end if;

  select count(*)::integer into current_candidates
  from public.catalog_relation_candidates candidate
  where candidate.status = 'needs_evidence'
    and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1';
  if current_candidates <> run.expected_candidate_count then
    raise exception using errcode = '40001', message = 'La cohorte historica ya no coincide con el preview.';
  end if;

  update public.catalog_relation_reprocess_runs
  set status = 'applied',
      application_idempotency_key = p_idempotency_key,
      applied_at = now(),
      metrics_after = metrics || jsonb_build_object(
        'analyticalRowsActivated', expected_candidate_count,
        'sourceCandidatesMutated', 0,
        'knowledgePromoted', false,
        'canonicalFactsCreated', 0,
        'commercialEffects', 0
      )
  where id = run.id
  returning * into run;

  return jsonb_build_object(
    'previewId', run.id,
    'status', run.status,
    'snapshotFingerprint', run.snapshot_fingerprint,
    'previewFingerprint', run.preview_fingerprint,
    'metrics', run.metrics_after,
    'idempotentReplay', false,
    'knowledgePromoted', false
  );
end;
$function$;

create or replace function public.get_catalog_relation_reprocess_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with latest as (
    select run.* from public.catalog_relation_reprocess_runs run
    order by run.created_at desc, run.id desc limit 1
  ), by_rule as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ruleCode', grouped.candidate_rule_code,
      'relationKind', grouped.relation_kind_code,
      'classification', grouped.classification,
      'count', grouped.total
    ) order by grouped.candidate_rule_code, grouped.classification), '[]'::jsonb) as value
    from (
      select item.candidate_rule_code, item.relation_kind_code,
        item.classification, count(*)::integer as total
      from public.catalog_relation_reprocess_items item
      join latest on latest.id = item.reprocess_run_id
      group by item.candidate_rule_code, item.relation_kind_code, item.classification
    ) grouped
  )
  select jsonb_build_object(
    'contractVersion', 'stage4b-v1',
    'stage4Authorized', false,
    'scope', jsonb_build_object(
      'checkpointDeferred', 323,
      'availableHistoricalCandidates', (
        select count(*)::integer from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
      ),
      'endpointProfiles', (select count(*)::integer from public.catalog_relation_endpoint_profiles where is_active),
      'relationProfiles', (select count(*)::integer from public.catalog_relation_reprocess_profiles where is_active)
    ),
    'latestPreview', case when latest.id is null then null else jsonb_build_object(
      'previewId', latest.id,
      'status', latest.status,
      'engineVersion', latest.engine_version,
      'snapshotFingerprint', latest.snapshot_fingerprint,
      'previewFingerprint', latest.preview_fingerprint,
      'expectedCandidates', latest.expected_candidate_count,
      'metrics', latest.metrics,
      'metricsAfter', latest.metrics_after,
      'createdAt', latest.created_at,
      'appliedAt', latest.applied_at
    ) end,
    'byRule', by_rule.value,
    'guards', jsonb_build_object(
      'previewImmutable', true,
      'applyRequiresExactFingerprint', true,
      'applyPromotesKnowledge', false,
      'sourceCandidatesStillDeferred', (
        select count(*)::integer from public.catalog_relation_candidates candidate
        where candidate.status = 'needs_evidence'
          and candidate.evidence->>'generated_from' = 'catalog_process_rule_v1'
      ),
      'canonicalFactsCreated', (
        select count(*)::integer from public.catalog_semantic_claims claim
        where claim.claim_key like 'stage4b:%' and claim.epistemic_class = 'CANONICAL_FACT'
      ),
      'humanWorkPerCandidateCreated', (
        select count(*)::integer from public.catalog_review_work_items item
        where item.context->>'reprocessOrigin' = 'stage4b-relation-candidate'
      ),
      'commercialEffects', 0
    )
  )
  from (select 1) seed
  left join latest on true
  cross join by_rule;
$function$;

alter table public.catalog_relation_endpoint_profiles enable row level security;
alter table public.catalog_relation_reprocess_profiles enable row level security;
alter table public.catalog_relation_reprocess_runs enable row level security;
alter table public.catalog_relation_reprocess_items enable row level security;

create policy "admins read relation endpoint profiles"
on public.catalog_relation_endpoint_profiles for select to authenticated
using (public.is_admin(auth.uid()));
create policy "admins read relation reprocess profiles"
on public.catalog_relation_reprocess_profiles for select to authenticated
using (public.is_admin(auth.uid()));
create policy "admins read relation reprocess runs"
on public.catalog_relation_reprocess_runs for select to authenticated
using (public.is_admin(auth.uid()));
create policy "admins read relation reprocess items"
on public.catalog_relation_reprocess_items for select to authenticated
using (public.is_admin(auth.uid()));

grant select on public.catalog_relation_endpoint_profiles,
  public.catalog_relation_reprocess_profiles,
  public.catalog_relation_reprocess_runs,
  public.catalog_relation_reprocess_items,
  public.catalog_relation_reprocess_plan_v1 to authenticated, service_role;
grant insert, update, delete on public.catalog_relation_endpoint_profiles,
  public.catalog_relation_reprocess_profiles to service_role;

revoke all on function public.prevent_catalog_relation_reprocess_item_mutation()
from public, anon, authenticated;
revoke execute on function public.catalog_relation_endpoint_match_v1(text,text)
from public, anon;
revoke execute on function public.catalog_relation_reprocess_state_fingerprint_v1()
from public, anon;
revoke execute on function public.catalog_relation_reprocess_metrics_v1(uuid)
from public, anon;
revoke execute on function public.get_catalog_relation_reprocess_report_v1()
from public, anon;
grant execute on function public.catalog_relation_endpoint_match_v1(text,text),
  public.catalog_relation_reprocess_state_fingerprint_v1(),
  public.catalog_relation_reprocess_metrics_v1(uuid),
  public.get_catalog_relation_reprocess_report_v1() to authenticated, service_role;

revoke all on function public.preview_catalog_relation_reprocess_v1(text,integer)
from public, anon, authenticated;
grant execute on function public.preview_catalog_relation_reprocess_v1(text,integer)
to service_role;
revoke all on function public.apply_catalog_relation_reprocess_v1(uuid,text,text)
from public, anon, authenticated;
grant execute on function public.apply_catalog_relation_reprocess_v1(uuid,text,text)
to service_role;

create trigger catalog_relation_endpoint_profiles_set_updated_at
before update on public.catalog_relation_endpoint_profiles
for each row execute function public.set_updated_at();
create trigger catalog_relation_reprocess_profiles_set_updated_at
before update on public.catalog_relation_reprocess_profiles
for each row execute function public.set_updated_at();

comment on table public.catalog_relation_reprocess_runs is
  'Snapshots y previews explicables de las relaciones historicas; apply activa analisis, no conocimiento canonico.';
comment on table public.catalog_relation_reprocess_items is
  'Clasificacion inmutable candidate-subjects-memberships-classes-context-claims-authority-kind-result.';
comment on function public.apply_catalog_relation_reprocess_v1(uuid,text,text) is
  'Activa exactamente el preview observado sin aprobar, rechazar ni promover las candidatas fuente.';

commit;
