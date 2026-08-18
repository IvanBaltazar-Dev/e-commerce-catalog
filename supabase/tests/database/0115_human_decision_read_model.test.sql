begin;

select plan(30);

select has_view('public','catalog_relation_decision_groups_v1',
  '1 - shared causes are projected as semantic decision groups');
select has_view('public','catalog_decision_read_model_v1',
  '2 - frontend receives a business-ready decision contract');
select has_function('public','get_catalog_decision_queue_v1',array['integer','integer'],
  '3 - paginated decision queue is available');
select has_function('public','get_catalog_stage4c_report_v1',array[]::text[],
  '4 - Stage 4C has a read-only aggregate report');

select is((select count(*) from public.catalog_relation_endpoint_profiles
  where display_name is not null and length(trim(display_name)) > 0),15::bigint,
  '5 - all endpoint profiles have human-readable names');
select is((select count(distinct family_code) from public.catalog_decision_read_model_v1),3::bigint,
  '6 - real data produces three human decision families');
select is((select count(*) from public.catalog_decision_read_model_v1),18::bigint,
  '7 - shared causes reduce 259 real detections to 18 decisions');
select is((select sum(affected_count) from public.catalog_decision_read_model_v1),259::bigint,
  '8 - decision cases cover all material non-evidence-debt detections');

select is((select count(*) from public.catalog_decision_read_model_v1
  where family_code='CLASS_RULE_PROMOTION'),9::bigint,
  '9 - nine class signatures become nine shared promotion decisions');
select is((select count(*) from public.catalog_decision_read_model_v1
  where family_code='ENDPOINT_SCOPE_RECLASSIFICATION'),5::bigint,
  '10 - endpoint scope problems aggregate to five decisions');
select is((select count(*) from public.catalog_decision_read_model_v1
  where family_code='FALSE_PAIR_RETIREMENT'),4::bigint,
  '11 - false pairs aggregate to four decisions');
select is((select max(affected_count) from public.catalog_decision_read_model_v1
  where family_code='FALSE_PAIR_RETIREMENT'),86,
  '12 - one lamp cause represents 86 real false pairs in one decision');

select is((select count(*) from public.catalog_relation_reprocess_items item
  join public.catalog_relation_reprocess_runs run on run.id=item.reprocess_run_id
  where run.id=(select id from public.catalog_relation_reprocess_runs
    where status in ('previewed','applied') order by created_at desc,id desc limit 1)
    and item.classification='NEEDS_EVIDENCE'),57::bigint,
  '13 - fifty-seven evidence debts remain outside human decisions');
select is((public.get_catalog_stage4c_report_v1()->'metrics'->>'automaticEvidenceDebtExcluded')::integer,57,
  '14 - report makes the excluded automatic debt explicit');
select is((public.get_catalog_stage4c_report_v1()->'metrics'->>'familyCount')::integer,3,
  '15 - report certifies three families, not merely three rows');
select is((public.get_catalog_stage4c_report_v1()->'metrics'->>'individualReviewAvoided')::numeric,0.9305::numeric,
  '16 - aggregation avoids 93.05 percent of individual review');

select is((select count(*) from public.catalog_decision_read_model_v1
  where nullif(trim(title),'') is null
     or nullif(trim(business_summary),'') is null
     or nullif(trim(what_was_found),'') is null
     or nullif(trim(why_human_is_needed),'') is null
     or nullif(trim(system_recommendation),'') is null),0::bigint,
  '17 - backend supplies every human explanation');
select is((select count(*) from public.catalog_decision_read_model_v1
  where jsonb_typeof(affected_entity_types)<>'array'
     or jsonb_typeof(evidence_summary)<>'object'
     or jsonb_typeof(impact_preview)<>'object'
     or jsonb_typeof(available_actions)<>'array'),0::bigint,
  '18 - structured decision fields have stable JSON shapes');
select is((select count(*) from public.catalog_decision_read_model_v1
  where jsonb_array_length(available_actions) < 3),0::bigint,
  '19 - every case offers explicit backend-defined actions');
select is((select count(*) from public.catalog_decision_read_model_v1
  where length(fingerprint)<>64 or decision_id !~ '^decision:[0-9a-f]{32}$'),0::bigint,
  '20 - decisions have stable content identities');
select is((select count(*) from public.catalog_decision_read_model_v1
  where evidence_summary->>'previewFingerprint' is null
     or evidence_summary->>'affectedSetFingerprint' is null),0::bigint,
  '21 - every decision retains preview and affected-set evidence fingerprints');

select is((select count(*) from public.catalog_decision_read_model_v1
  where (impact_preview->>'canonicalFactsCreated')::integer<>0
     or (impact_preview->>'commercialEffects')::integer<>0),0::bigint,
  '22 - impact previews contain no canonical or commercial side effect');
select is((select count(*) from public.catalog_decision_read_model_v1
  where decision_applied or canonical_promotion or commercial_effect),0::bigint,
  '23 - read-model cases do not apply their own decisions');
select is((public.get_catalog_stage4c_report_v1()->>'stage4Authorized')::boolean,false,
  '24 - Stage 4C preserves stage4Authorized=false');
select is((public.get_catalog_stage4c_report_v1()->'guards'->>'reactInterpretsRuleCode')::boolean,false,
  '25 - React is not responsible for composing explanations');

select is((public.get_catalog_decision_queue_v1(2,0)->>'total')::integer,18,
  '26 - paginated contract reports the complete decision total');
select is(jsonb_array_length(public.get_catalog_decision_queue_v1(2,0)->'decisions'),2,
  '27 - pagination returns exactly the requested page size');
select throws_ok($$
  select public.get_catalog_decision_queue_v1(101,0)
$$,'22023','Limit debe estar entre 1 y 100 y offset no puede ser negativo.',
  '28 - pagination rejects unsafe limits');
select is((public.get_catalog_stage4c_report_v1()->'guards'->>'humanWorkPerCandidateCreated')::integer,0,
  '29 - no review work is generated per candidate');
select is((public.get_catalog_stage4c_report_v1()->'guards'->>'canonicalFactsCreated')::integer,0,
  '30 - decision read model creates no canonical facts');

select * from finish();
rollback;
