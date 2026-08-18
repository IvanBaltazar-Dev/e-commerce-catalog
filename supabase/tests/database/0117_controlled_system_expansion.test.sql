begin;

select plan(42);

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,email_change,email_change_token_new,recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11700000-0000-4000-8000-000000000001',
  'authenticated','authenticated','stage4g-owner@example.invalid','',now(),
  '{}','{}',now(),now(),'','','',''
);
insert into public.admin_profiles(id,role,full_name,is_active)
values ('11700000-0000-4000-8000-000000000001','admin','Propietaria de prueba 4G',true);

create temp table stage4g_manifests(manifest_key text primary key, manifest jsonb not null);
insert into stage4g_manifests values
('test-a', $json$
{
  "manifestKey":"pgtap-controlled-a-v1","manifestVersion":1,
  "system":{"domain":"TEST_A","code":"EXP_TEST_A","name":"Sistema de prueba A","description":"Contrato aislado"},
  "stages":[
    {"code":"START","name":"Inicio","position":10},
    {"code":"FINISH","name":"Final","position":20}
  ],
  "roles":[
    {"code":"EXP_TEST_A_COMPONENT","name":"Componente A","kind":"component"},
    {"code":"EXP_TEST_A_TOOL","name":"Herramienta A","kind":"tool"}
  ],
  "classes":[
    {"code":"EXP_TEST_A_COMPONENTS","name":"Componentes A","scope":"product"},
    {"code":"EXP_TEST_A_TOOLS","name":"Herramientas A","scope":"product"}
  ],
  "expectations":[
    {"stageCode":"START","roleCode":"EXP_TEST_A_COMPONENT","necessity":"required","minimumSelections":1,"maximumSelections":1},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_A_TOOL","necessity":"recommended","minimumSelections":0,"maximumSelections":1}
  ],
  "roleClasses":[
    {"stageCode":"START","roleCode":"EXP_TEST_A_COMPONENT","classCode":"EXP_TEST_A_COMPONENTS","coverageKind":"covers_role"},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_A_TOOL","classCode":"EXP_TEST_A_TOOLS","coverageKind":"covers_role"}
  ],
  "requirements":[
    {"stageCode":"START","roleCode":"EXP_TEST_A_COMPONENT","classCode":"EXP_TEST_A_COMPONENTS","code":"CONFIRM_TYPE","name":"Confirmar tipo","kind":"EVIDENCE","necessity":"required","value":{"pending":true}},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_A_TOOL","classCode":"EXP_TEST_A_TOOLS","code":"CONFIRM_TYPE","name":"Confirmar tipo","kind":"EVIDENCE","necessity":"required","value":{"pending":true}}
  ],
  "transitions":[
    {"sourceStageCode":"START","targetStageCode":"FINISH","kind":"PRECEDES","condition":{"pending":true}}
  ],
  "classRelations":[
    {"code":"EXP_TEST_A_PRECEDES_TOOL","sourceClassCode":"EXP_TEST_A_COMPONENTS","targetClassCode":"EXP_TEST_A_TOOLS","kind":"PRECEDES","stageCode":"FINISH","requirementLevel":"recommended"}
  ],
  "evidenceSignatures":["gel_color->gel_top"]
}
$json$::jsonb),
('test-b', $json$
{
  "manifestKey":"pgtap-controlled-b-v1","manifestVersion":1,
  "system":{"domain":"TEST_B","code":"EXP_TEST_B","name":"Sistema de prueba B","description":"Contrato aislado"},
  "stages":[
    {"code":"START","name":"Inicio","position":10},
    {"code":"FINISH","name":"Final","position":20}
  ],
  "roles":[
    {"code":"EXP_TEST_B_COMPONENT","name":"Componente B","kind":"component"},
    {"code":"EXP_TEST_B_CARE","name":"Cuidado B","kind":"care"}
  ],
  "classes":[
    {"code":"EXP_TEST_B_COMPONENTS","name":"Componentes B","scope":"product"},
    {"code":"EXP_TEST_B_CARE_PRODUCTS","name":"Cuidados B","scope":"product"}
  ],
  "expectations":[
    {"stageCode":"START","roleCode":"EXP_TEST_B_COMPONENT","necessity":"required","minimumSelections":1,"maximumSelections":1},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_B_CARE","necessity":"optional","minimumSelections":0,"maximumSelections":1}
  ],
  "roleClasses":[
    {"stageCode":"START","roleCode":"EXP_TEST_B_COMPONENT","classCode":"EXP_TEST_B_COMPONENTS","coverageKind":"covers_role"},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_B_CARE","classCode":"EXP_TEST_B_CARE_PRODUCTS","coverageKind":"covers_role"}
  ],
  "requirements":[
    {"stageCode":"START","roleCode":"EXP_TEST_B_COMPONENT","classCode":"EXP_TEST_B_COMPONENTS","code":"CONFIRM_TYPE","name":"Confirmar tipo","kind":"EVIDENCE","necessity":"required","value":{"pending":true}},
    {"stageCode":"FINISH","roleCode":"EXP_TEST_B_CARE","classCode":"EXP_TEST_B_CARE_PRODUCTS","code":"CONFIRM_APPLICABILITY","name":"Confirmar aplicación","kind":"COMPATIBILITY","necessity":"required","value":{"explicit":true}}
  ],
  "transitions":[
    {"sourceStageCode":"START","targetStageCode":"FINISH","kind":"PRECEDES","condition":{"pending":true}}
  ],
  "classRelations":[
    {"code":"EXP_TEST_B_PRECEDES_CARE","sourceClassCode":"EXP_TEST_B_COMPONENTS","targetClassCode":"EXP_TEST_B_CARE_PRODUCTS","kind":"PRECEDES","stageCode":"FINISH","requirementLevel":"optional"}
  ],
  "evidenceSignatures":["lash_extension->lash_remover"]
}
$json$::jsonb);

