begin;

select plan(33);

select has_column('public', 'catalog_review_work_items', 'handling_class', '1 - work has explicit handling class');
select has_table('public', 'catalog_review_reprocess_runs', '2 - reprocess runs persist preview and apply');
select has_table('public', 'catalog_review_reprocess_items', '3 - frozen preview items persist');
select has_function('public', 'preview_catalog_review_reprocess_v1', array['text'], '4 - global preview contract exists');
select has_function('public', 'apply_catalog_review_reprocess_v1', array['uuid','text','text'], '5 - fingerprint-bound apply exists');
select has_function('public', 'get_catalog_review_reprocess_report_v1', array[]::text[], '6 - read-only reprocess report exists');
select has_view('public', 'graph_review_work_nodes_v1', '7 - review work has graph projection');
select has_view('public', 'graph_review_work_edges_v1', '8 - review dependencies have graph projection');

create temporary table stage3_counts as
select
  (select count(*) from public.products) as products,
  (select count(*) from public.product_variants) as variants,
  (select count(*) from public.variant_prices) as prices,
  (select count(*) from public.inventory_stock) as stock,
  (select count(*) from public.product_media) as media,
  (select id from public.products order by code, id limit 1) as product_id,
  (select id from public.catalog_source_records order by captured_at, id limit 1) as source_record_id;

insert into public.catalog_evidence_sets(
  id, evidence_key, evidence_type, decision_status, confidence,
  rationale, decided_at, metadata
) values (
  '10800000-0000-4000-8000-000000000001',
  'stage3-fixture-official-evidence', 'official_sources', 'approved', 1,
  'Fixture oficial controlado para reprocesamiento.', now(),
  '{"fixture":"stage3"}'::jsonb
);

create temporary table stage3_fx(code text primary key, work_item_id uuid);

insert into stage3_fx
select 'physical', id from public.register_catalog_review_work_item_v1(
  'stage3-fixture:physical', 'manual', null, 'capture', 'image',
  'product', (select product_id from stage3_counts), md5('stage3-physical'),
  '¿La evidencia oficial resuelve la captura?', null, 'stage3-fixture',
  'normal', 'normal', false, 0, 0::numeric, 1::smallint,
  jsonb_build_object(
    'evidenceSetId', '10800000-0000-4000-8000-000000000001',
    'officialEvidenceSatisfiesPhysicalCapture', true,
    'requiresOwnPhotography', false
  )
);

insert into stage3_fx
select 'waiting', id from public.register_catalog_review_work_item_v1(
  'stage3-fixture:waiting', 'manual', null, 'waiting_external', 'source_verification',
  'product', (select product_id from stage3_counts), md5('stage3-waiting'),
  '¿Llegó la fuente externa?', null, 'stage3-fixture',
  'normal', 'normal', false, 1, 0::numeric, 1::smallint,
  jsonb_build_object(
    'evidenceSetId', '10800000-0000-4000-8000-000000000001',
    'externalDependencySatisfied', true
  )
);

insert into stage3_fx
select 'blocked', id from public.register_catalog_review_work_item_v1(
  'stage3-fixture:blocked', 'manual', null, 'decision', 'attribute',
  'product', (select product_id from stage3_counts), md5('stage3-blocked'),
  '¿Puede avanzar el caso dependiente?', null, 'stage3-fixture',
  'normal', 'normal', false, 0, 0::numeric, 1::smallint, '{}'::jsonb
);

insert into public.catalog_review_dependencies(
  dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key
) select
  (select work_item_id from stage3_fx where code = 'blocked'),
  (select work_item_id from stage3_fx where code = 'waiting'),
  'requires_all', 'stage3-fixture';

insert into stage3_fx
select 'image_debt', id from public.register_catalog_review_work_item_v1(
  'stage3-fixture:image-debt', 'manual', null, 'decision', 'image',
  'product', (select product_id from stage3_counts), md5('stage3-image-debt'),
  'Falta una imagen normal.', null, 'stage3-fixture',
  'low', 'low', false, 0, 0::numeric, 1::smallint,
  '{"requiresOwnPhotography":false}'::jsonb
);

