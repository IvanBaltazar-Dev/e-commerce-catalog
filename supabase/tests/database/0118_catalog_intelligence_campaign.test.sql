begin;

select plan(60);

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,email_change,email_change_token_new,recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11800000-0000-4000-8000-000000000001',
  'authenticated','authenticated','stage5-owner@example.invalid','',now(),
  '{}','{}',now(),now(),'','','',''
);
insert into public.admin_profiles(id,role,full_name,is_active)
values ('11800000-0000-4000-8000-000000000001','admin','Propietaria de prueba 5',true);

insert into public.catalog_sources(
  id,source_key,name,authority,adapter,base_url,brand_id,metadata
)
select '11800000-0000-4000-8000-000000000002','stage5-pgtap-official',
  'Fuente oficial de prueba 5','official','html','https://stage5.invalid',
  brand.id,'{"synthetic":true}'::jsonb
from public.brands brand order by brand.id limit 1;

create temp table stage5_baseline as
select
  public.catalog_intelligence_campaign_snapshot_v1(
    '11800000-0000-4000-8000-000000000002')->>'commercialFingerprint' commercial_fingerprint,
  (select count(*) from public.products) products,
  (select count(*) from public.catalog_relation_decisions where status<>'pending') resolved_decisions,
  (select count(*) from public.catalog_semantic_claims
    where epistemic_class='CANONICAL_FACT') canonical_facts;

select has_table('public','catalog_intelligence_campaigns',
  '1 - campaigns are persisted');
select has_table('public','catalog_intelligence_campaign_events',
  '2 - campaign steps are audited');
select has_function('public','get_catalog_reference_commercial_readiness_v1',array['uuid'],
  '3 - commercial readiness is explicit');
select has_function('public','catalog_intelligence_campaign_snapshot_v1',array['uuid'],
  '4 - campaign baseline is reproducible');
select has_function('public','catalog_intelligence_campaign_state_v1',array['uuid'],
  '5 - campaign state has an exact fingerprint');
select has_function('public','preview_catalog_intelligence_campaign_v1',
  array['text','text','jsonb','uuid'],'6 - campaign has preview');
select has_function('public','start_catalog_intelligence_campaign_v1',
  array['uuid','text','uuid'],'7 - campaign start confirms the preview');
select has_function('public','record_catalog_intelligence_campaign_event_v1',
  array['uuid','text','text','jsonb','jsonb','text','uuid'],
  '8 - every campaign step has an event contract');
select has_function('public','complete_catalog_intelligence_campaign_v1',
  array['uuid','jsonb','uuid'],'9 - campaign completion is guarded');
select has_function('public','fail_catalog_intelligence_campaign_v1',
  array['uuid','jsonb','uuid'],'10 - campaign failure is explicit');
select has_function('public','get_catalog_intelligence_campaign_report_v1',array['uuid'],
  '11 - owner report is queryable');
select is((select relrowsecurity from pg_class where oid='public.catalog_intelligence_campaigns'::regclass),
  true,'12 - campaign rows use RLS');
select is((select relrowsecurity from pg_class where oid='public.catalog_intelligence_campaign_events'::regclass),
  true,'13 - campaign events use RLS');
select ok(not has_table_privilege('anon','public.catalog_intelligence_campaigns','SELECT'),
  '14 - anonymous users cannot read campaigns');
select ok(not has_function_privilege('anon',
  'public.preview_catalog_intelligence_campaign_v1(text,text,jsonb,uuid)','EXECUTE'),
  '15 - anonymous users cannot prepare campaigns');

select throws_ok($$
  select public.preview_catalog_intelligence_campaign_v1(
    'stage5-pgtap-official','stage5-unauthorized','{}',null)
$$,'42501','Solo administración puede preparar una campaña de catálogo.',
  '16 - preview requires an accountable administrator');
select throws_ok($$
  select public.preview_catalog_intelligence_campaign_v1(
    'stage5-pgtap-official','stage5-forbidden','{"publishProducts":true}',
    '11800000-0000-4000-8000-000000000001')
$$,'22023','La campaña contiene una capacidad fuera del alcance autorizado.',
  '17 - commercial actions are rejected before preview');
select throws_ok($$
  select public.preview_catalog_intelligence_campaign_v1(
    'stage5-source-missing','stage5-missing-source','{}',
    '11800000-0000-4000-8000-000000000001')
$$,'P0002','La fuente oficial no existe, está inactiva o no tiene marca.',
  '18 - only active official brand sources are eligible');

select is(public.get_catalog_reference_commercial_readiness_v1(
  '11800000-0000-4000-8000-000000000002')->>'contractVersion',
  'commercial-readiness-v1','19 - readiness has a versioned contract');
select is((public.get_catalog_reference_commercial_readiness_v1(
  '11800000-0000-4000-8000-000000000002')->'summary'->>'candidates')::integer,
  0,'20 - an empty source produces no invented candidate');
