begin;

select plan(85);

select has_table('public','catalog_semantic_dimensions','1 - extensible dimension registry exists');
select has_table('public','catalog_semantic_rules','2 - universal rule registry exists');
select has_table('public','catalog_technical_type_profiles','3 - technical type profiles exist');
select has_table('public','catalog_technical_type_dimension_policies','4 - type dimension policies exist');
select has_table('public','catalog_source_predicate_authority','5 - source predicate authority exists');
select has_table('public','catalog_semantic_rule_executions','6 - rule executions exist');
select has_table('public','catalog_semantic_claims','7 - epistemic claims exist');
select has_table('public','catalog_claim_entailments','8 - entailment records exist');
select has_table('public','catalog_semantic_claim_relations','9 - explicit semantic relations exist');
select has_table('public','catalog_canonical_promotions','10 - canonical promotions exist');
select has_table('public','catalog_semantic_archetypes','11 - universal archetypes exist');
select has_table('public','catalog_semantic_golden_invariants','12 - golden invariants exist');
select has_table('public','catalog_semantic_certification_runs','13 - certification runs exist');
select has_table('public','catalog_semantic_certification_results','14 - certification results exist');
select has_view('public','catalog_technical_type_dimension_contract_v1','15 - inherited profile contract is queryable');
select has_view('public','catalog_semantic_claim_explanations_v1','16 - complete claim explanation is queryable');
select has_view('public','catalog_semantic_contract_violations_v1','17 - semantic violations fail closed');
select has_view('public','graph_universal_semantic_nodes_v1','18 - universal semantics project as graph nodes');
select has_view('public','graph_universal_semantic_edges_v1','19 - universal semantics project as graph edges');
select has_function('public','register_catalog_literal_claim_v1',
  array['text','uuid','text','jsonb','text','text','text','text','text','text'],
  '20 - literal claim registration is contractual');
select has_function('public','execute_catalog_semantic_rule_v1',
  array['text','integer','uuid[]','text','text','text','jsonb','numeric','jsonb'],
  '21 - rule execution is contractual');
select has_function('public','register_catalog_rule_claim_v1',
  array['text','uuid','text','text','text','text','text','text','text'],
  '22 - normalized and derived claim registration is contractual');
select has_function('public','register_catalog_claim_relation_v1',
  array['uuid','uuid','text','text','integer','text','jsonb'],
  '23 - contradiction registration is contractual');
select has_function('public','promote_catalog_canonical_claim_v1',
  array['uuid','text','text','text','text','integer','uuid','uuid'],
  '24 - canonical promotion is contractual');
select has_function('public','get_catalog_semantic_checkpoint_report_v1',array[]::text[],
  '25 - checkpoint report is queryable');

select cmp_ok((select count(*) from public.catalog_semantic_dimensions where is_active),'>=',22::bigint,
  '26 - initial dimensions are registered as data');
select is((select count(*) from public.catalog_semantic_archetypes where is_active),10::bigint,
  '27 - exactly ten universal synthetic archetypes are registered');
select is((select count(*) from public.catalog_semantic_golden_invariants where is_active),10::bigint,
  '28 - general failures are golden invariants');
select is((select count(distinct rule_family) from public.catalog_semantic_rules where is_active),8::bigint,
  '29 - all universal rule families are represented');
select is((select count(distinct applicability) from public.catalog_technical_type_dimension_policies),5::bigint,
  '30 - all five applicability states are data values');
select is((select count(*) from public.attribute_templates template
  where not exists (select 1 from public.catalog_technical_type_profiles profile
    where profile.template_id = template.id)),0::bigint,
  '31 - every operational template maps to a technical type profile');
select is((select count(*) from public.catalog_semantic_contract_violations_v1),0::bigint,
  '32 - seeded universal contract has no structural violation');

