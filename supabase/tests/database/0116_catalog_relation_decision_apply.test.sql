begin;

select plan(72);

create temp table stage4e_ranked_cases as
select decision.*,
  (decision.read_model->>'affected_count')::integer as affected,
  row_number() over(
    partition by decision.family_code
    order by (decision.read_model->>'affected_count')::integer desc,
      decision.public_decision_id
  ) as family_rank
from public.catalog_relation_decisions decision
where decision.status='pending';

create temp table stage4e_class_case as
select * from stage4e_ranked_cases
where family_code='CLASS_RULE_PROMOTION'
  and read_model->'evidence_summary'->'ruleCodes' ? 'gel_color->gel_top'
limit 1;
create temp table stage4e_membership_case as
select * from stage4e_ranked_cases
where family_code='ENDPOINT_SCOPE_RECLASSIFICATION' and affected=38
limit 1;
create temp table stage4e_false_case as
select * from stage4e_ranked_cases
where family_code='FALSE_PAIR_RETIREMENT' and affected=88
limit 1;
create temp table stage4e_adjust_case as
select * from stage4e_ranked_cases
where family_code='FALSE_PAIR_RETIREMENT' and affected<>88
order by family_rank limit 1;
create temp table stage4e_reject_case as
select * from stage4e_ranked_cases
where family_code='CLASS_RULE_PROMOTION'
  and public_decision_id<>(select public_decision_id from stage4e_class_case)
order by family_rank limit 1;
create temp table stage4e_defer_case as
select * from stage4e_ranked_cases
where family_code='ENDPOINT_SCOPE_RECLASSIFICATION' and affected<>38
order by family_rank limit 1;
create temp table stage4e_stale_case as
select * from stage4e_ranked_cases
where family_code='ENDPOINT_SCOPE_RECLASSIFICATION'
  and public_decision_id not in (
    select public_decision_id from stage4e_membership_case
    union all select public_decision_id from stage4e_defer_case
  )
order by family_rank limit 1;

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,email_change,email_change_token_new,recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11600000-0000-4000-8000-000000000001',
  'authenticated','authenticated','stage4e-owner@example.invalid','',now(),
  '{}','{}',now(),now(),'','','',''
);
insert into public.admin_profiles(id,role,full_name,is_active)
values (
  '11600000-0000-4000-8000-000000000001','admin',
  'Propietaria de prueba 4E',true
);
create temp table stage4e_actor as
select '11600000-0000-4000-8000-000000000001'::uuid as actor_id;

create temp table stage4e_commercial_baseline as
select
  (select md5(coalesce(string_agg(concat_ws('|',product.id,
    product.unit_price,product.wholesale_price),'#' order by product.id),''))
    from public.products product) as price_fingerprint,
  (select md5(coalesce(string_agg(to_jsonb(price)::text,'#' order by price.id),''))
    from public.variant_prices price) as variant_price_fingerprint,
  (select md5(coalesce(string_agg(to_jsonb(stock)::text,'#' order by stock.variant_id,stock.branch_id),''))
    from public.inventory_stock stock) as stock_fingerprint,
  (select md5(coalesce(string_agg(concat_ws('|',product.id,product.is_active,
    product.editorial_status,product.published_at),'#' order by product.id),''))
    from public.products product) as publication_fingerprint;

select has_table('public','catalog_relation_decisions',
  '1 - grouped decisions are persisted');
select has_table('public','catalog_relation_decision_items',
  '2 - every decision freezes its exact affected set');
select has_table('public','catalog_relation_decision_previews',
  '3 - exact apply previews are persisted');
select has_view('public','catalog_relation_decision_queue_v1',
  '4 - product queue joins human copy and operational state');
select has_view('public','graph_stage4e_knowledge_edges_v1',
  '5 - Stage 4E knowledge has an explicit graph layer');
select has_function('public','preview_catalog_relation_decision_v1',
  array['text','text','text','bigint','text','uuid'],
  '6 - preview requires action, version and idempotency');
select has_function('public','apply_catalog_relation_decision_v1',
  array['uuid','text','text','uuid'],
  '7 - exact decision apply is available');
select has_function('public','transition_catalog_relation_decision_v1',
  array['text','bigint','text','text','integer','text','uuid'],
  '8 - save-for-later and resume use the Mesa transition contract');
select has_function('public','verify_catalog_relation_decision_v1',array['text'],
  '9 - post-sync verification is explicit');

select is((select count(*) from public.catalog_relation_decisions),18::bigint,
  '10 - the 18 real Stage 4C decisions are persisted');