create temp table stage4g_commercial_baseline as
select
  (select md5(coalesce(string_agg(to_jsonb(product)::text,'#' order by product.id),''))
    from public.products product) products,
  (select md5(coalesce(string_agg(to_jsonb(variant)::text,'#' order by variant.id),''))
    from public.product_variants variant) variants,
  (select md5(coalesce(string_agg(to_jsonb(price)::text,'#' order by price.id),''))
    from public.variant_prices price) prices,
  (select md5(coalesce(string_agg(to_jsonb(stock)::text,'#' order by stock.variant_id,stock.branch_id),''))
    from public.inventory_stock stock) stock,
  (select count(*) from public.catalog_class_members) memberships,
  (select count(*) from public.product_system_roles) product_roles,
  (select count(*) from public.catalog_review_work_items) review_work;

select has_table('public','catalog_system_expansion_previews',
  '1 - expansion previews are persisted');
select has_function('public','catalog_system_expansion_state_v1',array[]::text[],
  '2 - universal state has an exact fingerprint');
select has_function('public','preview_catalog_system_expansion_v1',array['jsonb','text','uuid'],
  '3 - expansion has a preview contract');
select has_function('public','apply_catalog_system_expansion_v1',array['uuid','text','text','uuid'],
  '4 - expansion has an exact apply contract');
select has_function('public','get_catalog_controlled_expansion_report_v1',array[]::text[],
  '5 - expansion has a certification report');
select ok(not has_table_privilege('anon','public.catalog_system_expansion_previews','SELECT'),
  '6 - anonymous users cannot read previews');
select ok(not has_function_privilege('anon',
  'public.preview_catalog_system_expansion_v1(jsonb,text,uuid)','EXECUTE'),
  '7 - anonymous users cannot prepare expansions');
select ok(not has_function_privilege('anon',
  'public.apply_catalog_system_expansion_v1(uuid,text,text,uuid)','EXECUTE'),
  '8 - anonymous users cannot apply expansions');

select throws_ok($$
  select public.preview_catalog_system_expansion_v1(
    (select manifest from stage4g_manifests where manifest_key='test-a'),
    'pgtap-unauthorized',null)
$$,'42501','Solo administración puede preparar una expansión de sistemas.',
  '9 - preview requires an accountable administrator');
select throws_ok($$
  select public.preview_catalog_system_expansion_v1(
    (select manifest || '{"metadata":{"products":[]}}'::jsonb
      from stage4g_manifests where manifest_key='test-a'),
    'pgtap-forbidden-products','11700000-0000-4000-8000-000000000001')
$$,'22023','El manifiesto de sistemas no admite datos comerciales ni productos.',
  '10 - commercial or product payloads are rejected at any depth');
select throws_ok($$
  select public.preview_catalog_system_expansion_v1(
    jsonb_set((select manifest from stage4g_manifests where manifest_key='test-a'),
      '{expectations,0,stageCode}','"MISSING"'),
    'pgtap-broken-reference','11700000-0000-4000-8000-000000000001')
$$,'22023','El manifiesto contiene referencias internas incoherentes.',
  '11 - internal references must resolve inside the manifest');

