begin;

select plan(19);

select has_column('public', 'catalog_reconciliation_cases', 'case_key', '1 - reconciliation has stable material key');
select has_function('public', 'stage_catalog_brand_reconciliation_v1', array['uuid', 'uuid', 'uuid'], '2 - generic brand/source reconciliation exists');
select has_function('public', 'get_catalog_brand_intelligence_report_v1', array['uuid'], '3 - aggregate MCP report exists');
select has_view('public', 'graph_identity_case_nodes_v1', '4 - identity signals have dedicated nodes');
select has_view('public', 'graph_identity_case_edges_v1', '5 - identity signals have dedicated edges');

create temporary table e2_internal as
select
  product.brand_id,
  product.id as product_id,
  product.code as product_code,
  product.category_id,
  variant.id as variant_id,
  variant.name as variant_name
from public.products product
join public.product_variants variant on variant.product_id = product.id
where product.is_active and variant.is_active and length(public.search_normalize(variant.name)) >= 4
order by product.code, variant.sort_order, variant.id
limit 1;

create temporary table e2_counts as
select
  (select count(*) from public.products) as products,
  (select count(*) from public.product_variants) as variants,
  (select count(*) from public.variant_prices) as prices,
  (select count(*) from public.product_media) as media;

insert into public.catalog_sources(
  id, source_key, name, authority, adapter, base_url, brand_id
) select
  '10700000-0000-4000-8000-000000000001',
  'stage2-generic-official', 'Fuente oficial generica Etapa 2',
  'official', 'manual_capture', 'https://stage2.invalid', brand_id
from e2_internal;

insert into public.catalog_research_runs(
  id, run_key, run_kind, actor_kind, actor_label, status, started_at, finished_at,
  input_fingerprint, result_fingerprint, scope, result
) values (
  '10700000-0000-4000-8000-000000000010',
  'stage2-generic-baseline', 'baseline', 'codex', 'fixture Etapa 2',
  'succeeded', now() - interval '1 minute', now(), 'stage2-input', 'stage2-result',
  '{"fixture":true}'::jsonb, '{"publicationEffects":0}'::jsonb
);

insert into public.catalog_research_run_brands(research_run_id, brand_id)
select '10700000-0000-4000-8000-000000000010', brand_id from e2_internal;

insert into public.catalog_source_snapshots(
  id, source_id, status, started_at, completed_at, content_hash, product_count, variant_count
) values (
  '10700000-0000-4000-8000-000000000020',
  '10700000-0000-4000-8000-000000000001',
  'succeeded', now() - interval '1 minute', now(), 'stage2-generic-content', 1, 1
);

insert into public.catalog_source_records(
  id, snapshot_id, source_id, entity_type, external_id, external_parent_id,
  title, normalized_name, sku, source_url, captured_at
) select
  '10700000-0000-4000-8000-000000000021'::uuid,
  '10700000-0000-4000-8000-000000000020'::uuid,
  '10700000-0000-4000-8000-000000000001'::uuid,
  'product', 'stage2-product', null,
  'REFERENCIA OFICIAL ' || variant_name,
  'referencia oficial ' || public.search_normalize(variant_name),
  null, 'https://stage2.invalid/products/reference', now()
from e2_internal
union all
select
  '10700000-0000-4000-8000-000000000022'::uuid,
  '10700000-0000-4000-8000-000000000020'::uuid,
  '10700000-0000-4000-8000-000000000001'::uuid,
  'variant', 'stage2-variant', 'stage2-product',
  variant_name, public.search_normalize(variant_name), 'STAGE2-OFFICIAL-SKU',
  'https://stage2.invalid/products/reference?variant=1', now()
from e2_internal;

insert into public.catalog_reference_products(
  id, reference_key, brand_id, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, family, product_type, presentation,
  source_url, identity_fingerprint, content_fingerprint,
  first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
) select
  '10700000-0000-4000-8000-000000000030',
  'stage2-generic-reference-product', brand_id,
  '10700000-0000-4000-8000-000000000001',
  '10700000-0000-4000-8000-000000000021',
  'stage2-product', 'REFERENCIA OFICIAL ' || variant_name,
  'referencia oficial ' || public.search_normalize(variant_name),
  'TIPO OFICIAL INCOMPATIBLE', 'TIPO OFICIAL INCOMPATIBLE', '999 ml',
  'https://stage2.invalid/products/reference',
  'stage2-identity-product', 'stage2-content-product',
  '10700000-0000-4000-8000-000000000010',
  '10700000-0000-4000-8000-000000000010', now(), now()
from e2_internal;