select lives_ok($$
  with dimension as (
    insert into public.catalog_semantic_dimensions(code,label,value_kind)
    values ('certification_extension','Certification extension','structured')
    returning code
  )
  insert into public.catalog_technical_type_dimension_policies(
    profile_id, dimension_code, applicability, rationale
  )
  select profile.id, dimension.code, 'optional',
         'Added entirely as data during certification.'
  from dimension
  join public.catalog_technical_type_profiles profile
    on profile.technical_type_code = 'UNIVERSAL_PRODUCT'
$$,'33 - a new dimension and policy require no schema migration');
select is((select applicability from public.catalog_technical_type_dimension_contract_v1
  where technical_type_code = 'ELECTRICAL_EQUIPMENT'
    and dimension_code = 'certification_extension'),'optional',
  '34 - child technical types inherit a newly registered dimension');

select throws_ok($$
  insert into public.catalog_semantic_rules(
    rule_code,rule_version,rule_family,description,input_predicates,
    output_predicate,output_dimension_code,scope,confidence,definition
  ) values ('ILLEGAL_BRAND_RULE',1,'DERIVATION','Illegal brand scope.',
    array['x'],'x','type','{"brand":"forbidden"}',1,'{"operation":"copy"}')
$$,'23514',null,'35 - brand-scoped semantic rules are rejected');
select throws_ok($$
  insert into public.catalog_semantic_rules(
    rule_code,rule_version,rule_family,description,input_predicates,
    output_predicate,output_dimension_code,scope,confidence,definition
  ) values ('ILLEGAL_SKU_RULE',1,'DERIVATION','Illegal SKU scope.',
    array['x'],'x','type','{}',1,'{"sku":"forbidden"}')
$$,'23514',null,'36 - SKU-specific semantic rules are rejected');

create temporary table semantic_fixture_brand as
select id from public.brands order by id limit 1;

insert into public.catalog_sources(
  id,source_key,name,authority,adapter,base_url,brand_id,metadata
)
select '11110000-0000-4000-8000-000000000001'::uuid,'semantic-cert-official',
       'Synthetic official source','official','html','https://semantic-cert.invalid/official',id,'{"synthetic":true}'::jsonb
from semantic_fixture_brand
union all
select '11110000-0000-4000-8000-000000000002'::uuid,'semantic-cert-marketplace',
       'Synthetic marketplace source','marketplace','html','https://semantic-cert.invalid/marketplace',id,'{"synthetic":true}'::jsonb
from semantic_fixture_brand;

insert into public.catalog_source_snapshots(
  id,source_id,status,completed_at,content_hash,metadata
) values
  ('11110000-0000-4000-8000-000000000011','11110000-0000-4000-8000-000000000001','succeeded',now(),'semantic-cert-official-hash','{"synthetic":true}'),
  ('11110000-0000-4000-8000-000000000012','11110000-0000-4000-8000-000000000002','succeeded',now(),'semantic-cert-market-hash','{"synthetic":true}');

insert into public.catalog_source_records(
  id,snapshot_id,source_id,entity_type,external_id,title,normalized_name,
  source_url,payload,captured_at
) values
  ('11110000-0000-4000-8000-000000000021','11110000-0000-4000-8000-000000000011',
   '11110000-0000-4000-8000-000000000001','product','official-fixture','Synthetic electrical equipment',
   'synthetic electrical equipment','https://semantic-cert.invalid/official/equipment',
   '{"type":"Electrical equipment","voltage":"110 V"}',now()),
  ('11110000-0000-4000-8000-000000000022','11110000-0000-4000-8000-000000000012',
   '11110000-0000-4000-8000-000000000002','product','market-fixture','Synthetic electrical equipment',
   'synthetic electrical equipment','https://semantic-cert.invalid/marketplace/equipment',
   '{"voltage":"220 V"}',now());

insert into public.catalog_research_runs(
  id,run_key,run_kind,actor_kind,actor_label,status,input_fingerprint,scope,metrics,errors,result
) values (
  '11110000-0000-4000-8000-000000000031','universal-semantic-pgtap','targeted','system',
  'pgTAP 0111','running','universal-semantic-pgtap-input','{"synthetic":true}','{}','[]','{}'
);