select is((public.get_catalog_reference_commercial_readiness_v1(
  '11800000-0000-4000-8000-000000000002')->'guards'->>'automaticAdoption')::boolean,
  false,'21 - readiness never adopts a product');

create temp table stage5_preview as
select public.preview_catalog_intelligence_campaign_v1(
  'stage5-pgtap-official','stage5-main','{}',
  '11800000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from stage5_preview),'previewed',
  '22 - valid campaign remains in preview');
select is(length((select result->>'previewFingerprint' from stage5_preview)),64,
  '23 - preview confirmation uses SHA-256');
select is(length((select result->'baseline'->>'commercialFingerprint' from stage5_preview)),64,
  '24 - preview freezes the commercial baseline');
select is((select count(*) from public.catalog_intelligence_campaign_events
  where campaign_id=(select (result->>'campaignId')::uuid from stage5_preview)),0::bigint,
  '25 - preview executes no step');
select ok((public.preview_catalog_intelligence_campaign_v1(
  'stage5-pgtap-official','stage5-main','{}',
  '11800000-0000-4000-8000-000000000001')->>'idempotentReplay')::boolean,
  '26 - identical preview is idempotent');
select throws_ok($$
  select public.preview_catalog_intelligence_campaign_v1(
    'stage5-pgtap-official','stage5-main','{"runResearch":false}',
    '11800000-0000-4000-8000-000000000001')
$$,'23505','La clave de campaña ya representa otra solicitud.',
  '27 - one campaign key cannot represent another request');
select throws_ok($$
  select public.start_catalog_intelligence_campaign_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),repeat('0',64),
    '11800000-0000-4000-8000-000000000001')
$$,'40001','La confirmación no coincide con el preview de campaña.',
  '28 - start rejects an unseen fingerprint');

insert into public.catalog_systems(domain,code,name,metadata)
values ('STAGE5_TEST','STAGE5_CONCURRENT_CHANGE','Cambio concurrente','{}');
select throws_ok($$
  select public.start_catalog_intelligence_campaign_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),
    (select result->>'previewFingerprint' from stage5_preview),
    '11800000-0000-4000-8000-000000000001')
$$,'40001','El catálogo cambió desde el preview; genera una campaña nueva.',
  '29 - stale preview is rejected after concurrent knowledge changes');
delete from public.catalog_systems where code='STAGE5_CONCURRENT_CHANGE';

select is((public.start_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),
  (select result->>'previewFingerprint' from stage5_preview),
  '11800000-0000-4000-8000-000000000001')->>'status'),'running',
  '30 - exact preview starts the campaign');
select ok((public.start_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),
  (select result->>'previewFingerprint' from stage5_preview),
  '11800000-0000-4000-8000-000000000001')->>'idempotentReplay')::boolean,
  '31 - start is idempotent');
select throws_ok($$
  select public.record_catalog_intelligence_campaign_event_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),'unknown','succeeded',
    '{}',null,'stage5:unknown','11800000-0000-4000-8000-000000000001')
$$,'22023','El evento de campaña no es válido.',
  '32 - undeclared steps are rejected');
select is((public.record_catalog_intelligence_campaign_event_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),'research_delta','succeeded',
  '{"delta":{"unchanged":0}}',null,'stage5:research:succeeded',
  '11800000-0000-4000-8000-000000000001')->>'status'),'succeeded',
  '33 - a valid step is recorded');
select ok((public.record_catalog_intelligence_campaign_event_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),'research_delta','succeeded',
  '{"delta":{"unchanged":0}}',null,'stage5:research:succeeded',
  '11800000-0000-4000-8000-000000000001')->>'idempotentReplay')::boolean,
  '34 - an identical step replay is idempotent');
select throws_ok($$
  select public.record_catalog_intelligence_campaign_event_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),'research_delta','succeeded',
    '{"delta":{"changed":1}}',null,'stage5:research:succeeded',
    '11800000-0000-4000-8000-000000000001')
$$,'23505','La clave del paso ya representa otro resultado.',
  '35 - a step key cannot conceal another result');
select throws_ok($$
  select public.complete_catalog_intelligence_campaign_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),
    '{"graphVerification":{"ok":true}}',
    '11800000-0000-4000-8000-000000000001')
$$,'55000','La campaña todavía tiene pasos obligatorios sin cerrar.',
  '36 - completion waits for every mandatory step');

select public.record_catalog_intelligence_campaign_event_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),step,'succeeded','{}',null,
  'stage5:'||step||':succeeded','11800000-0000-4000-8000-000000000001')
from unnest(array[
  'semantic_certification','review_reprocess','relation_reprocess','decisions_sync',
  'controlled_expansion','graph_sync','graph_verify','readiness'
]) step;

select is((select count(*) from public.catalog_intelligence_campaign_events
  where campaign_id=(select (result->>'campaignId')::uuid from stage5_preview)),9::bigint,
  '37 - the audit contains all nine effective steps');