select is((select count(distinct work_item_id) from public.catalog_relation_decisions),18::bigint,
  '11 - there is one Mesa work item per shared cause');
select is((select count(*) from public.catalog_relation_decision_items),263::bigint,
  '12 - frozen decisions cover all 263 human-actionable detections');
select is((select count(distinct family_code) from public.catalog_relation_decisions),3::bigint,
  '13 - all three decision families are operational');
select ok((public.get_catalog_stage4e_report_v1()->'guards'->>'oneWorkPerSharedDecision')::boolean,
  '14 - the report certifies one work item per decision');

select is((public.get_catalog_relation_decision_queue_v1('pending',25,0)->>'total')::integer,18,
  '15 - the live queue starts with 18 pending decisions');
select is(jsonb_array_length(
  public.get_catalog_relation_decision_queue_v1('pending',3,0)->'decisions'),3,
  '16 - queue pagination is backend-owned');
select is((select count(*) from public.catalog_relation_decision_queue_v1
  where nullif(trim(title),'') is null or nullif(trim(problem),'') is null
    or nullif(trim(recommendation),'') is null or nullif(trim(solves),'') is null
    or nullif(trim(uncertain_behavior),'') is null),0::bigint,
  '17 - every card explains problem, recommendation, result and uncertainty');
select is((select count(*) from public.catalog_relation_decision_queue_v1
  where to_jsonb(catalog_relation_decision_queue_v1)::text ilike '%Evidencia heurística%'),0::bigint,
  '18 - the owner never receives the rejected technical phrase');
select is((select count(*) from public.catalog_relation_decision_queue_v1
  where jsonb_array_length(actions)<>3),0::bigint,
  '19 - every pending case includes decide, adjust-or-reject, and save-for-later');

select is((public.get_catalog_relation_decision_detail_v1(
  (select public_decision_id from stage4e_class_case),25,0)->>'affectedTotal')::integer,19,
  '20 - the real gel color to gel top case exposes all 19 affected pairs');
select ok((public.get_catalog_relation_decision_detail_v1(
  (select public_decision_id from stage4e_class_case),1,0)
    ->'affected'->0->>'evidenceLabel') like 'Lo identificamos por el nombre%',
  '21 - heuristic evidence is explained in natural language');
select is(jsonb_typeof(public.get_catalog_relation_decision_detail_v1(
  (select public_decision_id from stage4e_class_case),1,0)
    ->'affected'->0->'audit'),'object',
  '22 - technical evidence remains available on demand');
select is((select count(*) from stage4e_actor),1::bigint,
  '23 - acceptance tests have one accountable administrator');

create temp table stage4e_defer_result as
select public.transition_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_defer_case),
  (select work.row_version from stage4e_defer_case decision
    join public.catalog_review_work_items work on work.id=decision.work_item_id),
  'KEEP_DEFERRED','Quiero revisar la ficha antes de decidir.',1440,
  'pgtap-stage4e-defer-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'decisionResolved' from stage4e_defer_result)::boolean,false,
  '24 - save-for-later never resolves the decision');
select is((select status from public.catalog_relation_decisions
  where id=(select id from stage4e_defer_case)),'pending',
  '25 - deferred decision remains pending');
select ok((select work.defer_reason is not null and work.deferred_until>now()
  from stage4e_defer_case decision
  join public.catalog_review_work_items work on work.id=decision.work_item_id),
  '26 - note and return date are stored together');
select is((select count(*) from public.catalog_review_events event
  where event.work_item_id=(select work_item_id from stage4e_defer_case)
    and event.event_type='work_deferred'),1::bigint,
  '27 - defer is preserved as an immutable event');
select is((public.transition_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_defer_case),1,'KEEP_DEFERRED',
  'Quiero revisar la ficha antes de decidir.',1440,'pgtap-stage4e-defer-0001',
  (select actor_id from stage4e_actor))->'transition'->>'idempotentReplay')::boolean,true,
  '28 - repeating the same defer is idempotent');
select is((public.transition_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_defer_case),
  (select row_version from public.catalog_review_work_items
    where id=(select work_item_id from stage4e_defer_case)),
  'RESUME',null,1440,'pgtap-stage4e-resume-0001',
  (select actor_id from stage4e_actor))->'transition'->>'deferredUntil'),null,
  '29 - resume clears the pending note date without resolving the case');