insert into public.catalog_reference_products(
  id,reference_key,brand_id,primary_source_id,primary_source_record_id,
  primary_external_id,name,normalized_name,family,product_type,source_url,
  identity_fingerprint,content_fingerprint,first_seen_run_id,last_seen_run_id,
  first_seen_at,last_seen_at
)
select '11110000-0000-4000-8000-000000000041','semantic-cert-reference',brand.id,
  '11110000-0000-4000-8000-000000000001','11110000-0000-4000-8000-000000000021',
  'semantic-cert-reference','Synthetic electrical equipment','synthetic electrical equipment',
  'Synthetic equipment','Electrical equipment','https://semantic-cert.invalid/official/equipment',
  'semantic-cert-identity','semantic-cert-content',
  '11110000-0000-4000-8000-000000000031','11110000-0000-4000-8000-000000000031',now(),now()
from semantic_fixture_brand brand;

insert into public.catalog_observations(
  id,observation_key,source_record_id,research_run_id,reference_product_id,
  observation_kind,predicate,value_json,observed_at,extraction_method,extractor,confidence,metadata
) values
  ('11110000-0000-4000-8000-000000000051','semantic-cert-voltage-official',
   '11110000-0000-4000-8000-000000000021','11110000-0000-4000-8000-000000000031',
   '11110000-0000-4000-8000-000000000041','semantic_claim','technical.voltage',
   '{"value":110,"unit":"V"}',now(),'official_page','synthetic-fixture-v1',0.99,'{"synthetic":true}'),
  ('11110000-0000-4000-8000-000000000052','semantic-cert-voltage-marketplace',
   '11110000-0000-4000-8000-000000000022','11110000-0000-4000-8000-000000000031',
   '11110000-0000-4000-8000-000000000041','semantic_claim','technical.voltage',
   '{"value":220,"unit":"V"}',now(),'official_page','synthetic-fixture-v1',0.75,'{"synthetic":true}'),
  ('11110000-0000-4000-8000-000000000053','semantic-cert-type-official',
   '11110000-0000-4000-8000-000000000021','11110000-0000-4000-8000-000000000031',
   '11110000-0000-4000-8000-000000000041','semantic_claim','identity.type',
   '{"literal":"Electrical equipment"}',now(),'official_page','synthetic-fixture-v1',1,'{"synthetic":true}');

select is((select authority_level from public.resolve_catalog_source_authority_v1(
  '11110000-0000-4000-8000-000000000001','identity.type','type','identity')),
  'preferred','37 - official identity has predicate-specific preferred authority');
select is((select authority_level from public.resolve_catalog_source_authority_v1(
  '11110000-0000-4000-8000-000000000002','technical.voltage','voltage','specification')),
  'prohibited','38 - marketplace technical authority is predicate-specifically prohibited');
select isnt((select authority_level from public.resolve_catalog_source_authority_v1(
  '11110000-0000-4000-8000-000000000001','price.retail','price','price')),
  (select authority_level from public.resolve_catalog_source_authority_v1(
  '11110000-0000-4000-8000-000000000001','identity.type','type','identity')),
  '39 - one source does not have one global authority level');

select lives_ok($$ select public.register_catalog_literal_claim_v1(
  'fixture-voltage-official','11110000-0000-4000-8000-000000000051','specification',
  '{"value":110,"unit":"V"}','ASSERTED','voltage','Rated voltage: 110 V',
  'raw://official/voltage','110 V') $$,
  '40 - a literally supported source observation becomes a literal claim');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key='fixture-voltage-official'),'OBSERVATION_LITERAL',
  '41 - literal evidence keeps the literal epistemic class');
select is((select claim_status from public.catalog_semantic_claims
  where claim_key='fixture-voltage-official'),'ASSERTED',
  '42 - literal evidence is asserted only after entailment');
select is((select result from public.catalog_claim_entailments entailment
  join public.catalog_semantic_claims claim on claim.id=entailment.claim_id
  where claim.claim_key='fixture-voltage-official'),'passed',
  '43 - source excerpt entailment is persisted');
select ok((select source_id is not null and source_snapshot_id is not null
  and source_record_id is not null and source_url is not null
  and evidence_fingerprint is not null from public.catalog_semantic_claims
  where claim_key='fixture-voltage-official'),
  '44 - complete source provenance is persisted');
