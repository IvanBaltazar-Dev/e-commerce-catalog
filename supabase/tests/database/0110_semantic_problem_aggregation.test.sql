begin;

select plan(49);

select has_table('public', 'catalog_semantic_problem_groups', '1 - semantic problem groups exist');
select has_table('public', 'catalog_semantic_problems', '2 - individual semantic detections exist');
select has_view('public', 'catalog_semantic_problem_groups_v1', '3 - grouped problems have an auditable read model');
select has_view('public', 'catalog_semantic_campaign_funnel_v1', '4 - every campaign has the required funnel');
select has_view('public', 'catalog_semantic_scaling_v1', '5 - human scaling has a longitudinal indicator');
select has_function('public', 'get_catalog_semantic_campaign_report_v1', array['uuid'], '6 - campaign report is queryable');
select has_view('public', 'graph_semantic_problem_group_nodes_v1', '7 - grouped problems are graph nodes');
select has_view('public', 'graph_semantic_problem_group_edges_v1', '8 - group escalation is projected once');

insert into public.catalog_research_runs(
  id, run_key, run_kind, actor_kind, actor_label, status,
  input_fingerprint, scope, metrics, errors, result
) values (
  '11000000-0000-4000-8000-000000000001',
  'semantic-human-scale-fixture', 'targeted', 'system', 'pgTAP 0110', 'running',
  'semantic-human-scale-input', '{"synthetic":true}'::jsonb,
  '{}'::jsonb, '[]'::jsonb, '{}'::jsonb
);

create temporary table semantic_scale_source as
select source.id as source_id, source.brand_id, record.id as source_record_id
from public.catalog_sources source
join public.catalog_source_records record on record.source_id = source.id
where record.entity_type = 'product'
order by source.id, record.id
limit 1;

insert into public.catalog_reference_products(
  id, reference_key, brand_id, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, family, product_type,
  source_url, identity_fingerprint, content_fingerprint,
  first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
)
select fixture.id, fixture.reference_key, source.brand_id, source.source_id,
  source.source_record_id, fixture.external_id, fixture.name, fixture.normalized_name,
  'Synthetic equipment', 'Electrical equipment', fixture.source_url,
  fixture.identity_fingerprint, fixture.content_fingerprint,
  '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001', now(), now()
from semantic_scale_source source
cross join (values
  ('11000000-0000-4000-8000-000000000101'::uuid, 'semantic-scale-product-1',
   'semantic-scale-external-1', 'Synthetic equipment 1', 'synthetic equipment 1',
   'https://semantic-scale.invalid/products/1', 'semantic-scale-identity-1', 'semantic-scale-content-1'),
  ('11000000-0000-4000-8000-000000000102'::uuid, 'semantic-scale-product-2',
   'semantic-scale-external-2', 'Synthetic equipment 2', 'synthetic equipment 2',
   'https://semantic-scale.invalid/products/2', 'semantic-scale-identity-2', 'semantic-scale-content-2'),
  ('11000000-0000-4000-8000-000000000103'::uuid, 'semantic-scale-product-3',
   'semantic-scale-external-3', 'Synthetic equipment 3', 'synthetic equipment 3',
   'https://semantic-scale.invalid/products/3', 'semantic-scale-identity-3', 'semantic-scale-content-3')
) fixture(id, reference_key, external_id, name, normalized_name, source_url,
          identity_fingerprint, content_fingerprint);

create temporary table semantic_scale_products as
select row_number() over (order by product.id) as ordinal,
       product.id as reference_product_id,
       product.primary_source_record_id as source_record_id
from public.catalog_reference_products product
where product.reference_key like 'semantic-scale-product-%'
order by product.id
limit 3;

select is((select count(*) from semantic_scale_products), 3::bigint,
  '9 - fixture has three independently affected products');