create temp table stage4e_class_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_class_case),'ACCEPT_CLASS_RULE',
  'Confirmo solo los productos mostrados.',
  (select row_version from public.catalog_review_work_items
    where id=(select work_item_id from stage4e_class_case)),
  'pgtap-stage4e-class-preview-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_class_preview),'previewed',
  '30 - class decision starts as preview only');
select is(length((select result->>'previewFingerprint' from stage4e_class_preview)),64,
  '31 - preview confirmation has a SHA-256 fingerprint');
select is((select result->'impact'->>'candidateRowsChanged'
  from stage4e_class_preview)::integer,19,
  '32 - gel color to gel top preview names exactly 19 candidate changes');
select is((public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_class_case),'ACCEPT_CLASS_RULE',
  'Confirmo solo los productos mostrados.',1,
  'pgtap-stage4e-class-preview-0001',(select actor_id from stage4e_actor)
  )->>'idempotentReplay')::boolean,true,
  '33 - identical preview calls are idempotent');
select throws_ok($$
  select public.preview_catalog_relation_decision_v1(
    (select public_decision_id from stage4e_class_case),'ACCEPT_CLASS_RULE',
    'Otro comentario',1,'pgtap-stage4e-class-preview-0001',
    (select actor_id from stage4e_actor))
$$,'23505','La clave idempotente ya fue usada para otro preview.',
  '34 - a preview key cannot represent another request');
select throws_ok($$
  select public.apply_catalog_relation_decision_v1(
    (select (result->>'previewId')::uuid from stage4e_class_preview),repeat('0',64),
    'pgtap-stage4e-class-apply-wrong',(select actor_id from stage4e_actor))
$$,'40001','La confirmacion no coincide con el preview que se mostro.',
  '35 - apply rejects a fingerprint the owner did not see');

create temp table stage4e_class_apply as
select public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_class_preview),
  (select result->>'previewFingerprint' from stage4e_class_preview),
  'pgtap-stage4e-class-apply-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_class_apply),'applied',
  '36 - exact class-rule apply resolves the decision');
select is((public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_class_preview),
  (select result->>'previewFingerprint' from stage4e_class_preview),
  'pgtap-stage4e-class-apply-0001',(select actor_id from stage4e_actor)
  )->>'idempotentReplay')::boolean,true,
  '37 - repeating the same exact apply is idempotent');
select is((select count(*) from public.catalog_relation_candidates candidate
  join public.catalog_relation_decision_items item on item.candidate_id=candidate.id
  where item.decision_id=(select id from stage4e_class_case)
    and candidate.status='approved' and candidate.resolution_kind='class_rule'),19::bigint,
  '38 - all and only 19 frozen candidates record class-rule resolution');
select is((select count(*) from public.catalog_relation_rules rule
  where rule.metadata->>'stage4eDecisionId'=
    (select public_decision_id from stage4e_class_case)),1::bigint,
  '39 - one shared rule replaces 19 row-level interpretations');
select is((select count(*) from public.catalog_class_members member
  where member.metadata->>'stage4eDecisionId'=
    (select public_decision_id from stage4e_class_case)),
  (select (result->'impact'->>'classMembershipRowsConfirmed')::bigint
    from stage4e_class_apply),
  '40 - only memberships frozen in the preview are confirmed');
select is((select count(*) from public.graph_edges_v2 edge
  where edge.properties->>'decisionId'=(select public_decision_id from stage4e_class_case)
    and edge.layer<>'evidence'),0::bigint,
  '41 - accepted inferred knowledge is never projected as canonical');
select ok((public.verify_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_class_case))->>'passed')::boolean,
  '42 - apply audit and graph projection pass post-sync verification');
select is((select count(*) from public.catalog_semantic_claims
  where claim_key like 'stage4e:%' and epistemic_class='CANONICAL_FACT'),0::bigint,
  '43 - human acceptance creates no canonical semantic fact');

create temp table stage4e_membership_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_membership_case),'ACCEPT_MEMBERSHIP_SCOPE',
  null,1,'pgtap-stage4e-membership-preview-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->'impact'->>'candidateRowsChanged'
  from stage4e_membership_preview)::integer,38,
  '44 - the real drill case previews exactly 38 candidate changes');
create temp table stage4e_membership_apply as
select public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_membership_preview),
  (select result->>'previewFingerprint' from stage4e_membership_preview),
  'pgtap-stage4e-membership-apply-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_membership_apply),'applied',
  '45 - membership-scope correction applies successfully');