select throws_ok($$ select public.register_catalog_literal_claim_v1(
  'fixture-bad-excerpt','11110000-0000-4000-8000-000000000051','specification',
  '{"value":111,"unit":"V"}','ASSERTED','voltage','No rating is shown',
  'raw://official/bad','111 V') $$,
  '23514','El texto respaldatorio no esta contenido en el excerpt de la fuente.',
  '45 - unsupported excerpts cannot assert source claims');
select is((select count(*) from public.catalog_semantic_claims where claim_key='fixture-bad-excerpt'),0::bigint,
  '46 - failed entailment leaves no asserted claim behind');

select lives_ok($$ select public.register_catalog_literal_claim_v1(
  'fixture-type-official','11110000-0000-4000-8000-000000000053','identity',
  '{"literal":"Electrical equipment"}','ASSERTED','type','Type: Electrical equipment',
  'raw://official/type','Electrical equipment') $$,
  '47 - identity observation is stored literally');
select lives_ok($$ select public.execute_catalog_semantic_rule_v1(
  'NORMALIZE_LITERAL_TERM',1,
  array[(select id from public.catalog_semantic_claims where claim_key='fixture-type-official')],
  (select subject_ref from public.catalog_semantic_claims where claim_key='fixture-type-official'),
  'semantic.normalized','type','{"term":"electrical_equipment"}',1,
  '{"operation":"casefold_and_dictionary","inferenceAdded":false}') $$,
  '48 - normalization is a persisted versioned rule execution');
select lives_ok($$ select public.register_catalog_rule_claim_v1(
  'fixture-type-normalized',
  (select id from public.catalog_semantic_rule_executions where rule_code='NORMALIZE_LITERAL_TERM' order by executed_at desc limit 1),
  'NORMALIZED_SOURCE_CLAIM','ASSERTED','type','Type: Electrical equipment',
  'raw://official/type','Electrical equipment') $$,
  '49 - entailed normalization becomes a normalized source claim');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key='fixture-type-normalized'),'NORMALIZED_SOURCE_CLAIM',
  '50 - normalization does not impersonate a literal observation');
select is((select rule_code from public.catalog_semantic_claims
  where claim_key='fixture-type-normalized'),'NORMALIZE_LITERAL_TERM',
  '51 - normalization retains rule code and version');

select lives_ok($$ select public.execute_catalog_semantic_rule_v1(
  'NORMALIZE_QUANTITY_UNIT',1,
  array[(select id from public.catalog_semantic_claims where claim_key='fixture-voltage-official')],
  (select subject_ref from public.catalog_semantic_claims where claim_key='fixture-voltage-official'),
  'semantic.quantity','specification','{"value":110,"unit":"V"}',0.99,
  '{"operation":"identity_unit_conversion","dimensionCrossing":false}') $$,
  '52 - a unit derivation has an explicit rule execution');
select lives_ok($$ select public.register_catalog_rule_claim_v1(
  'fixture-voltage-derived',
  (select id from public.catalog_semantic_rule_executions where rule_code='NORMALIZE_QUANTITY_UNIT' order by executed_at desc limit 1),
  'DERIVED_INFERRED','ASSERTED') $$,
  '53 - inferred output is registered as derived');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key='fixture-voltage-derived'),'DERIVED_INFERRED',
  '54 - derived knowledge is never labeled as source-declared');
select is((select count(*) from public.catalog_claim_entailments entailment
  join public.catalog_semantic_claims claim on claim.id=entailment.claim_id
  where claim.claim_key='fixture-voltage-derived'),0::bigint,
  '55 - entailment is not fabricated for an inferred claim');
select throws_ok($$ select public.register_catalog_rule_claim_v1(
  'fixture-illegal-derived-normalization',
  (select id from public.catalog_semantic_rule_executions where rule_code='NORMALIZE_LITERAL_TERM' order by executed_at desc limit 1),
  'DERIVED_INFERRED','ASSERTED') $$,
  '23514','Una inferencia debe declarar una familia de regla distinta de NORMALIZATION.',
  '56 - a normalization rule cannot disguise an inference');

