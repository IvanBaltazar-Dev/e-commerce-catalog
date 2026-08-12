begin;

select plan(40);

select has_table('public', 'catalog_research_runs', '1 · existe memoria permanente de corridas');
select has_table('public', 'catalog_research_run_sources', '2 · existe alcance marca/fuente por corrida');
select has_table('public', 'catalog_reference_products', '3 · existe identidad externa de producto');
select has_table('public', 'catalog_reference_variants', '4 · existe identidad externa de variante');
select has_table('public', 'catalog_reference_presence_events', '5 · existen deltas persistentes');
select has_table('public', 'catalog_reference_prices', '6 · precio externo está separado');
select has_table('public', 'catalog_graph_projection_runs', '7 · las proyecciones dejan trazabilidad');

create temporary table e1_counts as
select
  (select count(*) from public.products) as products,
  (select count(*) from public.product_variants) as variants,
  (select count(*) from public.variant_prices) as prices;

insert into public.catalog_sources(
  id, source_key, name, authority, adapter, base_url, brand_id
) values (
  '10100000-0000-4000-8000-000000000001',
  'stage1-synthetic-source',
  'Fuente sintética Etapa 1',
  'official',
  'manual_capture',
  'https://stage1.invalid',
  (select id from public.brands order by name limit 1)
);

insert into public.catalog_research_runs(
  id, run_key, run_kind, actor_kind, actor_label, status, input_fingerprint, scope
) values (
  '10100000-0000-4000-8000-000000000010',
  'stage1-baseline', 'baseline', 'codex', 'fixture', 'running', 'input-baseline',
  '{"purpose":"stage1 fixture"}'::jsonb
);

insert into public.catalog_research_run_brands(research_run_id, brand_id)
select '10100000-0000-4000-8000-000000000010', brand_id
from public.catalog_sources where id = '10100000-0000-4000-8000-000000000001';

insert into public.catalog_research_run_sources(
  id, research_run_id, source_id, brand_id, scope_key, status, source_state,
  input_fingerprint, scope
) select
  '10100000-0000-4000-8000-000000000011',
  '10100000-0000-4000-8000-000000000010',
  source.id, source.brand_id, 'all-products', 'running', 'first_seen', 'scope-baseline',
  '{"path":"/products"}'::jsonb
from public.catalog_sources source where source.id = '10100000-0000-4000-8000-000000000001';

insert into public.catalog_source_snapshots(
  id, source_id, status, started_at, completed_at, content_hash, product_count, variant_count
) values (
  '10100000-0000-4000-8000-000000000020',
  '10100000-0000-4000-8000-000000000001',
  'succeeded', now() - interval '1 minute', now(), 'stage1-snapshot-1', 1, 1
);

insert into public.catalog_research_run_snapshots(research_run_source_id, snapshot_id, snapshot_role)
values (
  '10100000-0000-4000-8000-000000000011',
  '10100000-0000-4000-8000-000000000020',
  'captured'
);

insert into public.catalog_source_records(
  id, snapshot_id, source_id, entity_type, external_id, title, normalized_name,
  source_url, captured_at
) values
(
  '10100000-0000-4000-8000-000000000021',
  '10100000-0000-4000-8000-000000000020',
  '10100000-0000-4000-8000-000000000001',
  'product', 'external-product-1', 'Producto externo sintético', 'producto externo sintetico',
  'https://stage1.invalid/products/1', now()
),
(
  '10100000-0000-4000-8000-000000000022',
  '10100000-0000-4000-8000-000000000020',
  '10100000-0000-4000-8000-000000000001',
  'variant', 'external-variant-1', 'Variante roja', 'variante roja',
  'https://stage1.invalid/products/1/red', now()
);

insert into public.catalog_reference_products(
  id, reference_key, brand_id, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, family, product_type, line,
  presentation, source_url, identity_fingerprint, content_fingerprint,
  first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
) select
  '10100000-0000-4000-8000-000000000030',
  'ref-product-stage1-1', source.brand_id, source.id,
  '10100000-0000-4000-8000-000000000021',
  'external-product-1', 'Producto externo sintético', 'producto externo sintetico',
  'Esmaltes', 'Esmalte', 'Línea sintética', '10 ml',
  'https://stage1.invalid/products/1', 'identity-product-1', 'content-product-1',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000010', now(), now()
from public.catalog_sources source where source.id = '10100000-0000-4000-8000-000000000001';