insert into public.catalog_reconciliation_cases(
  id, entity_type, product_id, source_record_id, algorithm, score, status,
  decision_reason, evidence, decided_at, case_key
) select
  '10800000-0000-4000-8000-000000000100', 'product', product_id,
  source_record_id, 'stage3_historical_fixture_v1', 1, 'approved',
  'Decisión histórica que debe permanecer intacta.',
  '{"classificationContradiction":true,"newEvidence":"official_type_conflict"}'::jsonb,
  now(), 'stage3-historical-fixture-case'
from stage3_counts;

insert into stage3_fx
select 'historical', id from public.register_catalog_review_work_item_v1(
  'stage3-fixture:historical', 'reconciliation_case',
  '10800000-0000-4000-8000-000000000100', 'decision', 'classification',
  'product', (select product_id from stage3_counts), md5('stage3-historical'),
  'Decisión histórica completada.', null, 'stage3-fixture',
  'high', 'high', false, 0, 100::numeric, 1::smallint, '{}'::jsonb
);

update public.catalog_review_work_items
set status = 'resolved', resolution_code = 'approved',
    resolution_payload = '{"historical":true,"content":"immutable"}'::jsonb,
    resolved_at = now()
where id = (select work_item_id from stage3_fx where code = 'historical');

create temporary table stage3_historical_before as
select id, status, row_version, resolution_code, resolution_payload, resolved_at
from public.catalog_review_work_items
where id = (select work_item_id from stage3_fx where code = 'historical');

select is(
  (select planned_action from public.catalog_review_reprocess_plan_v1
   where work_item_id = (select work_item_id from stage3_fx where code = 'physical')),
  'auto_resolve',
  '9 - official evidence can resolve eligible physical capture'
);
select is(
  (select planned_action from public.catalog_review_reprocess_plan_v1
   where work_item_id = (select work_item_id from stage3_fx where code = 'waiting')),
  'auto_resolve',
  '10 - persisted evidence can satisfy external wait'
);
select is(
  (select previous_queue_state from public.catalog_review_reprocess_plan_v1
   where work_item_id = (select work_item_id from stage3_fx where code = 'blocked')),
  'blocked',
  '11 - dependency is blocked in preview'
);
select is(
  (select target_handling_class from public.catalog_review_reprocess_plan_v1
   where work_item_id = (select work_item_id from stage3_fx where code = 'image_debt')),
  'automatic_debt',
  '12 - normal missing image becomes automatic debt'
);
select is(
  (select planned_action from public.catalog_review_reprocess_plan_v1
   where work_item_id = (select work_item_id from stage3_fx where code = 'historical')),
  'new_historical_contradiction',
  '13 - later contradiction creates new work instead of rewriting history'
);

create temporary table stage3_preview as
select public.preview_catalog_review_reprocess_v1('pgtap-stage3-preview-1') as result;

select is((select result->>'status' from stage3_preview), 'previewed', '14 - preview is persisted');
select is(length((select result->>'snapshotFingerprint' from stage3_preview)), 64, '15 - preview freezes input fingerprint');
select is(length((select result->>'previewFingerprint' from stage3_preview)), 64, '16 - preview has exact action fingerprint');
select is(length((select result->>'logicalFingerprint' from stage3_preview)), 64, '17 - preview has logical result fingerprint');
select is(
  (public.preview_catalog_review_reprocess_v1('pgtap-stage3-preview-1')->>'idempotentReplay')::boolean,
  true,
  '18 - preview key is idempotent'
);
select throws_ok(
  format(
    'update public.catalog_review_reprocess_items set rule_code = %L where reprocess_run_id = %L',
    'tampered', (select result->>'previewId' from stage3_preview)
  ),
  '55000',
  null,
  '19 - frozen preview rows are immutable'
);