select throws_ok($$
  select public.complete_catalog_intelligence_campaign_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),
    '{"graphVerification":{"ok":false}}',
    '11800000-0000-4000-8000-000000000001')
$$,'23514','La campaña no puede cerrar con divergencias en el grafo.',
  '38 - graph divergence blocks completion');

create temp table stage5_product as
select id,unit_price from public.products order by id limit 1;
select ok(exists(select 1 from stage5_product),
  '39 - the checkpoint supplies a product for the commercial guard');
update public.products product set unit_price=product.unit_price+0.01
from stage5_product fixture where product.id=fixture.id;
select throws_ok($$
  select public.complete_catalog_intelligence_campaign_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),
    '{"graphVerification":{"ok":true}}',
    '11800000-0000-4000-8000-000000000001')
$$,'23514','La campaña detectó un cambio comercial fuera de alcance.',
  '40 - a commercial mutation blocks completion');
update public.products product set unit_price=fixture.unit_price
from stage5_product fixture where product.id=fixture.id;

create temp table stage5_complete as
select public.complete_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),
  '{"delta":{"unchanged":0},"graphVerification":{"ok":true,"differenceCount":0}}',
  '11800000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from stage5_complete),'succeeded',
  '41 - exact guarded completion succeeds');
select is(length((select result->>'finalFingerprint' from stage5_complete)),64,
  '42 - completion produces a final fingerprint');
select is((select result->'readiness'->>'sourceId' from stage5_complete),
  '11800000-0000-4000-8000-000000000002',
  '43 - completion evaluates the frozen source');
select ok((public.complete_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_preview),'{}',
  '11800000-0000-4000-8000-000000000001')->>'idempotentReplay')::boolean,
  '44 - completion is idempotent');
select ok((public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_preview))->>'passes')::boolean,
  '45 - report certifies the successful campaign');
select is(jsonb_array_length(public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_preview))->'steps'),9,
  '46 - owner report contains the nine audited steps');
select is((public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_preview))
  ->'guards'->>'commercialFingerprintUnchanged')::boolean,true,
  '47 - report exposes the commercial guard');
select is((public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_preview))
  ->'ownerSummary'->>'newProductsReady')::integer,0,
  '48 - owner summary invents no ready product');
select is((select result->'finalSnapshot'->>'commercialFingerprint'
  from public.catalog_intelligence_campaigns
  where id=(select (result->>'campaignId')::uuid from stage5_preview)),
  (select commercial_fingerprint from stage5_baseline),
  '49 - final commercial fingerprint equals the preview baseline');
select is(public.catalog_intelligence_campaign_snapshot_v1(
  '11800000-0000-4000-8000-000000000002')->>'commercialFingerprint',
  (select commercial_fingerprint from stage5_baseline),
  '50 - products, prices, publication and stock end unchanged');
select is((select count(*) from public.catalog_relation_decisions where status<>'pending'),
  (select resolved_decisions from stage5_baseline),
  '51 - the campaign applies no human relation decision');
select is((select count(*) from public.products),(select products from stage5_baseline),
  '52 - the campaign creates no commercial product');
select is((select count(*) from public.catalog_semantic_claims
  where epistemic_class='CANONICAL_FACT'),(select canonical_facts from stage5_baseline),
  '53 - the campaign creates no canonical fact automatically');
select throws_ok($$
  select public.record_catalog_intelligence_campaign_event_v1(
    (select (result->>'campaignId')::uuid from stage5_preview),'readiness','succeeded',
    '{}',null,'stage5:after-close','11800000-0000-4000-8000-000000000001')
$$,'55000','La campaña no está en ejecución.',
  '54 - successful history cannot receive late events');

create temp table stage5_failure_preview as
select public.preview_catalog_intelligence_campaign_v1(
  'stage5-pgtap-official','stage5-failure','{}',
  '11800000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from stage5_failure_preview),'previewed',
  '55 - a separate failure scenario can be prepared');
select is((public.start_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_failure_preview),
  (select result->>'previewFingerprint' from stage5_failure_preview),
  '11800000-0000-4000-8000-000000000001')->>'status'),'running',
  '56 - failure scenario starts from an exact preview');
select is((public.fail_catalog_intelligence_campaign_v1(
  (select (result->>'campaignId')::uuid from stage5_failure_preview),
  '{"message":"synthetic failure"}',
  '11800000-0000-4000-8000-000000000001')->>'status'),'failed',
  '57 - operational failure is explicit');
select is((public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_failure_preview))->>'status'),'failed',
  '58 - failed campaign remains observable');
select is((public.get_catalog_intelligence_campaign_report_v1(
  (select (result->>'campaignId')::uuid from stage5_failure_preview))->>'passes')::boolean,false,
  '59 - a failed campaign never passes certification');
select is((select created_by from public.catalog_intelligence_campaigns
  where id=(select (result->>'campaignId')::uuid from stage5_preview)),
  '11800000-0000-4000-8000-000000000001'::uuid,
  '60 - the accountable administrator is retained');

select * from finish();
rollback;