create temp table stage4g_preview_a as
select public.preview_catalog_system_expansion_v1(
  (select manifest from stage4g_manifests where manifest_key='test-a'),
  'pgtap-expansion-a-preview','11700000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from stage4g_preview_a),'previewed',
  '12 - a valid manifest stays in preview');
select is(length((select result->>'previewFingerprint' from stage4g_preview_a)),64,
  '13 - preview confirmation uses SHA-256');
select is((select (result->'metrics'->>'productMembershipsCreated')::integer
  from stage4g_preview_a),0,
  '14 - preview declares no product memberships');
select is((select count(*) from public.catalog_systems where code='EXP_TEST_A'),0::bigint,
  '15 - preview does not create the system');
select ok((public.preview_catalog_system_expansion_v1(
  (select manifest from stage4g_manifests where manifest_key='test-a'),
  'pgtap-expansion-a-preview','11700000-0000-4000-8000-000000000001')
  ->>'idempotentReplay')::boolean,
  '16 - identical previews are idempotent');
select throws_ok($$
  select public.preview_catalog_system_expansion_v1(
    (select manifest from stage4g_manifests where manifest_key='test-b'),
    'pgtap-expansion-a-preview','11700000-0000-4000-8000-000000000001')
$$,'23505','La clave idempotente ya representa otro manifiesto.',
  '17 - one preview key cannot represent another manifest');
select throws_ok($$
  select public.apply_catalog_system_expansion_v1(
    (select (result->>'previewId')::uuid from stage4g_preview_a),repeat('0',64),
    'pgtap-expansion-a-apply-wrong','11700000-0000-4000-8000-000000000001')
$$,'40001','La confirmación no coincide con el preview de expansión.',
  '18 - apply rejects a fingerprint not shown in preview');

create temp table stage4g_apply_a as
select public.apply_catalog_system_expansion_v1(
  (select (result->>'previewId')::uuid from stage4g_preview_a),
  (select result->>'previewFingerprint' from stage4g_preview_a),
  'pgtap-expansion-a-apply','11700000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from stage4g_apply_a),'applied',
  '19 - exact apply creates the proposed structure');
select is((select count(*) from public.catalog_systems where code='EXP_TEST_A'),1::bigint,
  '20 - apply creates one system');
select is((select count(*) from public.catalog_stages stage join public.catalog_systems system
  on system.id=stage.system_id where system.code='EXP_TEST_A'),2::bigint,
  '21 - apply creates only the declared stages');
select is((select count(*) from public.catalog_roles
  where code like 'EXP_TEST_A_%'),2::bigint,
  '22 - apply creates only the declared roles');
select is((select count(*) from public.catalog_classes
  where code like 'EXP_TEST_A_%'),2::bigint,
  '23 - apply creates only the declared classes');
select is((select count(*) from public.catalog_system_stage_roles expectation
  join public.catalog_systems system on system.id=expectation.system_id
  where system.code='EXP_TEST_A' and expectation.decision_status='needs_evidence'),2::bigint,
  '24 - every stage-role expectation needs evidence');
select is((select count(*) from public.catalog_system_stage_role_classes bridge
  where bridge.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'
    and bridge.epistemic_state='NEEDS_EVIDENCE' and bridge.semantic_claim_id is null),2::bigint,
  '25 - every role-class bridge needs evidence');
select is((select count(*) from public.catalog_class_requirements requirement
  where requirement.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'
    and requirement.epistemic_state='NEEDS_EVIDENCE' and requirement.semantic_claim_id is null),2::bigint,
  '26 - every requirement needs evidence');
select is((select count(*) from public.catalog_stage_transitions transition
  where transition.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'
    and transition.epistemic_state='NEEDS_EVIDENCE' and transition.semantic_claim_id is null),1::bigint,
  '27 - every transition needs evidence');
select is((select count(*) from public.catalog_relation_rules rule
  where rule.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'
    and rule.epistemic_state='NEEDS_EVIDENCE' and rule.semantic_claim_id is null),1::bigint,
  '28 - every class relation remains a proposal');