create temporary table stage3_apply as
select public.apply_catalog_review_reprocess_v1(
  (select (result->>'previewId')::uuid from stage3_preview),
  (select result->>'previewFingerprint' from stage3_preview),
  'pgtap-stage3-apply-1'
) as result;

select is((select result->>'status' from stage3_apply), 'applied', '20 - exact preview applies');
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from stage3_fx where code = 'physical')),
  'resolved',
  '21 - eligible physical capture resolves from official evidence'
);
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from stage3_fx where code = 'waiting')),
  'resolved',
  '22 - external wait resolves from persisted evidence'
);
select is(
  (select queue_state from public.catalog_review_queue_v1 where id = (select work_item_id from stage3_fx where code = 'blocked')),
  'reviewable',
  '23 - dependent case unblocks when prerequisite really resolves'
);
select is(
  (select queue_state from public.catalog_review_queue_v1 where id = (select work_item_id from stage3_fx where code = 'image_debt')),
  'automatic_debt',
  '24 - ordinary image debt leaves human queue'
);
select is(
  (select jsonb_build_array(status, row_version, resolution_code, resolution_payload, resolved_at)
   from public.catalog_review_work_items where id = (select work_item_id from stage3_fx where code = 'historical')),
  (select jsonb_build_array(status, row_version, resolution_code, resolution_payload, resolved_at) from stage3_historical_before),
  '25 - completed historical decision is byte-for-byte unchanged'
);
select is(
  (select count(*) from public.catalog_review_work_items
   where context->>'previousWorkItemId' = (select work_item_id::text from stage3_fx where code = 'historical')
     and context->>'reprocessOrigin' = 'historical_contradiction'),
  1::bigint,
  '26 - contradiction creates one linked human exception'
);
select ok(
  exists(select 1 from public.graph_review_work_edges_v1 where predicate = 'CONTRADICTS_DECISION'),
  '27 - graph exposes contradiction without replacing decision'
);

create temporary table stage3_events_before_second as
select count(*) as total from public.catalog_review_events;
create temporary table stage3_preview_second as
select public.preview_catalog_review_reprocess_v1('pgtap-stage3-preview-2') as result;
create temporary table stage3_apply_second as
select public.apply_catalog_review_reprocess_v1(
  (select (result->>'previewId')::uuid from stage3_preview_second),
  (select result->>'previewFingerprint' from stage3_preview_second),
  'pgtap-stage3-apply-2'
) as result;

select is(
  (select result->>'logicalFingerprint' from stage3_preview_second),
  (select result->>'logicalFingerprint' from stage3_preview),
  '28 - same evidence produces same logical fingerprint after apply'
);
select is(
  ((select result->'actionCounts'->>'changed' from stage3_apply_second))::integer,
  0,
  '29 - second apply changes no work'
);
select is(
  (select count(*) from public.catalog_review_events),
  (select total from stage3_events_before_second),
  '30 - second apply creates no artificial events'
);
select is(
  (select count(*) from (
    select work_family_key from public.catalog_review_work_items
    group by work_family_key, problem_version having count(*) > 1
  ) duplicate),
  0::bigint,
  '31 - reprocess creates no duplicate work versions'
);
select is(
  (select jsonb_build_array(
    (select count(*) from public.products),
    (select count(*) from public.product_variants),
    (select count(*) from public.variant_prices),
    (select count(*) from public.inventory_stock),
    (select count(*) from public.product_media)
  )),
  (select jsonb_build_array(products, variants, prices, stock, media) from stage3_counts),
  '32 - reprocess has zero commercial effects'
);
select is(
  (select count(*)
   from public.catalog_review_dependencies dependency
   join public.catalog_review_work_items prerequisite
     on prerequisite.id = dependency.prerequisite_work_item_id
   where dependency.origin = 'projection'
     and prerequisite.status in ('superseded', 'cancelled')),
  0::bigint,
  '33 - projected dependencies never block on superseded work'
);

select * from finish();
rollback;