select lives_ok($$ select public.register_catalog_literal_claim_v1(
  'fixture-voltage-marketplace','11110000-0000-4000-8000-000000000052','specification',
  '{"value":220,"unit":"V"}','ASSERTED','voltage','Rated voltage: 220 V',
  'raw://marketplace/voltage','220 V') $$,
  '57 - a second evidence chain remains independently traceable');
select lives_ok($$ select public.register_catalog_claim_relation_v1(
  (select id from public.catalog_semantic_claims where claim_key='fixture-voltage-official'),
  (select id from public.catalog_semantic_claims where claim_key='fixture-voltage-marketplace'),
  'CONTRADICTS','DETECT_CONTRADICTORY_VALUES',1,
  'The same scalar predicate has mutually incompatible values.',
  '{"synthetic":true}') $$,
  '58 - incompatible values create an explicit contradiction');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key in ('fixture-voltage-official','fixture-voltage-marketplace')
    and claim_status='CONTRADICTED'),2::bigint,
  '59 - both contradictory claims remain visible and marked');
select ok((select left_claim.value_json <> right_claim.value_json
  from public.catalog_semantic_claim_relations relation
  join public.catalog_semantic_claims left_claim on left_claim.id=relation.left_claim_id
  join public.catalog_semantic_claims right_claim on right_claim.id=relation.right_claim_id
  where relation.relation_type='CONTRADICTS'),
  '60 - contradiction preserves both incompatible values');
select throws_ok($$ select public.promote_catalog_canonical_claim_v1(
  (select id from public.catalog_semantic_claims where claim_key='fixture-voltage-official'),
  'ELECTRICAL_EQUIPMENT','RULE','Contradicted values cannot be silently promoted.',
  'PROMOTE_CANONICAL_ASSERTION',1) $$,
  '23514','Solo un claim no canonico y afirmado puede promoverse.',
  '61 - a contradicted claim cannot be promoted');

select lives_ok($$ select public.promote_catalog_canonical_claim_v1(
  (select id from public.catalog_semantic_claims where claim_key='fixture-type-normalized'),
  'ELECTRICAL_EQUIPMENT','RULE',
  'The entailed, preferred-authority type claim passes the universal rule gate.',
  'PROMOTE_CANONICAL_ASSERTION',1) $$,
  '62 - an eligible claim can cross an explicit canonical gate');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key like 'canonical:%'),'CANONICAL_FACT',
  '63 - promotion creates a distinct canonical fact');
select ok((select promotion.candidate_claim_id <> promotion.canonical_claim_id
  from public.catalog_canonical_promotions promotion
  where promotion.canonical_claim_id is not null),
  '64 - candidate and canonical fact remain separate nodes');
select is((select promotion_method from public.catalog_canonical_promotions
  where canonical_claim_id is not null),'RULE',
  '65 - canonical promotion records its gate method');

select lives_ok($$
  with states(status, ordinal) as (
    values ('UNKNOWN',1),('NOT_STATED',2),('NOT_APPLICABLE',3)
  ), executions as (
    select status, ordinal, public.execute_catalog_semantic_rule_v1(
      'APPLY_CONDITIONAL_DIMENSION',1,
      array[(select id from public.catalog_semantic_claims where claim_key='fixture-type-normalized')],
      (select subject_ref from public.catalog_semantic_claims where claim_key='fixture-type-normalized'),
      'semantic.applicability','type',null,1,
      jsonb_build_object('absenceState',status,'synthetic',true)
    ) as execution_id from states
  )
  select public.register_catalog_rule_claim_v1(
    'fixture-absence-' || lower(status), execution_id, 'DERIVED_INFERRED', status
  ) from executions
$$,'66 - UNKNOWN, NOT_STATED and NOT_APPLICABLE are first-class states');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'fixture-absence-%' and value_json is null),3::bigint,
  '67 - absence states carry no false value');
select is((select count(*) from public.catalog_review_work_items work
  where work.context->>'semanticClaimKey' like 'fixture-absence-%'),0::bigint,
  '68 - absence states create no human work');
