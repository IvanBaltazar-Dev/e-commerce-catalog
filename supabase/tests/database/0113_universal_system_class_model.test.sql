begin;

select plan(34);

select has_table('public','catalog_role_kinds','1 - role kinds are data-driven');
select has_table('public','catalog_relation_kinds','2 - relation kinds are data-driven');
select has_table('public','catalog_requirement_kinds','3 - requirement kinds are data-driven');
select has_table('public','catalog_system_stage_role_classes','4 - existing stage roles bridge to classes');
select has_table('public','catalog_class_requirements','5 - classes own typed requirements');
select has_table('public','catalog_stage_transitions','6 - process sequence is explicit');

select is((select count(*) from public.catalog_relation_kinds
  where code in ('REQUIRES','PRECEDES','FOLLOWS','ALTERNATIVE_TO','SUBSTITUTES_FOR',
    'EXCLUDES','COMPATIBLE_WITH','INCOMPATIBLE_WITH','COMPLEMENTS')),9::bigint,
  '7 - all nine universal relation kinds exist');
select is((select count(*) from public.catalog_requirement_kinds),6::bigint,
  '8 - requirement vocabulary covers process capability specification safety evidence and compatibility');
select is((select count(*) from public.catalog_role_kinds where is_active),10::bigint,
  '9 - closed role enum became an extensible registry');

select is((select count(*) from public.catalog_stages stage
  join public.catalog_systems system on system.id=stage.system_id
  where system.code='ACRYLIC' and stage.is_active),8::bigint,
  '10 - real Acrylic fixture has multiple detailed stages');
select is((select count(*) from public.catalog_stages stage
  join public.catalog_systems system on system.id=stage.system_id
  where system.code='ACRYLIC' and stage.code in
    ('PREPARATION','CONSTRUCTION','FINISHING','MAINTENANCE','REMOVAL')),5::bigint,
  '11 - Acrylic covers the five required macro phases');
select is((select count(*) from public.catalog_system_stage_role_classes),16::bigint,
  '12 - Acrylic roles are covered by multiple classes');
select is((select count(*) from public.catalog_class_requirements),8::bigint,
  '13 - real requirements are persisted');
select is((select count(*) from public.catalog_stage_transitions),8::bigint,
  '14 - real process sequences and branches are persisted');

select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'stage4a:literal:%' and epistemic_class='OBSERVATION_LITERAL'
    and claim_status='ASSERTED'),4::bigint,
  '15 - fixture begins with literal observations');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'stage4a:normalized:%' and epistemic_class='NORMALIZED_SOURCE_CLAIM'
    and claim_status='ASSERTED'),4::bigint,
  '16 - literal observations normalize as source claims');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'stage4a:system:%' and epistemic_class='DERIVED_INFERRED'
    and claim_status='ASSERTED'),4::bigint,
  '17 - system process assertions remain derived inferences');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'stage4a:%' and epistemic_class='CANONICAL_FACT'),0::bigint,
  '18 - Stage 4A creates no automatic canonical facts');
select is((select count(*) from public.catalog_class_requirements
  where epistemic_state='NEEDS_EVIDENCE'),3::bigint,
  '19 - three requirement gaps remain explicit');
select is((select count(*) from public.catalog_stage_transitions
  where epistemic_state='NEEDS_EVIDENCE'),1::bigint,
  '20 - an unsupported lifecycle transition remains pending');

select is((select count(distinct reference_product_id) from public.product_system_roles
  where reference_product_id is not null and decision_status='approved'),2::bigint,
  '21 - official references can cover roles without commercial adoption');
select is((select count(*) from public.catalog_class_members
  where reference_product_id is not null and decision_status='approved'),2::bigint,
  '22 - official references can join the same functional classes');
select is((select count(*) from public.catalog_class_members
  where reference_product_id is not null and knowledge_subject_ref is null),0::bigint,
  '23 - reference memberships have stable universal subject keys');

select is((public.get_catalog_stage4a_report_v1()->>'stage4Authorized')::boolean,false,
  '24 - Stage 4A does not change the certificate authorization flag');
select is((public.get_catalog_stage4a_report_v1()->'historicalRelations'->>'untouched')::integer,323,
  '25 - all 323 real historical relations remain untouched');
select is((public.get_catalog_stage4a_report_v1()->'historicalRelations'->>'analyzedThisCut')::integer,0,
  '26 - this contract cut does not reprocess historical candidates');
select is((public.get_catalog_stage4a_report_v1()->'guards'->>'humanReviewPerProductGenerated')::integer,0,
  '27 - no artificial human review per product is generated');

select is((select count(*) from public.graph_system_class_contract_nodes_v1
  where node_type='requirement'),8::bigint,
  '28 - graph projects requirement nodes from PostgreSQL');
select is((select count(*) from public.graph_system_class_contract_edges_v1
  where predicate='PRECEDES'),8::bigint,
  '29 - graph projects process sequences from PostgreSQL');
select is((select count(*) from public.graph_system_class_contract_nodes_v1
  where layer='canonical' and node_type='requirement'),0::bigint,
  '30 - derived and pending requirements never impersonate canonical graph nodes');

select is((select count(*) from information_schema.tables
  where table_schema='public' and table_name like 'stage4\_%' escape '\'),0::bigint,
  '31 - no parallel stage4 tables were created');
select is((select count(*) from public.catalog_semantic_rules
  where rule_code in ('NORMALIZE_PROCESS_DECLARATION','DERIVE_SYSTEM_PROCESS_CONTRACT')
    and (scope::text ~* '"(brand|sku|product)[^"]*"[[:space:]]*:'
      or definition::text ~* '"(brand|sku|product)[^"]*"[[:space:]]*:')),0::bigint,
  '32 - universal process rules contain no brand SKU or product scope');

select throws_ok($$
  insert into public.catalog_relation_rules(
    code,source_class_id,target_class_id,relation_type,relation_kind_code,
    compatibility_status,requirement_level,brand_policy,decision_status,
    epistemic_state,semantic_claim_id,metadata
  )
  select 'PGTAP_STRICT_COMPATIBILITY_WITH_PROCESS_CLAIM',source.id,target.id,
    'compatible_with','COMPATIBLE_WITH','conditional','optional','explicit_evidence',
    'proposed','DERIVED_INFERRED',claim.id,'{}'::jsonb
  from public.catalog_classes source
  join public.catalog_classes target on target.code='ACRYLIC_MONOMER'
  join public.catalog_semantic_claims claim on claim.claim_key='stage4a:system:stage4a:acrylic:workflow'
  where source.code='ACRYLIC_POLYMER'
$$,'23514','Una relacion estricta exige un claim de compatibilidad del par.',
  '33 - process membership cannot masquerade as strict compatibility');

select throws_ok($$
  insert into public.catalog_relation_rules(
    code,source_class_id,target_class_id,relation_type,relation_kind_code,
    requirement_level,brand_policy,decision_status,epistemic_state,metadata
  )
  select 'PGTAP_FORBIDDEN_LEGACY_STATE',source.id,target.id,null,'PRECEDES',
    'optional','any_brand','needs_evidence','LEGACY_CANONICAL_PRE_0111','{}'::jsonb
  from public.catalog_classes source
  join public.catalog_classes target on target.code='ACRYLIC_MONOMER'
  where source.code='ACRYLIC_POLYMER'
$$,'23514','El estado legado esta cerrado para nuevas aserciones.',
  '34 - new knowledge cannot use the pre-checkpoint legacy shortcut');

select * from finish();
rollback;