insert into public.catalog_observations(
  id, observation_key, source_record_id, research_run_id, reference_product_id,
  observation_kind, predicate, value_json, observed_at,
  extraction_method, extractor, confidence, metadata
)
select
  case ordinal
    when 1 then '11000000-0000-4000-8000-000000000011'::uuid
    else '11000000-0000-4000-8000-000000000012'::uuid
  end,
  'semantic-human-scale-claim-' || ordinal,
  source_record_id, '11000000-0000-4000-8000-000000000001', reference_product_id,
  'semantic_claim', 'semantic.benefit',
  jsonb_build_object(
    'termCode', 'fixture_claim_' || ordinal,
    'claimStatus', 'source_claim',
    'claimKind', 'manufacturer_declared',
    'sourceExcerpt', 'Fixture claim ' || ordinal,
    'evidenceFingerprint', 'fixture-claim-' || ordinal
  ), now(), 'official_page', 'universal-fixture-v1', 0.9,
  '{"epistemicStatus":"source_claim"}'::jsonb
from semantic_scale_products
where ordinal <= 2;

select is((select count(*) from public.catalog_observations
  where research_run_id = '11000000-0000-4000-8000-000000000001'
    and observation_kind = 'semantic_claim'), 2::bigint,
  '10 - fixture campaign contains two claims');

select lives_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'unknown-voltage',
    (select reference_product_id from semantic_scale_products where ordinal = 1),
    'unknown', 'missing_source_value', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    '11000000-0000-4000-8000-000000000011', false, false
  ) $$,
  '11 - UNKNOWN is recorded as a problem without automatic human work'
);

select lives_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'derived-voltage',
    (select reference_product_id from semantic_scale_products where ordinal = 2),
    'derived', 'derived_claim_requires_rule_check', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    '11000000-0000-4000-8000-000000000012', false, false
  ) $$,
  '12 - DERIVED is recorded without becoming a human exception'
);

select lives_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'uncertain-voltage',
    (select reference_product_id from semantic_scale_products where ordinal = 3),
    'inferred_uncertain', 'ambiguous_unit', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    null, false, false
  ) $$,
  '13 - uncertain inference remains automatic debt by default'
);

select is((select count(*) from public.catalog_semantic_problem_groups
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 1::bigint,
  '14 - three detections from one rule produce one shared problem');
select is((select count(*) from public.catalog_semantic_problems
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 3::bigint,
  '15 - individual detections remain traceable inside the shared problem');
select is((select count(*) from public.catalog_review_work_items work
  join public.catalog_semantic_problem_groups problem_group on problem_group.id = work.source_id
  where work.context->>'semanticOrigin' = 'problem_group'
    and problem_group.research_run_id = '11000000-0000-4000-8000-000000000001'), 0::bigint,
  '16 - epistemic states alone create no Mesa work');

select throws_ok(
  $$ select public.escalate_catalog_semantic_problem_group_v1(
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'Choose the voltage interpretation'
  ) $$,
  '23514',
  'La Mesa solo recibe ambiguedades que bloquean una decision y requieren criterio humano.',
  '17 - a non-blocking group cannot be escalated'
);

select throws_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'invalid-human-signal',
    (select reference_product_id from semantic_scale_products where ordinal = 1),
    'inferred_uncertain', 'ambiguous_unit', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    null, false, true
  ) $$,
  '23514',
  'El criterio humano solo puede solicitarse para una decision bloqueada.',
  '18 - human judgment cannot be requested without a blocked decision'
);

select lives_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'blocking-voltage-ambiguity',
    (select reference_product_id from semantic_scale_products where ordinal = 1),
    'contradicted', 'mutually_exclusive_voltage', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    null, true, true
  ) $$,
  '19 - a real blocking ambiguity can mark its shared group as human-eligible'
);