select is((select count(*) from public.catalog_review_work_items work
  where work.context->>'semanticOrigin'='claim_contradiction'),0::bigint,
  '69 - contradiction detection alone creates no human exception');

select is((public.get_catalog_semantic_checkpoint_report_v1()->>'stage4Authorized')::boolean,false,
  '70 - checkpoint explicitly keeps Stage 4 unauthorized');
select is((select count(*) from public.catalog_semantic_contract_violations_v1),0::bigint,
  '71 - exercised semantic chain has zero fail-closed violations');
select cmp_ok((select count(*) from public.graph_universal_semantic_nodes_v1
  where node_type='SemanticClaim'),'>=',9::bigint,
  '72 - claims are projected with epistemic class');
select is((select count(*) from public.graph_universal_semantic_edges_v1
  where predicate='CONTRADICTS'),1::bigint,
  '73 - explicit contradiction is projected once');
select is((select count(*) from public.catalog_semantic_archetypes archetype
  where not exists (
    select 1 from unnest(archetype.required_capabilities) capability
    where length(trim(capability))=0
  )),10::bigint,
  '74 - all archetypes declare capability contracts');
select is((select count(*) from public.catalog_semantic_archetypes archetype
  where not exists (
    select 1 from jsonb_array_elements_text(archetype.fixture_contract->'requiredDimensions') dimension
    where not exists (select 1 from public.catalog_technical_type_dimension_contract_v1 contract
      where contract.technical_type_code=archetype.technical_type_code
        and contract.dimension_code=dimension)
  )),10::bigint,
  '75 - every archetype resolves all required dimensions from profile data');
select is((select count(*) from public.catalog_semantic_rules
  where scope::text ~* '"(brand|sku|product_id)"[[:space:]]*:'),0::bigint,
  '76 - active rule registry contains no individual scope');

select lives_ok($$
  insert into public.catalog_semantic_terms(dimension,code,label)
  values ('certification_extension','extensible_value','Extensible value')
$$,'77 - semantic vocabulary accepts a newly registered dimension');
select is((select count(*) from public.catalog_reference_semantic_coverage_v1
  where dimension='certification_extension'),1::bigint,
  '78 - semantic coverage follows the dimension registry dynamically');

select lives_ok($$
  insert into public.catalog_semantic_certification_runs(
    id,run_key,contract_version
  ) values (
    '11110000-0000-4000-8000-000000000061','pgtap-universal-certification','universal-semantic-v1'
  )
$$,'79 - certification run is persisted');
select lives_ok($$
  insert into public.catalog_semantic_certification_results(
    run_id,archetype_code,capability_code,status,evidence
  )
  select '11110000-0000-4000-8000-000000000061', archetype.archetype_code,
         capability, 'passed', jsonb_build_object('synthetic',true,'generalInvariant',true)
  from public.catalog_semantic_archetypes archetype
  cross join lateral unnest(archetype.required_capabilities) capability
$$,'80 - every archetype capability receives a result');
select is((select count(distinct archetype_code) from public.catalog_semantic_certification_results
  where run_id='11110000-0000-4000-8000-000000000061'),10::bigint,
  '81 - certification covers all ten archetypes');
select lives_ok($$
  update public.catalog_semantic_certification_runs
  set status='passed',finished_at=now(),
      metrics=jsonb_build_object('archetypes',10,'contractViolations',0),
      result_fingerprint=md5('universal-semantic-v1-pgtap')
  where id='11110000-0000-4000-8000-000000000061'
$$,'82 - passing certification closes with metrics and fingerprint');
select is((select failed from public.catalog_semantic_certification_summary_v1
  where id='11110000-0000-4000-8000-000000000061'),0::bigint,
  '83 - persisted certification has zero failed capabilities');
select is((select archetypes_covered from public.catalog_semantic_certification_summary_v1
  where id='11110000-0000-4000-8000-000000000061'),10::bigint,
  '84 - persisted summary proves ten-archetype coverage');
select is((public.get_catalog_semantic_checkpoint_report_v1()
  #>> '{latestCertification,status}'),'passed',
  '85 - checkpoint report exposes the passing certification while Stage 4 stays blocked');

select * from finish();
rollback;
