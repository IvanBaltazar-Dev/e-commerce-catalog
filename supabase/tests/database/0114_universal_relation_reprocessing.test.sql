begin;

select plan(30);

create temp table stage4b_baseline as
select
  (select count(*) from public.catalog_relation_candidates
    where status = 'needs_evidence'
      and evidence->>'generated_from' = 'catalog_process_rule_v1') as deferred_candidates,
  (select count(*) from public.catalog_semantic_claims
    where epistemic_class = 'CANONICAL_FACT') as canonical_facts,
  (select count(*) from public.catalog_review_work_items) as review_work;

select has_table('public','catalog_relation_endpoint_profiles',
  '1 - endpoint recognizers are data-driven');
select has_table('public','catalog_relation_reprocess_profiles',
  '2 - historical rule profiles configure the engine');
select has_table('public','catalog_relation_reprocess_runs',
  '3 - relation reprocess runs freeze snapshots');
select has_table('public','catalog_relation_reprocess_items',
  '4 - relation preview items are persisted');
select has_view('public','catalog_relation_reprocess_plan_v1',
  '5 - explainable plan is readable before preview');

select is((select count(*) from public.catalog_relation_endpoint_profiles where is_active),15::bigint,
  '6 - endpoint vocabulary covers the historical cohort');
select is((select count(*) from public.catalog_relation_reprocess_profiles where is_active),13::bigint,
  '7 - thirteen shared rules replace per-row decisions');
select is((select count(*) from public.catalog_relation_reprocess_plan_v1),323::bigint,
  '8 - the engine analyzes all 323 historical candidates');
select is((select count(distinct candidate_id) from public.catalog_relation_reprocess_plan_v1),323::bigint,
  '9 - every historical candidate appears exactly once');
select is((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification not in (
    'CLASS_MEMBERSHIP','CLASS_RELATION','GENUINE_PAIR_RELATION',
    'NEEDS_EVIDENCE','CONTRADICTED','UNKNOWN','REJECTED'
  )),0::bigint,
  '10 - destinations use only the compact Stage 4B vocabulary');

select ok((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification='CLASS_RELATION') > 0,
  '11 - real pairs compress into class relations');
select ok((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification='CLASS_MEMBERSHIP') > 0,
  '12 - category false pairs preserve useful class memberships');
select ok((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification='REJECTED') > 0,
  '13 - explicit endpoint exclusions reveal false pairs');
select ok((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification='NEEDS_EVIDENCE') > 0,
  '14 - strict pair relations remain pending without pair evidence');
select is((select count(*) from public.catalog_relation_reprocess_plan_v1
  where relation_kind_code='COMPATIBLE_WITH'
    and classification in ('CLASS_RELATION','GENUINE_PAIR_RELATION')),0::bigint,
  '15 - same brand or category never proves strict compatibility');
select is((select count(*) from public.catalog_relation_reprocess_plan_v1
  where epistemic_result='DERIVED_INFERRED'
    and proposed_resolution->>'canonicalPromotion'='true'),0::bigint,
  '16 - derived classification never canonizes itself');
select is((select count(*) from public.catalog_relation_reprocess_plan_v1
  where classification='NEEDS_EVIDENCE'
    and proposed_resolution->>'humanWorkCreated' <> 'false'),0::bigint,
  '17 - missing evidence alone creates no human work');

select throws_ok($$
  select public.preview_catalog_relation_reprocess_v1('pgtap-stage4b-wrong-count',322)
$$,'40001','La cohorte historica contiene 323 candidatas; se esperaban 322.',
  '18 - preview refuses a changing cohort');

create temp table stage4b_preview as
select public.preview_catalog_relation_reprocess_v1('pgtap-stage4b-preview-v1',323) as result;

select is((select result->>'status' from stage4b_preview),'previewed',
  '19 - first pass remains preview-only');
select is(length((select result->>'snapshotFingerprint' from stage4b_preview)),64,
  '20 - snapshot has a SHA-256 fingerprint');
select is(length((select result->>'previewFingerprint' from stage4b_preview)),64,
  '21 - immutable preview has a SHA-256 fingerprint');
select is(((select result->'metrics'->>'historicalCandidates' from stage4b_preview))::integer,323,
  '22 - frozen metrics cover the complete cohort');
select is((public.preview_catalog_relation_reprocess_v1(
  'pgtap-stage4b-preview-v1',323)->>'idempotentReplay')::boolean,true,
  '23 - preview idempotency returns the same snapshot');

select throws_ok($$
  update public.catalog_relation_reprocess_items
  set classification = 'UNKNOWN'
  where reprocess_run_id = (
    select (result->>'previewId')::uuid from stage4b_preview
  )
$$,'55000','El preview universal de relaciones es inmutable; genere otra fotografia.',
  '24 - frozen preview rows cannot be edited');

select throws_ok($$
  select public.apply_catalog_relation_reprocess_v1(
    (select (result->>'previewId')::uuid from stage4b_preview),
    repeat('0',64),
    'pgtap-stage4b-apply-invalid'
  )
$$,'40001','La huella no corresponde al preview universal congelado.',
  '25 - apply rejects a different fingerprint');

create temp table stage4b_apply as
select public.apply_catalog_relation_reprocess_v1(
  (select (result->>'previewId')::uuid from stage4b_preview),
  (select result->>'previewFingerprint' from stage4b_preview),
  'pgtap-stage4b-apply-v1'
) as result;

select is((select result->>'status' from stage4b_apply),'applied',
  '26 - exact apply activates only the frozen analysis');
select is((select result->>'knowledgePromoted' from stage4b_apply)::boolean,false,
  '27 - analytical apply promotes no knowledge');
select is((select count(*) from public.catalog_relation_candidates
    where status = 'needs_evidence'
      and evidence->>'generated_from' = 'catalog_process_rule_v1'),
  (select deferred_candidates from stage4b_baseline),
  '28 - source candidates remain deferred after apply');
select is((select count(*) from public.catalog_semantic_claims
    where epistemic_class = 'CANONICAL_FACT'),
  (select canonical_facts from stage4b_baseline),
  '29 - apply creates no canonical facts');
select is((select count(*) from public.catalog_review_work_items),
  (select review_work from stage4b_baseline),
  '30 - no per-candidate human work is generated');

select * from finish();
rollback;