select is((select problem_count from public.catalog_semantic_problem_groups_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 4::bigint,
  '20 - the blocker joins the existing rule group');
select is((select affected_product_count from public.catalog_semantic_problem_groups_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 3::bigint,
  '21 - affected products are a set on the rule problem');

select throws_ok(
  $$ select public.register_catalog_review_work_item_v1(
    'semantic_illegal_product_review', 'manual',
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'decision', 'other', 'product',
    (select reference_product_id from semantic_scale_products where ordinal = 1),
    'illegal-product-review-fingerprint', 'Review this product', null,
    (select group_key from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'normal', 'normal', true, 0, 0::numeric, 1::smallint,
    jsonb_build_object(
      'semanticOrigin', 'problem_group',
      'affectedSetFingerprint', (select affected_set_fingerprint
        from public.catalog_semantic_problem_groups_v1
        where research_run_id = '11000000-0000-4000-8000-000000000001')
    )
  ) $$,
  '23514',
  'La Mesa debe decidir la regla agregada, no revisar productos individuales.',
  '22 - direct per-product Mesa work is rejected for semantic problems'
);

select throws_ok(
  $$ select public.register_catalog_review_work_item_v1(
    'semantic_unmarked_bypass', 'manual',
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'decision', 'other', 'rule', null,
    'unmarked-bypass-fingerprint', 'Bypass the semantic contract', null,
    null, 'normal', 'normal', false, 0, 0::numeric, 1::smallint, '{}'::jsonb
  ) $$,
  '23514',
  'Un grupo semantico no puede entrar a Mesa por una ruta individual o sin contrato de agregacion.',
  '23 - an unmarked manual path cannot bypass semantic aggregation'
);

select lives_ok(
  $$ select public.escalate_catalog_semantic_problem_group_v1(
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'Which interpretation must normalize voltage for the affected set?',
    'Resolve normalize_voltage_v1 once and reprocess the complete set.',
    'high', 'high'
  ) $$,
  '24 - the eligible rule group creates one Mesa exception'
);

select is((select count(*) from public.catalog_review_work_items work
  where work.source_id = (select id from public.catalog_semantic_problem_groups
    where research_run_id = '11000000-0000-4000-8000-000000000001')
    and work.status in ('open', 'in_progress')), 1::bigint,
  '25 - only one active human job represents the entire rule set');
select is((select subject_type from public.catalog_review_work_items work
  where work.source_id = (select id from public.catalog_semantic_problem_groups
    where research_run_id = '11000000-0000-4000-8000-000000000001')
    and work.status in ('open', 'in_progress')), 'rule',
  '26 - the Mesa subject is the rule, not a product');
select is((select (context->>'affectedProductCount')::bigint
  from public.catalog_review_work_items work
  where work.source_id = (select id from public.catalog_semantic_problem_groups
    where research_run_id = '11000000-0000-4000-8000-000000000001')
    and work.status in ('open', 'in_progress')), 3::bigint,
  '27 - Mesa receives the cardinality of the affected set');
select is((select count(*) from public.catalog_review_work_items work
  where work.context->>'semanticOrigin' = 'problem_group'
    and work.subject_type = 'product'), 0::bigint,
  '28 - semantic escalation never emits product-level work');

select is(
  (select id from public.escalate_catalog_semantic_problem_group_v1(
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'),
    'Which interpretation must normalize voltage for the affected set?',
    'Resolve normalize_voltage_v1 once and reprocess the complete set.',
    'high', 'high')),
  (select id from public.catalog_review_work_items work
   where work.source_id = (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001')
     and work.status in ('open', 'in_progress')),
  '29 - identical escalation is idempotent'
);

select throws_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'partition-without-proof',
    (select reference_product_id from semantic_scale_products where ordinal = 2),
    'contradicted', 'regional_voltage_conflict', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    null, true, true, 'rule_code', 'region-a', null
  ) $$,
  '23514',
  'Dividir una regla exige demostrar por que un unico conjunto afectado no basta.',
  '30 - a second group for one rule is forbidden without proof'
);

select lives_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'partition-with-proof',
    (select reference_product_id from semantic_scale_products where ordinal = 2),
    'contradicted', 'regional_voltage_conflict', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    null, true, true, 'rule_code', 'region-a',
    'La normativa electrica regional exige una decision distinta e incompatible.'
  ) $$,
  '31 - a proven non-aggregable partition is representable'
);

select is((select count(*) from public.catalog_semantic_problem_groups
  where research_run_id = '11000000-0000-4000-8000-000000000001'
    and rule_code = 'normalize_voltage_v1'), 2::bigint,
  '32 - the same rule has a second group only after explicit proof');