insert into public.catalog_reference_variants(
  id, reference_product_id, reference_key, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, sku, shade_name, presentation,
  source_url, identity_fingerprint, content_fingerprint,
  first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
) values (
  '10100000-0000-4000-8000-000000000031',
  '10100000-0000-4000-8000-000000000030',
  'ref-variant-stage1-red',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000022',
  'external-variant-1', 'Variante roja', 'variante roja', 'EXT-RED', 'Rojo', '10 ml',
  'https://stage1.invalid/products/1/red', 'identity-variant-1', 'content-variant-1',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000010', now(), now()
);

insert into public.catalog_reference_identifiers(
  reference_product_id, source_id, source_record_id, identifier_kind,
  observed_value, normalized_value, first_seen_run_id, last_seen_run_id,
  first_seen_at, last_seen_at
) values (
  '10100000-0000-4000-8000-000000000030',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000021',
  'external_id', 'external-product-1', 'external-product-1',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000010', now(), now()
), (
  '10100000-0000-4000-8000-000000000030',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000021',
  'sku', 'STAGE1-EXCLUSIVE-001', 'stage1-exclusive-001',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000010', now(), now()
);

insert into public.catalog_reference_presence_events(
  id, research_run_source_id, reference_product_id, delta_status,
  current_fingerprint, observed_at
) values (
  '10100000-0000-4000-8000-000000000040',
  '10100000-0000-4000-8000-000000000011',
  '10100000-0000-4000-8000-000000000030',
  'first_seen', 'content-product-1', now()
);

insert into public.catalog_reference_presence_events(
  id, research_run_source_id, reference_variant_id, delta_status,
  current_fingerprint, observed_at
) values (
  '10100000-0000-4000-8000-000000000041',
  '10100000-0000-4000-8000-000000000011',
  '10100000-0000-4000-8000-000000000031',
  'first_seen', 'content-variant-1', now()
);

insert into public.catalog_observations(
  id, observation_key, source_record_id, research_run_id, reference_variant_id,
  observation_kind, predicate, value_text, observed_at, extraction_method, confidence
) values
(
  '10100000-0000-4000-8000-000000000050', 'stage1-shade-red',
  '10100000-0000-4000-8000-000000000022',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000031',
  'shade', 'shade_name', 'Rojo', now(), 'official_page', 0.9500
),
(
  '10100000-0000-4000-8000-000000000051', 'stage1-shade-blue-contradiction',
  '10100000-0000-4000-8000-000000000022',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000031',
  'shade', 'shade_name', 'Azul', now(), 'manual_capture', 0.6000
);

insert into public.catalog_evidence_sets(
  id, evidence_key, evidence_type, decision_status, confidence, metadata
) values (
  '10100000-0000-4000-8000-000000000060',
  'stage1-contradictory-shade', 'official_sources', 'proposed', 0.8000,
  '{"assertion":"shade_name=Rojo"}'::jsonb
);

insert into public.catalog_evidence_items(evidence_set_id, observation_id, stance)
values
  ('10100000-0000-4000-8000-000000000060', '10100000-0000-4000-8000-000000000050', 'supports'),
  ('10100000-0000-4000-8000-000000000060', '10100000-0000-4000-8000-000000000051', 'contradicts');

insert into public.catalog_reference_prices(
  id, price_key, research_run_id, reference_variant_id, source_id, source_record_id,
  currency, amount, presentation, external_availability, observed_at, content_fingerprint
) values (
  '10100000-0000-4000-8000-000000000070', 'stage1-price-1',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000031',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000022',
  'COP', 12900, '10 ml', 'available', now(), 'price-content-1'
);

insert into public.catalog_reference_media(
  id, media_key, reference_variant_id, source_id, source_record_id, media_kind,
  remote_url, validation_status, first_seen_run_id, last_seen_run_id,
  first_seen_at, last_seen_at
) values (
  '10100000-0000-4000-8000-000000000071', 'stage1-image-1',
  '10100000-0000-4000-8000-000000000031',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000022', 'image',
  'https://stage1.invalid/images/red.jpg', 'remote_reference',
  '10100000-0000-4000-8000-000000000010',
  '10100000-0000-4000-8000-000000000010', now(), now()
);

