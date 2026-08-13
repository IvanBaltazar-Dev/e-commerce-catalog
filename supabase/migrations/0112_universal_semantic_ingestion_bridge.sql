-- 0112 - Puente de ingesta hacia el contrato epistemologico universal.
--
-- 0109 conserva source claims externos en observaciones + vocabulario. Este
-- puente materializa su explicacion completa sin alterar ni canonizar el dato.

begin;

insert into public.catalog_source_predicate_authority(
  source_kind, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale
) values
  ('official','TECHNICAL','semantic.*','*',null,'acceptable',0.9,
   'Official semantic source claims are acceptable only as declared, non-canonical knowledge.'),
  ('physical_packaging','TECHNICAL','semantic.*','*',null,'preferred',1,
   'Printed packaging semantics are preferred when captured literally.'),
  ('authorized_distributor','DISCOVERY','semantic.*','*',null,'acceptable',0.7,
   'Authorized distributor semantics are acceptable for discovery and corroboration.'),
  ('internal_document','TECHNICAL','semantic.*','*',null,'acceptable',0.85,
   'Controlled internal documents may support declared semantic claims.'),
  ('marketplace','DISCOVERY','semantic.*','*',null,'supplemental',0.35,
   'Marketplace semantic claims remain supplemental and cannot be promoted directly.')
on conflict do nothing;

