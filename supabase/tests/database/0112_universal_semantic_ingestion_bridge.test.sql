begin;

select plan(30);

select has_function('public','materialize_catalog_observation_semantic_claim_v1',array['uuid'],
  '1 - 0109 source claims have an epistemic bridge');
select trigger_is('public','catalog_observation_semantic_terms',
  'catalog_observation_semantic_terms_materialize_epistemic_chain',
  'public','materialize_catalog_observation_semantic_claim_trigger',
  '2 - every semantic link enters the universal chain automatically');
select has_view('public','catalog_semantic_contract_violations_v1',
  '3 - missing bridge materialization fails closed');

create temporary table semantic_bridge_brand as
select id from public.brands order by id limit 1;

insert into public.catalog_sources(
  id,source_key,name,authority,adapter,base_url,brand_id,metadata
)
select '11200000-0000-4000-8000-000000000001','semantic-bridge-official',
       'Synthetic official semantic source','official','html',
       'https://semantic-bridge.invalid',id,'{"synthetic":true}'
from semantic_bridge_brand;
insert into public.catalog_source_snapshots(
  id,source_id,status,completed_at,content_hash,metadata
) values (
  '11200000-0000-4000-8000-000000000002',
  '11200000-0000-4000-8000-000000000001','succeeded',now(),
  'semantic-bridge-snapshot','{"synthetic":true}'
);
insert into public.catalog_source_records(
  id,snapshot_id,source_id,entity_type,external_id,title,normalized_name,
  source_url,payload,captured_at
) values (
  '11200000-0000-4000-8000-000000000003',
  '11200000-0000-4000-8000-000000000002',
  '11200000-0000-4000-8000-000000000001','product','semantic-bridge-record',
  'Synthetic technical subject','synthetic technical subject',
  'https://semantic-bridge.invalid/subject','{"benefit":"Declared strengthening support."}',now()
);
insert into public.catalog_research_runs(
  id,run_key,run_kind,actor_kind,actor_label,status,input_fingerprint,
  scope,metrics,errors,result
) values (
  '11200000-0000-4000-8000-000000000004','semantic-bridge-pgtap',
  'targeted','system','pgTAP 0112','running','semantic-bridge-input',
  '{"synthetic":true}','{}','[]','{}'
);
insert into public.catalog_reference_products(
  id,reference_key,brand_id,primary_source_id,primary_source_record_id,
  primary_external_id,name,normalized_name,family,product_type,source_url,
  identity_fingerprint,content_fingerprint,first_seen_run_id,last_seen_run_id,
  first_seen_at,last_seen_at
)
select '11200000-0000-4000-8000-000000000005','semantic-bridge-reference',id,
  '11200000-0000-4000-8000-000000000001','11200000-0000-4000-8000-000000000003',
  'semantic-bridge-reference','Synthetic technical subject','synthetic technical subject',
  'Synthetic family','Synthetic type','https://semantic-bridge.invalid/subject',
  'semantic-bridge-identity','semantic-bridge-content',
  '11200000-0000-4000-8000-000000000004','11200000-0000-4000-8000-000000000004',now(),now()
from semantic_bridge_brand;

select is((select authority_level from public.resolve_catalog_source_authority_v1(
  '11200000-0000-4000-8000-000000000001','semantic.benefit','description','benefit')),
  'acceptable','4 - semantic authority is resolved by source kind and predicate');

insert into public.catalog_semantic_terms(
  id,dimension,code,label,metadata
) values (
  '11200000-0000-4000-8000-000000000006','benefit','synthetic_strengthening',
  'Strengthening declared','{"synthetic":true}'
);
insert into public.catalog_observations(
  id,observation_key,source_record_id,research_run_id,reference_product_id,
  observation_kind,predicate,value_json,observed_at,extraction_method,
  extractor,confidence,metadata
) values (
  '11200000-0000-4000-8000-000000000007','semantic-bridge-observation',
  '11200000-0000-4000-8000-000000000003','11200000-0000-4000-8000-000000000004',
  '11200000-0000-4000-8000-000000000005','semantic_claim','semantic.benefit',
  '{"ruleCode":"benefit:synthetic-strengthening","termCode":"synthetic_strengthening","termLabel":"Strengthening declared","claimKind":"manufacturer_declared","claimStatus":"source_claim","sourceField":"description","sourceValue":"Declared strengthening support.","sourceExcerpt":"Declared strengthening support.","evidenceFingerprint":"semantic-bridge-evidence","rawStorageReference":"raw://semantic-bridge/subject","metadata":{}}',
  now(),'official_page','synthetic-semantic-normalizer-v1',0.95,'{"synthetic":true}'
);
select is((select count(*) from public.catalog_observations
  where id='11200000-0000-4000-8000-000000000007'),1::bigint,
  '5 - literal source observation is persisted before interpretation');