select is((select count(*) from public.catalog_relation_candidates candidate
  join public.catalog_relation_decision_items item on item.candidate_id=candidate.id
  where item.decision_id=(select id from stage4e_membership_case)
    and candidate.status='approved' and candidate.resolution_kind='class_membership'),38::bigint,
  '46 - 38 drill pairs become historical membership resolutions');
select is((select count(*) from public.catalog_relation_rules rule
  where rule.metadata->>'stage4eDecisionId'=
    (select public_decision_id from stage4e_membership_case)),0::bigint,
  '47 - scope correction creates no pair or class relation rule');
select is((select count(*) from public.catalog_class_members member
  where member.metadata->>'stage4eDecisionId'=
      (select public_decision_id from stage4e_membership_case)
    or coalesce(member.metadata->'stage4eDecisionIds','[]'::jsonb)
      ? (select public_decision_id from stage4e_membership_case)),
  (select (result->'impact'->>'classMembershipRowsConfirmed')::bigint
    from stage4e_membership_apply),
  '48 - drill scope confirms only the exact observed memberships');

create temp table stage4e_false_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_false_case),'ACCEPT_FALSE_PAIR_RETIREMENT',
  null,1,'pgtap-stage4e-false-preview-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->'impact'->>'candidateRowsChanged'
  from stage4e_false_preview)::integer,88,
  '49 - lamp false-pair preview names exactly 88 candidates');
create temp table stage4e_false_apply as
select public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_false_preview),
  (select result->>'previewFingerprint' from stage4e_false_preview),
  'pgtap-stage4e-false-apply-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_false_apply),'applied',
  '50 - confirmed false pairs are retired');
select is((select count(*) from public.catalog_relation_candidates candidate
  join public.catalog_relation_decision_items item on item.candidate_id=candidate.id
  where item.decision_id=(select id from stage4e_false_case)
    and candidate.status='rejected' and candidate.resolution_kind='incorrect'),88::bigint,
  '51 - all 88 lamp false pairs are rejected without deletion');
select is((select count(*) from public.catalog_relation_decision_items
  where decision_id=(select id from stage4e_false_case)),88::bigint,
  '52 - immutable false-pair history remains complete');
select is((select count(*) from public.catalog_relation_rules rule
    where rule.metadata->>'stage4eDecisionId'=
      (select public_decision_id from stage4e_false_case))
  + (select count(*) from public.catalog_class_members member
    where member.metadata->>'stage4eDecisionId'=
      (select public_decision_id from stage4e_false_case)),0::bigint,
  '53 - false-pair retirement creates no positive knowledge');

select throws_ok($$
  select public.preview_catalog_relation_decision_v1(
    (select public_decision_id from stage4e_adjust_case),'ADJUST_ENDPOINT_PROFILE',
    null,1,'pgtap-stage4e-adjust-missing-note',(select actor_id from stage4e_actor))
$$,'22023','Esta accion exige una explicacion breve.',
  '54 - requesting an adjustment requires a useful note');
create temp table stage4e_adjust_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_adjust_case),'ADJUST_ENDPOINT_PROFILE',
  'Este accesorio necesita una regla mas precisa.',1,
  'pgtap-stage4e-adjust-preview-0001',(select actor_id from stage4e_actor)
) as result;
create temp table stage4e_adjust_apply as
select public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_adjust_preview),
  (select result->>'previewFingerprint' from stage4e_adjust_preview),
  'pgtap-stage4e-adjust-apply-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_adjust_apply),'adjustment_requested',
  '55 - owner can resolve the current version by requesting an adjustment');
select is((select count(*) from public.catalog_relation_candidates candidate
  join public.catalog_relation_decision_items item on item.candidate_id=candidate.id
  where item.decision_id=(select id from stage4e_adjust_case)
    and candidate.status='needs_evidence'),
  (select affected::bigint from stage4e_adjust_case),
  '56 - adjustment request does not decide source candidates');

create temp table stage4e_reject_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_reject_case),'REJECT_CLASS_RULE',
  'El patron no representa una regla general.',1,
  'pgtap-stage4e-reject-preview-0001',(select actor_id from stage4e_actor)
) as result;
create temp table stage4e_reject_apply as
select public.apply_catalog_relation_decision_v1(
  (select (result->>'previewId')::uuid from stage4e_reject_preview),
  (select result->>'previewFingerprint' from stage4e_reject_preview),
  'pgtap-stage4e-reject-apply-0001',(select actor_id from stage4e_actor)
) as result;
select is((select result->>'status' from stage4e_reject_apply),'rejected',
  '57 - owner can reject the grouped promotion');