create or replace function public.materialize_catalog_observation_semantic_claim_v1(
  p_observation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  observation public.catalog_observations%rowtype;
  link public.catalog_observation_semantic_terms%rowtype;
  term public.catalog_semantic_terms%rowtype;
  source_rule_code text;
  universal_rule_code text;
  source_excerpt text;
  source_value text;
  source_field text;
  raw_reference text;
  literal_claim_id uuid;
  execution_id uuid;
  normalized_claim_id uuid;
begin
  select * into observation from public.catalog_observations where id = p_observation_id;
  select * into link from public.catalog_observation_semantic_terms where observation_id = p_observation_id;
  select * into term from public.catalog_semantic_terms where id = link.semantic_term_id;

  if observation.id is null or link.observation_id is null or term.id is null then
    raise exception using errcode = '23503',
      message = 'La materializacion semantica exige observacion, enlace y termino persistidos.';
  end if;
  if observation.observation_kind <> 'semantic_claim' then
    raise exception using errcode = '23514',
      message = 'Solo un semantic_claim de fuente puede entrar al contrato epistemologico.';
  end if;

  source_rule_code := coalesce(observation.value_json->>'ruleCode', link.normalization_method);
  source_excerpt := nullif(trim(observation.value_json->>'sourceExcerpt'), '');
  source_value := coalesce(nullif(trim(observation.value_json->>'sourceValue'), ''), source_excerpt);
  source_field := coalesce(
    nullif(trim(observation.value_json->>'sourceField'), ''),
    nullif(trim(observation.predicate), '')
  );
  raw_reference := coalesce(
    nullif(trim(observation.value_json->>'rawStorageReference'), ''),
    observation.source_record_id::text
  );
  if source_rule_code is null or source_excerpt is null or source_value is null
     or source_field is null or raw_reference is null then
    raise exception using errcode = '23514',
      message = 'El source claim semantico debe conservar regla, campo, excerpt, valor y referencia RAW.';
  end if;

  universal_rule_code := 'NORMALIZE_' || upper(regexp_replace(source_rule_code, '[^a-zA-Z0-9]+', '_', 'g'))
    || '_' || upper(substr(md5(source_rule_code), 1, 8));

  insert into public.catalog_semantic_rules(
    rule_code, rule_version, rule_family, description, input_predicates,
    output_predicate, output_dimension_code, scope, confidence, definition
  ) values (
    universal_rule_code, 1, 'NORMALIZATION',
    'Normalizes a declared source expression into one universal semantic term.',
    array[observation.predicate], observation.predicate, term.dimension,
    jsonb_build_object('dimension', term.dimension, 'predicate', observation.predicate,
      'sourceField', source_field),
    link.confidence,
    jsonb_build_object('operation', 'source_vocabulary_mapping',
      'sourceNormalizerRuleCode', source_rule_code, 'inferenceAllowed', false,
      'termCode', term.code)
  )
  on conflict (rule_code, rule_version) do update
  set confidence = greatest(public.catalog_semantic_rules.confidence, excluded.confidence),
      updated_at = now();

  select id into literal_claim_id from public.catalog_semantic_claims
  where claim_key = 'literal-observation:' || observation.id::text;
  if literal_claim_id is null then
    literal_claim_id := public.register_catalog_literal_claim_v1(
      'literal-observation:' || observation.id::text,
      observation.id,
      term.dimension,
      jsonb_build_object('sourceValue', source_value),
      'ASSERTED', source_field, source_excerpt, raw_reference,
      source_excerpt, 'semantic-ingestion-bridge-v1'
    );
  end if;

  select id into normalized_claim_id from public.catalog_semantic_claims
  where claim_key = 'normalized-semantic-link:' || observation.id::text;

  if link.normalization_status in ('rejected', 'superseded') then
    if normalized_claim_id is not null then
      update public.catalog_semantic_claims
      set claim_status = case link.normalization_status
        when 'rejected' then 'REJECTED' else 'SUPERSEDED' end,
        updated_at = now()
      where id = normalized_claim_id;
    end if;
    return literal_claim_id;
  end if;

  if normalized_claim_id is not null then
    update public.catalog_semantic_claims
    set claim_status = 'ASSERTED', last_seen_at = greatest(last_seen_at, observation.observed_at),
        updated_at = now()
    where id = normalized_claim_id;
    return normalized_claim_id;
  end if;

  execution_id := public.execute_catalog_semantic_rule_v1(
    universal_rule_code, 1, array[literal_claim_id], observation.target_ref,
    observation.predicate, term.dimension,
    jsonb_build_object('termCode', term.code, 'termLabel', term.label),
    least(observation.confidence, link.confidence),
    jsonb_build_object('sourceRuleCode', source_rule_code,
      'normalizationMethod', link.normalization_method,
      'inferenceAdded', false, 'observationId', observation.id)
  );

  normalized_claim_id := public.register_catalog_rule_claim_v1(
    'normalized-semantic-link:' || observation.id::text,
    execution_id, 'NORMALIZED_SOURCE_CLAIM', 'ASSERTED',
    source_field, source_excerpt, raw_reference, source_excerpt,
    'semantic-ingestion-bridge-v1'
  );
  return normalized_claim_id;
end;
$function$;

create or replace function public.materialize_catalog_observation_semantic_claim_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.materialize_catalog_observation_semantic_claim_v1(new.observation_id);
  return new;
end;
$function$;

create trigger catalog_observation_semantic_terms_materialize_epistemic_chain
after insert or update of semantic_term_id, normalization_status,
  normalization_method, confidence
on public.catalog_observation_semantic_terms
for each row execute function public.materialize_catalog_observation_semantic_claim_trigger();

-- Upgrade path: materialize 0109 rows that existed before this migration.
do $migration$
declare semantic_link record;
begin
  for semantic_link in
    select observation_id from public.catalog_observation_semantic_terms
    order by observation_id
  loop
    perform public.materialize_catalog_observation_semantic_claim_v1(semantic_link.observation_id);
  end loop;
end;
$migration$;

create or replace view public.catalog_semantic_contract_violations_v1
with (security_invoker = true) as
select 'ASSERTED_SOURCE_WITHOUT_ENTAILMENT'::text as violation_code,
       claim.id::text as entity_ref,
       jsonb_build_object('epistemicClass', claim.epistemic_class, 'claimKey', claim.claim_key) as details
from public.catalog_semantic_claims claim
where claim.epistemic_class in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM')
  and claim.claim_status = 'ASSERTED'
  and not exists (
    select 1 from public.catalog_claim_entailments entailment
    where entailment.claim_id = claim.id and entailment.result = 'passed'
      and not entailment.inference_required
  )
union all
select 'ACTIVE_PROFILE_WITHOUT_DIMENSION_POLICY', profile.id::text,
       jsonb_build_object('technicalTypeCode', profile.technical_type_code, 'dimension', dimension.code)
from public.catalog_technical_type_profiles profile
cross join public.catalog_semantic_dimensions dimension
where profile.is_active and dimension.is_active
  and not exists (
    select 1 from public.catalog_technical_type_dimension_contract_v1 contract
    where contract.technical_type_code = profile.technical_type_code
      and contract.dimension_code = dimension.code
  )
union all
select 'CANONICAL_WITHOUT_APPROVED_PROMOTION', claim.id::text,
       jsonb_build_object('claimKey', claim.claim_key)
from public.catalog_semantic_claims claim
where claim.epistemic_class = 'CANONICAL_FACT'
  and not exists (
    select 1 from public.catalog_canonical_promotions promotion
    where promotion.id = claim.canonical_promotion_id
      and promotion.canonical_claim_id = claim.id
      and promotion.decision_status = 'approved'
  )
union all
select 'ACTIVE_SEMANTIC_LINK_WITHOUT_EPISTEMIC_CHAIN', link.observation_id::text,
       jsonb_build_object('normalizationStatus', link.normalization_status)
from public.catalog_observation_semantic_terms link
where link.normalization_status in ('observed', 'reviewed')
  and not exists (
    select 1 from public.catalog_semantic_claims claim
    where claim.claim_key = 'normalized-semantic-link:' || link.observation_id::text
      and claim.epistemic_class = 'NORMALIZED_SOURCE_CLAIM'
      and claim.claim_status = 'ASSERTED'
  );

revoke all on function public.materialize_catalog_observation_semantic_claim_v1(uuid)
from public, anon, authenticated;
grant execute on function public.materialize_catalog_observation_semantic_claim_v1(uuid)
to service_role;
revoke all on function public.materialize_catalog_observation_semantic_claim_trigger()
from public, anon, authenticated;

comment on function public.materialize_catalog_observation_semantic_claim_v1(uuid) is
  'Bridges a 0109 source semantic observation into literal + versioned normalized claims; never creates canonical facts or Mesa work.';

commit;
