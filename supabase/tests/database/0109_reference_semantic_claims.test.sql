begin;

select plan(20);

select has_table('public', 'catalog_semantic_terms', '1 - normalized semantic vocabulary exists');
select has_table('public', 'catalog_observation_semantic_terms', '2 - observation normalization state exists');
select has_view('public', 'catalog_reference_product_semantics_v1', '3 - semantic claims have auditable read model');
select has_view('public', 'catalog_reference_semantic_coverage_v1', '4 - semantic coverage has read model');
select has_view('public', 'graph_semantic_term_nodes_v1', '5 - semantic vocabulary has graph nodes');
select has_view('public', 'graph_semantic_term_edges_v1', '6 - semantic normalizations have graph edges');
select col_is_pk('public', 'catalog_observation_semantic_terms', 'observation_id', '7 - one active normalization record per observation');

create temporary table semantic_fixture as
select reference.id as reference_product_id,
       reference.primary_source_record_id as source_record_id
from public.catalog_reference_products reference
where reference.primary_source_record_id is not null
order by reference.id
limit 1;

select is((select count(*) from semantic_fixture), 1::bigint, '8 - fixture has external reference provenance');

insert into public.catalog_semantic_terms(id, dimension, code, label, metadata)
values
  ('10900000-0000-4000-8000-000000000001', 'benefit', 'fixture_strengthening', 'Fortalecimiento declarado',
   '{"isCanonicalTechnicalFact":false}'::jsonb),
  ('10900000-0000-4000-8000-000000000002', 'ingredient', 'fixture_biotin', 'Biotina',
   '{"isCanonicalTechnicalFact":false}'::jsonb);

insert into public.catalog_observations(
  id, observation_key, source_record_id, reference_product_id,
  observation_kind, predicate, value_json, observed_at,
  extraction_method, extractor, confidence, metadata
) select
  '10900000-0000-4000-8000-000000000010', 'stage-semantic-valid', source_record_id, reference_product_id,
  'semantic_claim', 'semantic.benefit',
  '{"termCode":"fixture_strengthening","claimStatus":"source_claim","claimKind":"manufacturer_declared","sourceExcerpt":"La fuente declara fortalecimiento.","evidenceFingerprint":"fixture-evidence"}'::jsonb,
  now(), 'official_page', 'generic-fixture-v1', 0.95,
  '{"epistemicStatus":"source_claim","isCanonicalTechnicalFact":false}'::jsonb
from semantic_fixture;

select lives_ok(
  $$ insert into public.catalog_observation_semantic_terms(
       observation_id, semantic_term_id, normalization_status, normalization_method, confidence, metadata
     ) values (
       '10900000-0000-4000-8000-000000000010',
       '10900000-0000-4000-8000-000000000001',
       'observed', 'generic-fixture-v1', 0.95, '{"isCanonicalTechnicalFact":false}'::jsonb
     ) $$,
  '9 - source claim can be normalized with state and confidence'
);

select is(
  (select claim_status from public.catalog_reference_product_semantics_v1
   where observation_id = '10900000-0000-4000-8000-000000000010'),
  'source_claim',
  '10 - read model preserves source claim status'
);
select is(
  (select source_excerpt from public.catalog_reference_product_semantics_v1
   where observation_id = '10900000-0000-4000-8000-000000000010'),
  'La fuente declara fortalecimiento.',
  '11 - read model preserves bounded source evidence'
);
select is(
  (select layer from public.graph_semantic_term_nodes_v1
   where entity_id = '10900000-0000-4000-8000-000000000001'),
  'evidence',
  '12 - semantic term stays in evidence graph layer'
);
select is(
  (select (properties->>'isCanonicalTechnicalFact')::boolean
   from public.graph_semantic_term_nodes_v1
   where entity_id = '10900000-0000-4000-8000-000000000001'),
  false,
  '13 - graph explicitly rejects canonical technical truth'
);
select is(
  (select predicate from public.graph_semantic_term_edges_v1
   where source_key = 'observation:10900000-0000-4000-8000-000000000010'),
  'NORMALIZES_TO',
  '14 - graph connects observation to vocabulary, not product to canonical fact'
);
select is(
  (select count(*) from public.graph_edges_v2
   where target_key = 'semantic_term:10900000-0000-4000-8000-000000000001'
     and layer = 'canonical'),
  0::bigint,
  '15 - graph exposes no canonical edge to semantic term'
);

select throws_ok(
  $$ insert into public.catalog_observation_semantic_terms(
       observation_id, semantic_term_id, normalization_status, normalization_method, confidence
     ) values (
       '10900000-0000-4000-8000-000000000010',
       '10900000-0000-4000-8000-000000000002',
       'observed', 'invalid-dimension', 1
     )
     on conflict (observation_id) do update set semantic_term_id = excluded.semantic_term_id $$,
  '23514',
  'La dimension del termino no coincide con el predicado observado.',
  '16 - dimension mismatch is rejected'
);

insert into public.catalog_observations(
  id, observation_key, source_record_id, reference_product_id,
  observation_kind, predicate, value_text, observed_at,
  extraction_method, extractor, confidence, metadata
) select
  '10900000-0000-4000-8000-000000000011', 'stage-semantic-invalid-kind', source_record_id, reference_product_id,
  'identity', 'official.title', 'Titulo observado', now(),
  'official_page', 'generic-fixture-v1', 1, '{}'::jsonb
from semantic_fixture;

select throws_ok(
  $$ insert into public.catalog_observation_semantic_terms(
       observation_id, semantic_term_id, normalization_status, normalization_method, confidence
     ) values (
       '10900000-0000-4000-8000-000000000011',
       '10900000-0000-4000-8000-000000000001',
       'observed', 'invalid-kind', 1
     ) $$,
  '23514',
  'Solo una observacion semantic_claim puede normalizarse a un termino.',
  '17 - non-claim observations cannot acquire semantic meaning'
);

select is(
  (select normalization_status from public.catalog_observation_semantic_terms
   where observation_id = '10900000-0000-4000-8000-000000000010'),
  'observed',
  '18 - rejected update leaves valid state unchanged'
);
select ok(
  (select count(*) = 1 from public.graph_nodes_v2
   where node_key = 'semantic_term:10900000-0000-4000-8000-000000000001'),
  '19 - composed graph contains semantic term exactly once'
);
select ok(
  (select count(*) = 1 from public.graph_edges_v2
   where edge_key = 'observation-semantic-term:10900000-0000-4000-8000-000000000010'),
  '20 - composed graph contains normalization exactly once'
);

select * from finish();
rollback;
