begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

create temporary table test_import_batch_baseline (committed_count bigint) on commit drop;
insert into test_import_batch_baseline
select count(*) from public.import_batches where status = 'committed';

select has_table('public', 'product_variants', 'V2 crea product_variants');
select has_table('public', 'variant_prices', 'V2 crea variant_prices');
select has_table('public', 'product_media', 'V2 crea product_media');
select has_table('public', 'import_batches', 'V2 crea staging de importación');

select is(
  (
    select count(*)
    from public.products product
    where product.is_active
      and not exists (
        select 1
        from public.product_variants variant
        where variant.product_id = product.id
          and variant.is_active
          and variant.is_default
      )
  ),
  0::bigint,
  'Todo producto activo tiene variante predeterminada activa'
);

select is(
  (
    select count(*)
    from (
      select product_id
      from public.product_variants
      where is_active and is_default
      group by product_id
      having count(*) > 1
    ) duplicates
  ),
  0::bigint,
  'Ningún producto tiene dos variantes predeterminadas activas'
);

select is(
  (
    select variant.availability_status::text
    from public.product_variants variant
    join public.products product on product.id = variant.product_id
    where product.code = 'DEMO-TOR-001' and variant.is_default
  ),
  'consult',
  'La disponibilidad consult se conserva exactamente'
);

select is(
  (
    select canonical_path
    from public.category_paths
    where slug = 'tornos'
  ),
  'equipos/tornos',
  'La ruta canónica jerárquica se construye recursivamente'
);

select is(
  (select count(*) from public.products where code like 'DEMO-%'),
  5::bigint,
  'Las semillas crean las cinco fichas demostrativas esperadas'
);

select is(
  (
    select count(*)
    from public.product_variants variant
    join public.products product on product.id = variant.product_id
    where product.code = 'DEMO-ESM-001'
  ),
  3::bigint,
  'El esmalte demuestra tres tonos comprables'
);

select throws_ok(
  $$
    insert into public.variant_prices (
      variant_id, price_list_id, amount, minimum_quantity, validity
    )
    select price.variant_id, price.price_list_id, price.amount, 1, price.validity
    from public.variant_prices price
    limit 1
  $$,
  '23P01',
  null,
  'No se permiten precios activos superpuestos'
);

select throws_ok(
  $$
    insert into public.wholesale_rules (
      name, scope_type, product_id, brand_id, minimum_quantity,
      mixing_policy, price_list_id
    )
    select
      'Inválida', 'product', product.id, product.brand_id, 2,
      'same_product', price_list.id
    from public.products product
    cross join public.price_lists price_list
    limit 1
  $$,
  '23514',
  null,
  'Una regla mayorista exige exactamente un alcance'
);

select throws_ok(
  $$
    insert into public.product_media (
      product_id, variant_id, media_asset_id, media_role
    )
    select variant.product_id, variant.id, media.id, 'detail'
    from public.product_variants variant
    cross join public.media_assets media
    limit 1
  $$,
  '23514',
  null,
  'Un medio pertenece exclusivamente a producto o variante'
);

select throws_ok(
  $$
    update public.categories root
    set parent_id = (
      select child.id
      from public.categories child
      where child.parent_id = root.id
      limit 1
    )
    where root.parent_id is null
      and root.slug = 'equipos'
  $$,
  '23514',
  null,
  'La jerarquía impide ciclos indirectos'
);

select throws_ok(
  $$
    insert into public.product_relations (
      source_product_id, target_product_id, relation_type
    )
    select target_product_id, source_product_id, 'compatible_with'
    from public.product_relations
    where relation_type = 'compatible_with'
    limit 1
  $$,
  '23505',
  null,
  'Las relaciones simétricas usan una representación canónica'
);

select ok(
  public.is_public_catalog_product(
    (select id from public.products where code = 'DEMO-ESM-001')
  ),
  'Un producto activo y publicado es visible públicamente'
);

select is(
  (
    select count(*)
    from public.import_batches batch
    where batch.status = 'committed'
  ),
  (select committed_count from test_import_batch_baseline),
  'Las verificaciones previas no comprometen lotes de importación accidentalmente'
);

create temporary table test_import_commit (
  row_id uuid,
  product_id uuid,
  variant_id uuid
) on commit drop;

with created_batch as (
  insert into public.import_batches (
    source_type, source_name, status, total_rows, processed_rows
  ) values (
    'technical_test', 'pgTAP controlled import', 'approved', 1, 1
  )
  returning id
), created_row as (
  insert into public.import_rows (
    batch_id, row_number, raw_data, normalized_data, proposed_action, status
  )
  select
    created_batch.id,
    1,
    '{"codigo":"TEST-IMPORT-CONTROLLED","nombre":"ImportaciÃ³n controlada"}'::jsonb,
    jsonb_build_object(
      'product', jsonb_build_object(
        'code', 'TEST-IMPORT-CONTROLLED',
        'slug', 'test-import-controlled',
        'brandId', (select id from public.brands where slug = 'masglo'),
        'categoryId', (select id from public.categories where parent_id is null order by sort_order limit 1),
        'templateId', (select id from public.attribute_templates where code = 'LEGACY_V1'),
        'name', 'ImportaciÃ³n controlada',
        'description', 'Fila tÃ©cnica temporal para pgTAP.',
        'editorialStatus', 'draft'
      ),
      'variant', jsonb_build_object(
        'sku', 'TEST-IMPORT-CONTROLLED-SKU',
        'name', 'PresentaciÃ³n Ãºnica',
        'variantKey', 'presentation=default',
        'availability', 'consult'
      )
    ),
    'create_product',
    'approved'
  from created_batch
  returning id
)
insert into test_import_commit (row_id)
select id from created_row;

with committed as (
  select public.commit_approved_import_row(row_id) as result
  from test_import_commit
)
update test_import_commit state
set product_id = (committed.result ->> 'productId')::uuid,
    variant_id = (committed.result ->> 'variantId')::uuid
from committed;

select is(
  (select status::text from public.import_rows where id = (select row_id from test_import_commit)),
  'committed',
  'Una fila aprobada se convierte de forma controlada'
);

select ok(
  exists (
    select 1
    from test_import_commit state
    join public.products product on product.id = state.product_id
    join public.product_variants variant on variant.id = state.variant_id
      and variant.product_id = product.id
      and variant.is_default
      and variant.is_active
    where product.code = 'TEST-IMPORT-CONTROLLED'
  ),
  'La conversiÃ³n usa la creaciÃ³n atÃ³mica con variante predeterminada'
);

select ok(
  exists (
    select 1
    from public.import_rows row
    join test_import_commit state on state.row_id = row.id
    where row.target_product_id = state.product_id
      and row.target_variant_id = state.variant_id
  ),
  'La fila importada conserva trazabilidad a producto y variante'
);

create temporary table test_rls_expected (visible_products bigint) on commit drop;
insert into test_rls_expected
select count(*)
from public.products product
where product.is_active and product.editorial_status = 'published';
grant select on test_rls_expected to anon;

set local role anon;

select is(
  (select count(*) from public.products),
  (select visible_products from test_rls_expected),
  'RLS anÃ³nimo expone solo productos activos y publicados'
);

select throws_ok(
  $$ select count(*) from public.import_batches $$,
  '42501',
  null,
  'Grants y RLS anÃ³nimos no exponen staging de importaciÃ³n'
);

select throws_ok(
  $$
    insert into public.import_batches (source_type, source_name)
    values ('forbidden', 'anonymous write')
  $$,
  '42501',
  null,
  'RLS y grants impiden escritura anÃ³nima en importaciÃ³n'
);

reset role;

select * from finish();

rollback;