select ok((select bool_and(non_aggregation_justification is not null)
  from public.catalog_semantic_problem_groups
  where research_run_id = '11000000-0000-4000-8000-000000000001'
    and partition_key is not null),
  '33 - every partition carries its non-aggregation justification');

select lives_ok(
  $$ select public.escalate_catalog_semantic_problem_group_v1(
    (select id from public.catalog_semantic_problem_groups
     where research_run_id = '11000000-0000-4000-8000-000000000001'
       and partition_key = 'region-a'),
    'Which regional rule applies to this non-aggregable set?',
    'Decide the regional rule once.', 'normal', 'high'
  ) $$,
  '34 - the justified partition can create its own group-level exception'
);

select is((select count(*) from public.catalog_review_work_items work
  join public.catalog_semantic_problem_groups problem_group on problem_group.id = work.source_id
  where problem_group.research_run_id = '11000000-0000-4000-8000-000000000001'
    and work.context->>'semanticOrigin' = 'problem_group'
    and work.status not in ('superseded', 'cancelled')), 2::bigint,
  '35 - five detected problems result in only two justified human exceptions');
select ok((select bool_and(work.subject_type = 'rule' and work.subject_id is null)
  from public.catalog_review_work_items work
  join public.catalog_semantic_problem_groups problem_group on problem_group.id = work.source_id
  where problem_group.research_run_id = '11000000-0000-4000-8000-000000000001'
    and work.context->>'semanticOrigin' = 'problem_group'),
  '36 - every human exception remains rule-level');

select is((select products_investigated from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 3::bigint,
  '37 - funnel reports products investigated');
select is((select claims from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 2::bigint,
  '38 - funnel reports claims');
select is((select problems_detected from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 5::bigint,
  '39 - funnel reports individual problems detected');
select is((select problems_grouped from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 2::bigint,
  '40 - funnel reports shared problem groups');
select is((select rules_affected from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 1::bigint,
  '41 - funnel reports distinct rules affected');
select is((select human_exceptions from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 2::bigint,
  '42 - funnel reports group-level human exceptions');
select is((select individual_review_avoidance_ratio from public.catalog_semantic_campaign_funnel_v1
  where research_run_id = '11000000-0000-4000-8000-000000000001'), 0.6000::numeric,
  '43 - campaign quantifies avoided individual reviews');

select is((select (public.get_catalog_semantic_campaign_report_v1(
  '11000000-0000-4000-8000-000000000001')->'flow'->>'productsInvestigated')::bigint),
  3::bigint, '44 - JSON report preserves the complete flow');
select is((select (public.get_catalog_semantic_campaign_report_v1(
  '11000000-0000-4000-8000-000000000001')->'problemGroups'->0->>'affectedSetFingerprint') is not null),
  true, '45 - report exposes each grouped affected-set fingerprint');

select is((select count(*) from public.graph_semantic_problem_group_nodes_v1 node
  where (node.properties->>'researchRunId')::uuid = '11000000-0000-4000-8000-000000000001'),
  2::bigint, '46 - graph projects one node per shared problem');
select is((select count(*) from public.graph_semantic_problem_group_edges_v1 edge
  join public.graph_semantic_problem_group_nodes_v1 node on node.node_key = edge.source_key
  where (node.properties->>'researchRunId')::uuid = '11000000-0000-4000-8000-000000000001'),
  2::bigint, '47 - graph projects one escalation edge per group');
select is((select count(*) from public.graph_edges_v2 edge
  where edge.source_key like 'semantic_problem_group:%'
    and edge.target_key like 'reference_product:%'),
  0::bigint, '48 - graph does not explode affected sets into product edges');

select throws_ok(
  $$ select public.register_catalog_semantic_problem_v1(
    '11000000-0000-4000-8000-000000000001', 'unknown-voltage',
    (select reference_product_id from semantic_scale_products where ordinal = 1),
    'unknown', 'different_material_problem', 'unit_rule_missing',
    'normalize_voltage_v1', 'electrical_equipment', 'voltage',
    '11000000-0000-4000-8000-000000000011', false, false
  ) $$,
  '23505',
  'La clave del problema ya representa otra evidencia material.',
  '49 - a problem key cannot silently change material evidence'
);

select * from finish();
rollback;