insert into public.catalog_reconciliation_cases(
  id, entity_type, product_id, reference_product_id, source_record_id,
  research_run_id, algorithm, score, status, decision_reason, evidence, decided_at
) values (
  '10100000-0000-4000-8000-000000000080', 'product',
  (select id from public.products order by name limit 1),
  '10100000-0000-4000-8000-000000000030',
  '10100000-0000-4000-8000-000000000021',
  '10100000-0000-4000-8000-000000000010',
  'stage1_synthetic_exact_v1', 1, 'approved', 'Fixture exacto', '{}'::jsonb, now()
);

select is(
  (select count(*) from public.products),
  (select products from e1_counts),
  '8 · crear referencias no crea productos comerciales'
);
select is(
  (select count(*) from public.product_variants),
  (select variants from e1_counts),
  '9 · crear referencias no crea variantes comerciales'
);
select is(
  (select count(*) from public.variant_prices),
  (select prices from e1_counts),
  '10 · precio externo no escribe variant_prices'
);
select is(
  (select enrichment_level from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  'REFERENCE_LIGHT',
  '11 · una referencia nace ligera'
);
select is(
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'catalog_reference_variants'
     and column_name = 'product_variant_id'),
  0::bigint,
  '12 · la variante externa no necesita product_variants.id'
);
select is(
  (select target_ref from public.catalog_observations where id = '10100000-0000-4000-8000-000000000050'),
  'reference_variant:10100000-0000-4000-8000-000000000031',
  '13 · observación externa conserva sujeto tipado'
);
select throws_ok(
  $$ update public.catalog_observations set value_text = 'Verde' where id = '10100000-0000-4000-8000-000000000050' $$,
  '55000',
  'Las observaciones son inmutables; registre una nueva observación.',
  '14 · las observaciones permanecen inmutables'
);
select is(
  (select count(*) from public.catalog_evidence_items where evidence_set_id = '10100000-0000-4000-8000-000000000060' and stance = 'supports'),
  1::bigint,
  '15 · una observación puede respaldar una afirmación'
);
select is(
  (select count(*) from public.catalog_evidence_items where evidence_set_id = '10100000-0000-4000-8000-000000000060' and stance = 'contradicts'),
  1::bigint,
  '16 · otra observación puede contradecirla sin materializar valor'
);
select is(
  (select amount from public.catalog_reference_prices where price_key = 'stage1-price-1'),
  12900.0000::numeric,
  '17 · el precio externo conserva historia propia'
);
select is(
  (select status from public.catalog_reconciliation_cases where id = '10100000-0000-4000-8000-000000000080'),
  'approved',
  '18 · reconciliación existente enlaza referencia e interno'
);
select is(
  (select count(*) from public.graph_edges_v2
   where predicate = 'CONFIRMED_MATCH'
     and source_key = 'identity_case:10100000-0000-4000-8000-000000000080'),
  1::bigint,
  '19 · la capa de identidad proyecta la reconciliación aprobada'
);
select is(
  (select layer from public.graph_nodes_v2 where node_key = 'reference_product:10100000-0000-4000-8000-000000000030'),
  'reference',
  '20 · ReferenceProduct queda inequívocamente separado de Product'
);
select is(
  (select layer from public.graph_nodes_v2 where node_key = 'observation:10100000-0000-4000-8000-000000000050'),
  'evidence',
  '21 · observaciones están en capa de evidencia'
);
select ok(
  not exists (
    select 1 from public.graph_edges_v2 edge
    left join public.graph_nodes_v2 source on source.node_key = edge.source_key
    left join public.graph_nodes_v2 target on target.node_key = edge.target_key
    where source.node_key is null or target.node_key is null
  ),
  '22 · la proyección PostgreSQL no contiene aristas huérfanas'
);
select is(
  (select match_basis from public.get_catalog_reference_candidates_v1(
    (select brand_id from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
    '10100000-0000-4000-8000-000000000001', 'sku', 'stage1-exclusive-001', null, 10
  ) limit 1),
  'identifier',
  '23 · matching usa primero identificadores indexados'
);

select lives_ok(
  $$ select public.finalize_catalog_research_source_v1(
    '10100000-0000-4000-8000-000000000011', 'succeeded', 'result-1', '{}'::jsonb, '[]'::jsonb
  ) $$,
  '24 · finaliza fuente baseline'
);
select lives_ok(
  $$ select public.finalize_catalog_research_run_v1(
    '10100000-0000-4000-8000-000000000010', 'succeeded', 'run-result-1', '{}'::jsonb, '[]'::jsonb
  ) $$,
  '25 · finaliza corrida con métricas persistidas'
);
select ok(
  (select metrics ?& array[
    'referenceItemsKnown', 'referenceVariantsKnown', 'referenceItemsNew',
    'referenceItemsChanged', 'referenceItemsMatchedInternal', 'referenceItemsUnmatched',
    'referenceItemsReadyForCommercialDecision', 'referenceItemsLight',
    'referenceItemsEnriched', 'brandsWithReferenceCoverage', 'brandsWithoutSource',
    'coverageRatio'
  ] from public.catalog_research_runs where id = '10100000-0000-4000-8000-000000000010'),
  '26 · cada corrida materializa métricas de cobertura del Universo de Referencia'
);

insert into public.catalog_research_runs(
  id, run_key, run_kind, previous_run_id, actor_kind, actor_label, input_fingerprint
) values (
  '10100000-0000-4000-8000-000000000090', 'stage1-delta-missing', 'delta',
  '10100000-0000-4000-8000-000000000010', 'codex', 'fixture', 'input-delta-missing'
);
insert into public.catalog_research_run_sources(
  id, research_run_id, source_id, brand_id, scope_key, previous_run_source_id,
  input_fingerprint, source_state
) select
  '10100000-0000-4000-8000-000000000091',
  '10100000-0000-4000-8000-000000000090', source.id, source.brand_id,
  'all-products', '10100000-0000-4000-8000-000000000011', 'scope-missing', 'changed'
from public.catalog_sources source where source.id = '10100000-0000-4000-8000-000000000001';

select lives_ok(
  $$ select public.finalize_catalog_research_source_v1(
    '10100000-0000-4000-8000-000000000091', 'succeeded', 'empty-source', '{}'::jsonb, '[]'::jsonb
  ) $$,
  '26 · cierre SQL detecta ausentes sin lote × universo en memoria'
);
select is(
  (select presence_status from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  'missing_from_source',
  '27 · ausencia no elimina identidad'
);

insert into public.catalog_research_runs(
  id, run_key, run_kind, previous_run_id, actor_kind, actor_label, input_fingerprint
) values (
  '10100000-0000-4000-8000-000000000092', 'stage1-delta-returned', 'delta',
  '10100000-0000-4000-8000-000000000090', 'codex', 'fixture', 'input-delta-returned'
);
insert into public.catalog_research_run_sources(
  id, research_run_id, source_id, brand_id, scope_key, previous_run_source_id,
  input_fingerprint, source_state
) select
  '10100000-0000-4000-8000-000000000093',
  '10100000-0000-4000-8000-000000000092', source.id, source.brand_id,
  'all-products', '10100000-0000-4000-8000-000000000091', 'scope-returned', 'returned'
from public.catalog_sources source where source.id = '10100000-0000-4000-8000-000000000001';
insert into public.catalog_reference_presence_events(
  research_run_source_id, reference_product_id, delta_status,
  previous_fingerprint, current_fingerprint, observed_at
) values (
  '10100000-0000-4000-8000-000000000093',
  '10100000-0000-4000-8000-000000000030', 'returned',
  'content-product-1', 'content-product-1', now()
);
select is(
  (select presence_status from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  'present',
  '28 · reaparición reconoce identidad anterior'
);

update public.catalog_reference_products
set enrichment_level = 'REFERENCE_ENRICHED', knowledge_status = 'observed'
where id = '10100000-0000-4000-8000-000000000030';
select is(
  (select enrichment_level from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  'REFERENCE_ENRICHED',
  '29 · referencia puede promoverse a enriquecida sin volverse comercial'
);
select is(
  (select count(*) from public.products),
  (select products from e1_counts),
  '30 · promoción tampoco crea producto Bellaroshé'
);
select ok(
  jsonb_array_length(public.get_catalog_reference_knowledge_v1('ref-product-stage1-1')->'observations') = 2
  and jsonb_array_length(public.get_catalog_reference_knowledge_v1('ref-product-stage1-1')->'prices') = 1,
  '31 · responde qué sabemos con evidencia persistida'
);
insert into public.import_batches(id, source_type, source_name, total_rows)
values ('10100000-0000-4000-8000-000000000100', 'xlsx', 'fixture-stage1', 1);
insert into public.import_rows(
  id, batch_id, row_number, raw_data, normalized_data, proposed_action, status
) values (
  '10100000-0000-4000-8000-000000000101',
  '10100000-0000-4000-8000-000000000100', 1, '{}'::jsonb,
  jsonb_build_object(
    'identity', jsonb_build_object(
      'brandSlug', (select brand.slug from public.brands brand join public.catalog_reference_products reference on reference.brand_id = brand.id where reference.id = '10100000-0000-4000-8000-000000000030'),
      'brandName', (select brand.name from public.brands brand join public.catalog_reference_products reference on reference.brand_id = brand.id where reference.id = '10100000-0000-4000-8000-000000000030'),
      'internalCode', null, 'supplierCode', 'STAGE1-EXCLUSIVE-001'
    ),
    'naming', jsonb_build_object('normalizedName', 'producto externo sintetico')
  ),
  'create_product', 'normalized'
);
select lives_ok(
  $$ select public.resolve_catalog_import_reference_v1('10100000-0000-4000-8000-000000000101', 10) $$,
  '32 · el mismo staging consulta catálogo y Universo de Referencia'
);
select is(
  (select reference_product_id from public.import_rows where id = '10100000-0000-4000-8000-000000000101'),
  '10100000-0000-4000-8000-000000000030'::uuid,
  '33 · coincidencia exacta reutiliza referencia sin crear producto comercial'
);
select is(
  (public.get_catalog_import_reference_metrics_v1('10100000-0000-4000-8000-000000000100')->>'matchReference')::bigint,
  1::bigint,
  '34 · cada lote reporta coincidencias con el Universo de Referencia'
);
select lives_ok(
  $$ select public.upsert_catalog_reference_product_v1(
    '10100000-0000-4000-8000-000000000092', now() + interval '1 minute',
    jsonb_build_object(
      'referenceKey', 'ref-product-stage1-1',
      'brandId', (select brand_id from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
      'sourceId', '10100000-0000-4000-8000-000000000001',
      'sourceRecordId', '10100000-0000-4000-8000-000000000021',
      'externalId', 'external-product-1', 'name', 'Producto externo sintético actualizado',
      'normalizedName', 'producto externo sintetico actualizado',
      'family', 'Esmaltes', 'productType', 'Esmalte', 'line', 'Línea sintética',
      'presentation', '10 ml', 'sourceUrl', 'https://stage1.invalid/products/1',
      'identityFingerprint', 'identity-product-1', 'contentFingerprint', 'content-product-2',
      'level', 'REFERENCE_LIGHT', 'metadata', '{"replayed":true}'::jsonb
    )
  ) $$,
  '34 · upsert transaccional de producto puede repetirse'
);
select is(
  (select first_seen_run_id from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  '10100000-0000-4000-8000-000000000010'::uuid,
  '35 · repetir una referencia preserva su primera corrida'
);
select is(
  (select enrichment_level from public.catalog_reference_products where id = '10100000-0000-4000-8000-000000000030'),
  'REFERENCE_ENRICHED',
  '36 · un replay ligero no degrada una referencia enriquecida'
);
select lives_ok(
  $$ select public.upsert_catalog_reference_variant_v1(
    '10100000-0000-4000-8000-000000000092', now() + interval '1 minute',
    jsonb_build_object(
      'referenceKey', 'ref-variant-stage1-red',
      'referenceProductId', '10100000-0000-4000-8000-000000000030',
      'sourceId', '10100000-0000-4000-8000-000000000001',
      'sourceRecordId', '10100000-0000-4000-8000-000000000022',
      'externalId', 'external-variant-1', 'name', 'Variante roja',
      'normalizedName', 'variante roja', 'sku', 'EXT-RED', 'shadeName', 'Rojo',
      'presentation', '10 ml', 'sourceUrl', 'https://stage1.invalid/products/1/red',
      'identityFingerprint', 'identity-variant-1', 'contentFingerprint', 'content-variant-2',
      'level', 'REFERENCE_LIGHT'
    )
  ) $$,
  '37 · upsert transaccional de variante puede repetirse'
);
select throws_ok(
  $$ insert into public.catalog_research_runs(
    run_key, run_kind, actor_kind, actor_label, input_fingerprint
  ) values ('stage1-baseline', 'baseline', 'codex', 'duplicado', 'otra-huella') $$,
  '23505',
  null,
  '32 · la clave lógica impide corridas duplicadas'
);

select * from finish();
rollback;
