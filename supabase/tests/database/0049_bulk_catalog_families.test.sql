begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

-- ---------------------------------------------------------------------------
-- La pregunta que responde esta prueba: «¿la importación masiva encuentra en la
-- BD todo lo que la 0049 prometió como datos (familias, plantillas, ejes) y la
-- deuda de imágenes se comporta como estado que se limpia solo?».
-- ---------------------------------------------------------------------------

-- 1. Plantillas genéricas presentes y activas.
select is(
  (select count(*)::int from public.attribute_templates
   where code in ('HERRAMIENTA_BASICA','CONSUMIBLE_BASICO','PRODUCTO_COSMETICO','SISTEMA_UNAS',
                  'EQUIPO_ELECTRICO','ORGANIZACION_APOYO','PRESS_ON_DECORADO','DECORACION_NAIL_ART')
     and is_active),
  8,
  'Las ocho plantillas genéricas de familias existen y están activas.'
);

-- 2. Ejes nuevos declarados como ejes de variante.
select is(
  (select count(*)::int from public.attribute_definitions
   where code in ('aroma','set_name','size_label')
     and is_variant_axis and scope = 'variant' and is_active),
  3,
  'aroma, set_name y size_label son ejes de variante activos.'
);

-- 3. model_name es atributo de producto, no eje.
select is(
  (select (scope = 'product' and not is_variant_axis) from public.attribute_definitions where code = 'model_name'),
  true,
  'model_name queda en alcance producto sin ser eje.'
);

-- 4. Tallas sembradas.
select is(
  (select count(*)::int from public.attribute_options ao
   join public.attribute_definitions ad on ad.id = ao.attribute_definition_id
   where ad.code = 'size_label' and ao.is_active),
  7,
  'size_label trae las siete tallas sembradas.'
);

-- 5. Raíces nuevas del listado.
select is(
  (select count(*)::int from public.categories
   where parent_id is null
     and slug in ('depilacion','rostro-cuerpo-maquillaje','higiene-consumibles','organizacion-apoyo')
     and is_active),
  4,
  'Las cuatro áreas nuevas existen como raíces activas.'
);

-- 6. Hojas de familia colgadas de las raíces correctas con plantilla.
select is(
  (select count(*)::int
   from public.categories leaf
   join public.categories root on root.id = leaf.parent_id and root.parent_id is null
   join public.attribute_templates t on t.id = leaf.template_id
   where (root.slug, leaf.slug) in (
     ('unas','sistema-acrilico'), ('unas','decoracion-nail-art'), ('unas','press-on'),
     ('pestanas','cejas-diseno'), ('barberia-cabello','cepillos-y-peines'),
     ('depilacion','ceras-depilatorias'), ('rostro-cuerpo-maquillaje','maquillaje'),
     ('higiene-consumibles','guantes-proteccion'), ('organizacion-apoyo','maletines')
   ) and leaf.is_active),
  9,
  'Las hojas de familia muestreadas cuelgan de su raíz con plantilla asignada.'
);

-- 7. Las plantillas genéricas exponen sus ejes vía template_attributes.
select is(
  (select count(*)::int
   from public.template_attributes ta
   join public.attribute_templates t on t.id = ta.template_id
   join public.attribute_definitions ad on ad.id = ta.attribute_definition_id
   where (t.code, ad.code) in (
     ('PRODUCTO_COSMETICO','aroma'), ('PRODUCTO_COSMETICO','tone'),
     ('SISTEMA_UNAS','set_name'), ('CONSUMIBLE_BASICO','size_label'),
     ('PRESS_ON_DECORADO','shape'), ('DECORACION_NAIL_ART','color')
   )),
  6,
  'Los ejes muestreados están asociados a sus plantillas.'
);

-- 8. summary de lote existe, es objeto y rechaza no-objetos.
select is(
  (select jsonb_typeof(summary) from public.import_batches limit 0),
  null,
  'summary existe en import_batches (consulta tipada compila).'
);

select throws_ok(
  $$insert into public.import_batches (source_type, source_name, summary)
    values ('xlsx', 'prueba-summary', '"texto"'::jsonb)$$,
  '23514',
  null,
  'summary rechaza valores que no sean objeto JSON.'
);

-- ---------------------------------------------------------------------------
-- Deuda de medios: fixture mínima y trigger de limpieza.
-- ---------------------------------------------------------------------------

create temporary table fx on commit drop as
select
  (select id from public.brands where is_active order by created_at limit 1) as brand_id,
  (select id from public.categories where template_id is not null order by created_at limit 1) as category_id,
  (select id from public.attribute_templates where code = 'HERRAMIENTA_BASICA') as template_id;

insert into public.products (code, slug, name, presentation, product_type, unit_price, wholesale_price, brand_id, category_id, template_id, editorial_status, is_active, media_backfill)
select 'BLK-TEST-001', 'blk-test-001', 'Producto de prueba 0049', 'Unidad', 'herramienta', 0, 0, brand_id, category_id, template_id, 'draft', true, 'pending'
from fx;

insert into public.product_variants (product_id, sku, name, variant_key, availability_status, is_default, is_active, media_backfill)
select p.id, 'BLK-TEST-001-V1', 'Variante de prueba', 'unica', 'consult', true, true, 'color'
from public.products p where p.code = 'BLK-TEST-001';

-- 9-10. La deuda quedó registrada.
select is(
  (select media_backfill::text from public.products where code = 'BLK-TEST-001'),
  'pending',
  'El producto registra su deuda de imagen.'
);

select is(
  (select media_backfill::text from public.product_variants where sku = 'BLK-TEST-001-V1'),
  'color',
  'La variante registra el swatch temporal como deuda.'
);

insert into public.media_assets (bucket, storage_path, file_name, mime_type, size_bytes, checksum)
values ('catalog-assets', 'productos/BLK-TEST-001/main.webp', 'main.webp', 'image/webp', 10, 'blk-test-checksum-0049');

-- 11. Medio de producto limpia la deuda del producto…
insert into public.product_media (product_id, media_asset_id, media_role, is_primary)
select p.id, m.id, 'main', true
from public.products p, public.media_assets m
where p.code = 'BLK-TEST-001' and m.checksum = 'blk-test-checksum-0049';

select is(
  (select media_backfill from public.products where code = 'BLK-TEST-001'),
  null,
  'Asociar un medio de producto limpia products.media_backfill.'
);

-- 12. …sin tocar la deuda de la variante.
select is(
  (select media_backfill::text from public.product_variants where sku = 'BLK-TEST-001-V1'),
  'color',
  'La deuda de la variante sobrevive al medio del producto.'
);

-- 13. Medio de variante limpia la deuda de la variante.
insert into public.product_media (variant_id, media_asset_id, media_role, is_primary)
select v.id, m.id, 'swatch', true
from public.product_variants v, public.media_assets m
where v.sku = 'BLK-TEST-001-V1' and m.checksum = 'blk-test-checksum-0049';

select is(
  (select media_backfill from public.product_variants where sku = 'BLK-TEST-001-V1'),
  null,
  'Asociar un medio de variante limpia product_variants.media_backfill.'
);

-- 14. El checksum único de media_assets sigue vigente (ancla de deduplicación).
select throws_ok(
  $$insert into public.media_assets (bucket, storage_path, file_name, mime_type, checksum)
    values ('catalog-assets', 'productos/BLK-TEST-001/otro.webp', 'otro.webp', 'image/webp', 'blk-test-checksum-0049')$$,
  '23505',
  null,
  'media_assets sigue rechazando el mismo checksum dos veces.'
);

select * from finish();

rollback;