select is((select count(*) from public.catalog_class_members member
  join public.catalog_classes class on class.id=member.class_id
  where class.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'),0::bigint,
  '29 - no products are classified');
select is((select count(*) from public.product_system_roles assignment
  join public.catalog_systems system on system.id=assignment.system_id
  where system.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'),0::bigint,
  '30 - no product receives a system role');
select is((select count(*) from public.catalog_semantic_claims claim
  where claim.metadata->>'expansionManifestKey'='pgtap-controlled-a-v1'
    and claim.epistemic_class='CANONICAL_FACT'),0::bigint,
  '31 - apply creates no canonical fact');
select is((select count(*) from public.catalog_research_runs
  where run_key='system-expansion:pgtap-controlled-a-v1:v1'
    and scope->>'massBrandResearch'='false'),1::bigint,
  '32 - one bounded research-memory record explains the expansion');
select ok((public.apply_catalog_system_expansion_v1(
  (select (result->>'previewId')::uuid from stage4g_preview_a),
  (select result->>'previewFingerprint' from stage4g_preview_a),
  'pgtap-expansion-a-apply','11700000-0000-4000-8000-000000000001')
  ->>'idempotentReplay')::boolean,
  '33 - exact apply is idempotent');

create temp table stage4g_stale_preview_b as
select public.preview_catalog_system_expansion_v1(
  (select manifest from stage4g_manifests where manifest_key='test-b'),
  'pgtap-expansion-b-stale-preview','11700000-0000-4000-8000-000000000001') result;
insert into public.catalog_systems(domain,code,name,metadata)
values ('TEST_STATE','EXP_TEST_STATE_CHANGE','Cambio concurrente','{}');
select throws_ok($$
  select public.apply_catalog_system_expansion_v1(
    (select (result->>'previewId')::uuid from stage4g_stale_preview_b),
    (select result->>'previewFingerprint' from stage4g_stale_preview_b),
    'pgtap-expansion-b-stale-apply','11700000-0000-4000-8000-000000000001')
$$,'40001','El modelo universal cambió desde el preview; genera uno nuevo.',
  '34 - stale apply is rejected when universal knowledge changes');
delete from public.catalog_systems where code='EXP_TEST_STATE_CHANGE';

create temp table stage4g_apply_b as
select public.apply_catalog_system_expansion_v1(
  (select (result->>'previewId')::uuid from stage4g_stale_preview_b),
  (select result->>'previewFingerprint' from stage4g_stale_preview_b),
  'pgtap-expansion-b-apply','11700000-0000-4000-8000-000000000001') result;
select is((select result->>'systemCode' from stage4g_apply_b),'EXP_TEST_B',
  '35 - restoring the exact state makes the same frozen preview applicable again');
select ok((public.get_catalog_controlled_expansion_report_v1()->>'passes')::boolean,
  '36 - report certifies two systems and real decision coverage');
select cmp_ok((public.get_catalog_controlled_expansion_report_v1()
  ->'metrics'->>'manifests')::integer,'>=',2,
  '37 - report sees at least two applied manifests');
select cmp_ok((public.get_catalog_controlled_expansion_report_v1()
  ->'metrics'->>'coveredDecisions')::integer,'>=',2,
  '38 - report ties expansion to existing human decisions');
select is((public.get_catalog_controlled_expansion_report_v1()->>'stage4Authorized')::boolean,false,
  '39 - controlled expansion does not authorize a later stage');
select is((public.get_catalog_controlled_expansion_report_v1()
  ->'guards'->>'commercialEffects')::integer,0,
  '40 - report preserves the commercial boundary');
select is(
  (select to_jsonb(current) from (
    select
      (select md5(coalesce(string_agg(to_jsonb(product)::text,'#' order by product.id),'')) from public.products product) products,
      (select md5(coalesce(string_agg(to_jsonb(variant)::text,'#' order by variant.id),'')) from public.product_variants variant) variants,
      (select md5(coalesce(string_agg(to_jsonb(price)::text,'#' order by price.id),'')) from public.variant_prices price) prices,
      (select md5(coalesce(string_agg(to_jsonb(stock)::text,'#' order by stock.variant_id,stock.branch_id),'')) from public.inventory_stock stock) stock,
      (select count(*) from public.catalog_class_members) memberships,
      (select count(*) from public.product_system_roles) product_roles,
      (select count(*) from public.catalog_review_work_items) review_work
  ) current),
  (select to_jsonb(stage4g_commercial_baseline) from stage4g_commercial_baseline),
  '41 - products, variants, prices, stock, memberships and Mesa stay unchanged');
select is((select count(*) from public.catalog_system_expansion_previews
  where status='applied' and research_run_id is null),0::bigint,
  '42 - every applied manifest keeps its audit run');

select * from finish();
rollback;