select is((select count(*) from public.catalog_relation_candidates candidate
  join public.catalog_relation_decision_items item on item.candidate_id=candidate.id
  where item.decision_id=(select id from stage4e_reject_case)
    and candidate.status='needs_evidence'),
  (select affected::bigint from stage4e_reject_case),
  '58 - rejecting a promotion does not silently reject historical candidates');
select is((select count(*) from public.catalog_relation_rules rule
  where rule.metadata->>'stage4eDecisionId'=
    (select public_decision_id from stage4e_reject_case)),0::bigint,
  '59 - rejected promotion creates no class rule');

create temp table stage4e_stale_preview as
select public.preview_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_stale_case),'ADJUST_ENDPOINT_PROFILE',
  'Quiero revisar esta propuesta.',1,'pgtap-stage4e-stale-preview-0001',
  (select actor_id from stage4e_actor)
) as result;
select ok((public.transition_catalog_relation_decision_v1(
  (select public_decision_id from stage4e_stale_case),1,'KEEP_DEFERRED',
  'Falta revisar otra ficha.',60,'pgtap-stage4e-stale-defer-0001',
  (select actor_id from stage4e_actor))->'transition'->>'rowVersion')::bigint>1,
  '60 - a later note advances the optimistic work version');
select throws_ok($$
  select public.apply_catalog_relation_decision_v1(
    (select (result->>'previewId')::uuid from stage4e_stale_preview),
    (select result->>'previewFingerprint' from stage4e_stale_preview),
    'pgtap-stage4e-stale-apply-0001',(select actor_id from stage4e_actor))
$$,'40001','El caso cambio desde el preview; revisa la version actual.',
  '61 - apply refuses a case changed while the owner was thinking');

select is((select md5(coalesce(string_agg(concat_ws('|',product.id,
    product.unit_price,product.wholesale_price),'#' order by product.id),''))
  from public.products product),
  (select price_fingerprint from stage4e_commercial_baseline),
  '62 - no decision changes product prices');
select is((select md5(coalesce(string_agg(to_jsonb(price)::text,'#' order by price.id),''))
  from public.variant_prices price),
  (select variant_price_fingerprint from stage4e_commercial_baseline),
  '63 - no decision changes variant price lists');
select is((select md5(coalesce(string_agg(to_jsonb(stock)::text,'#'
    order by stock.variant_id,stock.branch_id),'')) from public.inventory_stock stock),
  (select stock_fingerprint from stage4e_commercial_baseline),
  '64 - no decision changes stock');
select is((select md5(coalesce(string_agg(concat_ws('|',product.id,product.is_active,
    product.editorial_status,product.published_at),'#' order by product.id),''))
  from public.products product),
  (select publication_fingerprint from stage4e_commercial_baseline),
  '65 - no decision changes publication state');
select is((select count(*) from public.catalog_review_events
  where idempotency_key like 'pgtap-stage4e-%-apply-0001'
    and event_type='decision_taken'),5::bigint,
  '66 - every successful decision has one immutable audit event');
select is((public.get_catalog_stage4e_report_v1()->'guards'->>'canonicalFactsCreated')::integer,0,
  '67 - Stage 4E report certifies zero canonical facts');
select is((public.get_catalog_stage4e_report_v1()->'guards'->>'commercialEffects')::integer,0,
  '68 - Stage 4E report certifies zero commercial effects');
select is((select count(*) from pg_class
  where oid in ('public.catalog_relation_decisions'::regclass,
    'public.catalog_relation_decision_items'::regclass,
    'public.catalog_relation_decision_previews'::regclass)
    and relrowsecurity),3::bigint,
  '69 - every Stage 4E persistence table enforces RLS');
select throws_ok($$
  update public.catalog_relation_decision_items set ordinal=ordinal
  where decision_id=(select id from stage4e_class_case)
$$,'55000','Los elementos congelados de una decision no se pueden reescribir.',
  '70 - frozen affected sets remain immutable');
select is((select count(*) from public.graph_edges_v2 edge
  where edge.properties->>'decisionId'=(select public_decision_id from stage4e_class_case)
    and edge.predicate='PRECEDES' and edge.layer='evidence'),1::bigint,
  '71 - the gel workflow rule reaches the graph with its universal predicate');
select is((public.get_catalog_stage4e_report_v1()->'guards'
  ->>'uncertainProductsInheritAutomatically')::boolean,false,
  '72 - uncertain products never inherit a class or rule automatically');

select * from finish();
rollback;