insert into public.catalog_reference_variants(
  id, reference_product_id, reference_key, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, sku, shade_name, presentation,
  source_url, identity_fingerprint, content_fingerprint,
  first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
) select
  '10700000-0000-4000-8000-000000000031',
  '10700000-0000-4000-8000-000000000030',
  'stage2-generic-reference-variant',
  '10700000-0000-4000-8000-000000000001',
  '10700000-0000-4000-8000-000000000022',
  'stage2-variant', variant_name, public.search_normalize(variant_name),
  'STAGE2-OFFICIAL-SKU', variant_name, '999 ml',
  'https://stage2.invalid/products/reference?variant=1',
  'stage2-identity-variant', 'stage2-content-variant',
  '10700000-0000-4000-8000-000000000010',
  '10700000-0000-4000-8000-000000000010', now(), now()
from e2_internal;

select lives_ok(
  $$ select public.stage_catalog_brand_reconciliation_v1(
    '10700000-0000-4000-8000-000000000010',
    (select brand_id from e2_internal),
    '10700000-0000-4000-8000-000000000001'
  ) $$,
  '6 - generic reconciliation processes source without product rules'
);

select is(
  (select status from public.catalog_reconciliation_cases where algorithm = 'official_identity_v1' and reference_variant_id = '10700000-0000-4000-8000-000000000031'),
  'needs_review',
  '7 - structural conflict requires review'
);
select is(
  (select (evidence->>'classificationContradiction')::boolean from public.catalog_reconciliation_cases where algorithm = 'official_identity_v1' and reference_variant_id = '10700000-0000-4000-8000-000000000031'),
  true,
  '8 - evidence distinguishes classification contradiction'
);
select ok(
  (select length(case_key) > 20 from public.catalog_reconciliation_cases where algorithm = 'official_identity_v1' and reference_variant_id = '10700000-0000-4000-8000-000000000031'),
  '9 - candidate keeps stable material key'
);
select is(
  (select count(*) from public.catalog_reconciliation_cases where algorithm = 'official_identity_v1'
     and reference_variant_id = '10700000-0000-4000-8000-000000000031' and status = 'approved'),
  0::bigint,
  '10 - research makes no commercial decision'
);
select is(
  (select count(*) from public.catalog_review_work_items item
   join public.catalog_reconciliation_cases reconciliation on reconciliation.id = item.source_id
   where item.source_type = 'reconciliation_case'
     and reconciliation.reference_variant_id = '10700000-0000-4000-8000-000000000031'
     and item.status = 'open' and item.has_contradiction),
  1::bigint,
  '11 - contradiction reaches review queue'
);
select is((select count(*) from public.products), (select products from e2_counts), '12 - reconciliation creates no products');
select is((select count(*) from public.product_variants), (select variants from e2_counts), '13 - reconciliation creates no variants');
select is((select count(*) from public.variant_prices), (select prices from e2_counts), '14 - reconciliation changes no internal prices');
select is((select count(*) from public.product_media), (select media from e2_counts), '15 - reconciliation publishes no media');

select lives_ok(
  $$ select public.stage_catalog_brand_reconciliation_v1(
    '10700000-0000-4000-8000-000000000010',
    (select brand_id from e2_internal),
    '10700000-0000-4000-8000-000000000001'
  ) $$,
  '16 - repeated reconciliation is idempotent'
);
select is(
  (select count(*) from public.catalog_reconciliation_cases where algorithm = 'official_identity_v1'
     and reference_variant_id = '10700000-0000-4000-8000-000000000031'
     and status in ('proposed', 'needs_review', 'approved')),
  1::bigint,
  '17 - repeat creates no active candidate duplicate'
);
select is(
  (select count(*) from public.catalog_review_work_items item
   join public.catalog_reconciliation_cases reconciliation on reconciliation.id = item.source_id
   where item.source_type = 'reconciliation_case'
     and reconciliation.algorithm = 'official_identity_v1'
     and reconciliation.reference_variant_id = '10700000-0000-4000-8000-000000000031'
     and item.status in ('open', 'in_progress')),
  1::bigint,
  '18 - repeat creates no review duplicate'
);
select is(
  (select count(*)
   from (select public.get_catalog_brand_intelligence_report_v1((select brand_id from e2_internal)) report) result,
        jsonb_array_elements(report->'reconciliation'->'cases') candidate
   where candidate->>'referenceKey' = 'stage2-generic-reference-variant'
     and candidate->>'signal' = 'contradiction'),
  1::bigint,
  '19 - MCP report reads contradiction from PostgreSQL'
);

select * from finish();
rollback;