select lives_ok($$
  insert into public.catalog_observation_semantic_terms(
    observation_id,semantic_term_id,normalization_status,
    normalization_method,confidence,metadata
  ) values (
    '11200000-0000-4000-8000-000000000007',
    '11200000-0000-4000-8000-000000000006','observed',
    'synthetic-semantic-normalizer-v1',0.94,'{"synthetic":true}'
  )
$$,'6 - linking vocabulary automatically materializes the epistemic chain');
select is((select count(*) from public.catalog_semantic_claims
  where source_observation_id='11200000-0000-4000-8000-000000000007'),2::bigint,
  '7 - one source link yields one literal and one normalized claim');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key='literal-observation:11200000-0000-4000-8000-000000000007'),
  'OBSERVATION_LITERAL','8 - source text is explicitly literal');
select is((select epistemic_class from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'NORMALIZED_SOURCE_CLAIM','9 - vocabulary interpretation is explicitly normalized');
select is((select value_json->>'sourceValue' from public.catalog_semantic_claims
  where claim_key='literal-observation:11200000-0000-4000-8000-000000000007'),
  'Declared strengthening support.','10 - literal value never impersonates the normalized term');
select is((select value_json->>'termCode' from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'synthetic_strengthening','11 - normalized claim points to controlled vocabulary');
select is((select result from public.catalog_claim_entailments entailment
  join public.catalog_semantic_claims claim on claim.id=entailment.claim_id
  where claim.claim_key='literal-observation:11200000-0000-4000-8000-000000000007'),
  'passed','12 - literal observation has entailment');
select is((select result from public.catalog_claim_entailments entailment
  join public.catalog_semantic_claims claim on claim.id=entailment.claim_id
  where claim.claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'passed','13 - normalized source claim has entailment');
select matches((select rule_code from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  '^NORMALIZE_BENEFIT_SYNTHETIC_STRENGTHENING_[A-F0-9]{8}$',
  '14 - source normalizer rule becomes a stable universal rule code');
select is((select rule_version from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),1,
  '15 - normalized claim records rule version');
select is((select rule.rule_family from public.catalog_semantic_claims claim
  join public.catalog_semantic_rules rule
    on rule.rule_code=claim.rule_code and rule.rule_version=claim.rule_version
  where claim.claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'NORMALIZATION','16 - bridge uses normalization rather than derivation');
select is((select cardinality(execution.input_claim_ids)
  from public.catalog_semantic_claims claim
  join public.catalog_semantic_rule_executions execution on execution.id=claim.rule_execution_id
  where claim.claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),1,
  '17 - rule execution names its literal input');
select ok((select source_snapshot_id is not null and source_record_id is not null
  and source_excerpt='Declared strengthening support.'
  from public.catalog_semantic_claims claim
  where claim.claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  '18 - normalized claim preserves full source provenance');
select is((select count(*) from public.catalog_semantic_claims
  where source_observation_id='11200000-0000-4000-8000-000000000007'
    and epistemic_class='CANONICAL_FACT'),0::bigint,
  '19 - ingestion never promotes source vocabulary to canonical fact');
select is((select count(*) from public.catalog_review_work_items
  where context->>'sourceObservationId'='11200000-0000-4000-8000-000000000007'),0::bigint,
  '20 - ingestion never opens Mesa work');
select is((select count(*) from public.catalog_semantic_contract_violations_v1),0::bigint,
  '21 - active source link has a complete epistemic chain');
select is((select count(*) from public.graph_universal_semantic_nodes_v1
  where entity_id in (select id from public.catalog_semantic_claims
    where source_observation_id='11200000-0000-4000-8000-000000000007')),2::bigint,
  '22 - graph contains both epistemic nodes');
select is((select count(*) from public.graph_universal_semantic_edges_v1 edge
  where edge.predicate='DERIVES_TO'
    and edge.source_key like 'semantic_claim:%'
    and edge.target_key like 'semantic_claim:%'
    and edge.target_key='semantic_claim:' || (select id::text from public.catalog_semantic_claims
      where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007')),1::bigint,
  '23 - graph explains literal to normalized lineage');
select is((select authority_level from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'acceptable','24 - normalized claim carries predicate-scoped authority');

select lives_ok($$
  update public.catalog_observation_semantic_terms set normalization_status='rejected'
  where observation_id='11200000-0000-4000-8000-000000000007'
$$,'25 - rejecting vocabulary re-materializes state');
select is((select claim_status from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'REJECTED','26 - rejected interpretation is explicit');
select is((select claim_status from public.catalog_semantic_claims
  where claim_key='literal-observation:11200000-0000-4000-8000-000000000007'),
  'ASSERTED','27 - rejecting normalization never rejects literal evidence');
select lives_ok($$
  update public.catalog_observation_semantic_terms set normalization_status='reviewed'
  where observation_id='11200000-0000-4000-8000-000000000007'
$$,'28 - reviewed vocabulary can restore the normalized assertion');
select is((select claim_status from public.catalog_semantic_claims
  where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  'ASSERTED','29 - reviewed interpretation is asserted through existing entailment');
select is((select public.materialize_catalog_observation_semantic_claim_v1(
  '11200000-0000-4000-8000-000000000007')),
  (select id from public.catalog_semantic_claims
   where claim_key='normalized-semantic-link:11200000-0000-4000-8000-000000000007'),
  '30 - materialization is idempotent and returns the existing normalized claim');

select * from finish();
rollback;
