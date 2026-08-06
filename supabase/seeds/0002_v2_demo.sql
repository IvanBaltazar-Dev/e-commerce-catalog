-- Datos demostrativos V2. Todos los códigos y rutas usan el prefijo DEMO.

insert into public.brands (name, slug, sort_order)
values ('Demo Professional', 'demo-professional', 900)
on conflict (slug) do update
set name = excluded.name,
    is_active = true,
    sort_order = excluded.sort_order;

insert into public.attribute_templates (name, code, description)
values
  ('Esmalte por tonos', 'ESMALTE_TONOS', 'Variantes por tono y familia cromática.'),
  ('Extensiones profesionales', 'EXTENSIONES', 'Variantes por forma, largo y color.'),
  ('Torno eléctrico', 'TORNO_ELECTRICO', 'Equipos con voltaje, potencia y medios técnicos.')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    is_active = true;

insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('tone', 'Tono', 'single_option', 'variant', null, true, true, true, true, false, 10),
  ('color_family', 'Familia cromática', 'single_option', 'variant', null, true, false, false, true, false, 20),
  ('shape', 'Forma', 'single_option', 'variant', null, true, false, true, true, false, 10),
  ('extension_length', 'Largo', 'single_option', 'variant', null, true, false, true, true, false, 20),
  ('extension_color', 'Color', 'single_option', 'variant', null, true, false, true, true, false, 30),
  ('voltage', 'Voltaje', 'single_option', 'product', null, true, false, false, true, false, 10),
  ('power_watts', 'Potencia', 'measurement', 'product', 'W', true, false, false, true, false, 20)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    unit = excluded.unit,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    is_required = excluded.is_required,
    is_multivalue = excluded.is_multivalue,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options (attribute_definition_id, value, label, sort_order)
select definition.id, option.value, option.label, option.sort_order
from (
  values
    ('tone', 'rojo-intenso', 'Rojo intenso', 10),
    ('tone', 'nude-rosado', 'Nude rosado', 20),
    ('tone', 'rosa-clasico', 'Rosa clásico', 30),
    ('color_family', 'rojos', 'Rojos', 10),
    ('color_family', 'nude', 'Nude', 20),
    ('color_family', 'rosados', 'Rosados', 30),
    ('shape', 'almond', 'Almond', 10),
    ('shape', 'coffin', 'Coffin', 20),
    ('extension_length', 'short', 'Short', 10),
    ('extension_length', 'medium', 'Medium', 20),
    ('extension_color', 'natural', 'Natural', 10),
    ('extension_color', 'clear', 'Transparente', 20),
    ('voltage', 'bivolt', 'Bivolt', 10),
    ('voltage', '220v', '220 V', 20)
) as option(attribute_code, value, label, sort_order)
join public.attribute_definitions definition on definition.code = option.attribute_code
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, true, definition.scope, mapping.sort_order
from (
  values
    ('ESMALTE_TONOS', 'tone', 10),
    ('ESMALTE_TONOS', 'color_family', 20),
    ('EXTENSIONES', 'shape', 10),
    ('EXTENSIONES', 'extension_length', 20),
    ('EXTENSIONES', 'extension_color', 30),
    ('TORNO_ELECTRICO', 'voltage', 10),
    ('TORNO_ELECTRICO', 'power_watts', 20)
) as mapping(template_code, attribute_code, sort_order)
join public.attribute_templates template on template.code = mapping.template_code
join public.attribute_definitions definition on definition.code = mapping.attribute_code
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
values (null, 'Uñas', 'unas', null, 100)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Esmaltes', 'esmaltes', null, 10
from public.categories parent
where parent.parent_id is null and parent.slug = 'unas'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Gel semipermanente', 'gel-semipermanente', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.slug = 'esmaltes' and template.code = 'ESMALTE_TONOS'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name,
    template_id = excluded.template_id,
    is_active = true,
    sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
values (null, 'Pestañas', 'pestanas', null, 200)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Extensiones profesionales', 'extensiones-profesionales', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'pestanas' and template.code = 'EXTENSIONES'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name,
    template_id = excluded.template_id,
    is_active = true,
    sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
values (null, 'Equipos', 'equipos', null, 300)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Tornos', 'tornos', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'equipos' and template.code = 'TORNO_ELECTRICO'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name,
    template_id = excluded.template_id,
    is_active = true,
    sort_order = excluded.sort_order;

do $$
declare
  result jsonb;
  product_id uuid;
  variant_id uuid;
  second_variant_id uuid;
  third_variant_id uuid;
  extension_product_id uuid;
  machine_product_id uuid;
  spare_product_id uuid;
  accessory_product_id uuid;
  brand_id uuid;
  category_id uuid;
  template_id uuid;
  retail_list_id uuid;
  wholesale_list_id uuid;
  media_id uuid;
begin
  if exists (select 1 from public.products where code = 'DEMO-ESM-001') then
    return;
  end if;

  select id into retail_list_id from public.price_lists where code = 'retail-pen';
  select id into wholesale_list_id from public.price_lists where code = 'wholesale-pen';

  -- Esmalte con tres tonos y regla de mezcla mayorista.
  select id into brand_id from public.brands where slug = 'masglo';
  select id into category_id from public.categories where slug = 'gel-semipermanente';
  select id into template_id from public.attribute_templates where code = 'ESMALTE_TONOS';

  result := public.create_product_with_default_variant(
    jsonb_build_object(
      'code', 'DEMO-ESM-001',
      'slug', 'demo-masglo-gel-evolution',
      'brandId', brand_id,
      'categoryId', category_id,
      'templateId', template_id,
      'name', 'Gel Evolution Demo',
      'productType', 'Gel semipermanente',
      'requiresLamp', true,
      'lampType', 'UV/LED',
      'description', 'Producto demostrativo V2 con tonos seleccionables.',
      'editorialStatus', 'published'
    ),
    jsonb_build_object(
      'sku', 'DEMO-ESM-ROJO',
      'name', 'Rojo intenso',
      'variantKey', 'tone=rojo-intenso',
      'availability', 'available',
      'retailPrice', 15.00,
      'wholesalePrice', 12.00,
      'wholesaleMinimum', 12
    )
  );
  product_id := (result ->> 'productId')::uuid;
  variant_id := (result ->> 'variantId')::uuid;

  insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
  select variant_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where (definition.code = 'tone' and option.value = 'rojo-intenso')
     or (definition.code = 'color_family' and option.value = 'rojos');

  insert into public.product_variants (
    product_id, sku, name, variant_key, availability_status, is_active, sort_order
  ) values (
    product_id, 'DEMO-ESM-NUDE', 'Nude rosado', 'tone=nude-rosado', 'available', true, 20
  ) returning id into second_variant_id;

  insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
  select second_variant_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where (definition.code = 'tone' and option.value = 'nude-rosado')
     or (definition.code = 'color_family' and option.value = 'nude');

  insert into public.product_variants (
    product_id, sku, name, variant_key, availability_status, is_active, sort_order
  ) values (
    product_id, 'DEMO-ESM-ROSA', 'Rosa clásico', 'tone=rosa-clasico', 'sold_out', true, 30
  ) returning id into third_variant_id;

  insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
  select third_variant_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where (definition.code = 'tone' and option.value = 'rosa-clasico')
     or (definition.code = 'color_family' and option.value = 'rosados');

  insert into public.variant_prices (variant_id, price_list_id, amount, minimum_quantity)
  values
    (second_variant_id, retail_list_id, 15.00, 1),
    (second_variant_id, wholesale_list_id, 12.00, 12),
    (third_variant_id, retail_list_id, 15.00, 1),
    (third_variant_id, wholesale_list_id, 12.00, 12);

  insert into public.media_assets (
    bucket, storage_path, file_name, mime_type, metadata
  ) values (
    'catalog-assets', 'demo/esmalte/main.webp', 'main.webp', 'image/webp', '{"demo":true}'
  ) returning id into media_id;
  insert into public.product_media (product_id, media_asset_id, media_role, is_primary)
  values (product_id, media_id, 'main', true);

  insert into public.media_assets (
    bucket, storage_path, file_name, mime_type, metadata
  ) values (
    'catalog-assets', 'demo/esmalte/carta.webp', 'carta.webp', 'image/webp', '{"demo":true}'
  ) returning id into media_id;
  insert into public.product_media (product_id, media_asset_id, media_role, is_primary)
  values (product_id, media_id, 'color_chart', true);

  insert into public.media_assets (
    bucket, storage_path, file_name, mime_type, metadata
  ) values (
    'catalog-assets', 'demo/esmalte/rojo.webp', 'rojo.webp', 'image/webp', '{"demo":true}'
  ) returning id into media_id;
  insert into public.product_media (variant_id, media_asset_id, media_role, is_primary)
  values (variant_id, media_id, 'swatch', true);

  -- Extensiones con combinación de forma, largo y color.
  select id into brand_id from public.brands where slug = 'demo-professional';
  select id into category_id from public.categories where slug = 'extensiones-profesionales';
  select id into template_id from public.attribute_templates where code = 'EXTENSIONES';

  result := public.create_product_with_default_variant(
    jsonb_build_object(
      'code', 'DEMO-EXT-001',
      'slug', 'demo-extensiones-profesionales',
      'brandId', brand_id,
      'categoryId', category_id,
      'templateId', template_id,
      'name', 'Extensiones Professional Demo',
      'productType', 'Extensiones',
      'description', 'Producto demostrativo de variantes combinatorias.',
      'editorialStatus', 'published'
    ),
    jsonb_build_object(
      'sku', 'DEMO-EXT-ALM-S-NAT',
      'name', 'Almond · Short · Natural',
      'variantKey', 'shape=almond|length=short|color=natural',
      'availability', 'available',
      'retailPrice', 28.00
    )
  );
  extension_product_id := (result ->> 'productId')::uuid;
  variant_id := (result ->> 'variantId')::uuid;

  insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
  select variant_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where (definition.code = 'shape' and option.value = 'almond')
     or (definition.code = 'extension_length' and option.value = 'short')
     or (definition.code = 'extension_color' and option.value = 'natural');

  insert into public.product_variants (
    product_id, sku, name, variant_key, availability_status, is_active, sort_order
  ) values (
    extension_product_id,
    'DEMO-EXT-COF-M-CLR',
    'Coffin · Medium · Transparente',
    'shape=coffin|length=medium|color=clear',
    'sold_out',
    true,
    20
  ) returning id into second_variant_id;

  insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
  select second_variant_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where (definition.code = 'shape' and option.value = 'coffin')
     or (definition.code = 'extension_length' and option.value = 'medium')
     or (definition.code = 'extension_color' and option.value = 'clear');

  insert into public.variant_prices (variant_id, price_list_id, amount, minimum_quantity)
  values (second_variant_id, retail_list_id, 30.00, 1);

  -- Torno con variante predeterminada, atributos técnicos y relaciones.
  select id into category_id from public.categories where slug = 'tornos';
  select id into template_id from public.attribute_templates where code = 'TORNO_ELECTRICO';

  result := public.create_product_with_default_variant(
    jsonb_build_object(
      'code', 'DEMO-TOR-001',
      'slug', 'demo-torno-profesional',
      'brandId', brand_id,
      'categoryId', category_id,
      'templateId', template_id,
      'name', 'Torno Profesional Demo',
      'productType', 'Torno eléctrico',
      'description', 'Equipo demostrativo con especificaciones y compatibilidades.',
      'editorialStatus', 'published'
    ),
    jsonb_build_object(
      'sku', 'DEMO-TOR-001-UNICA',
      'name', 'Presentación única',
      'variantKey', 'presentation=default',
      'availability', 'consult'
    )
  );
  machine_product_id := (result ->> 'productId')::uuid;

  insert into public.product_attribute_values (
    product_id, attribute_definition_id, option_id
  )
  select machine_product_id, definition.id, option.id
  from public.attribute_definitions definition
  join public.attribute_options option on option.attribute_definition_id = definition.id
  where definition.code = 'voltage' and option.value = 'bivolt';

  insert into public.product_attribute_values (
    product_id, attribute_definition_id, value_number
  )
  select machine_product_id, id, 65
  from public.attribute_definitions
  where code = 'power_watts';

  insert into public.media_assets (
    bucket, storage_path, file_name, mime_type, metadata
  ) values (
    'catalog-assets', 'demo/torno/ficha-tecnica.pdf', 'ficha-tecnica.pdf', 'application/pdf', '{"demo":true}'
  ) returning id into media_id;
  insert into public.product_media (product_id, media_asset_id, media_role, is_primary)
  values (machine_product_id, media_id, 'technical_sheet', true);

  select id into template_id from public.attribute_templates where code = 'LEGACY_V1';

  result := public.create_product_with_default_variant(
    jsonb_build_object(
      'code', 'DEMO-REP-001',
      'slug', 'demo-micromotor-repuesto',
      'brandId', brand_id,
      'categoryId', category_id,
      'templateId', template_id,
      'name', 'Micromotor de repuesto Demo',
      'productType', 'Repuesto',
      'editorialStatus', 'published'
    ),
    jsonb_build_object(
      'sku', 'DEMO-REP-001-UNICA',
      'name', 'Presentación única',
      'availability', 'consult'
    )
  );
  spare_product_id := (result ->> 'productId')::uuid;

  result := public.create_product_with_default_variant(
    jsonb_build_object(
      'code', 'DEMO-ACC-001',
      'slug', 'demo-set-fresas',
      'brandId', brand_id,
      'categoryId', category_id,
      'templateId', template_id,
      'name', 'Set de fresas Demo',
      'productType', 'Accesorio',
      'editorialStatus', 'published'
    ),
    jsonb_build_object(
      'sku', 'DEMO-ACC-001-UNICA',
      'name', 'Presentación única',
      'availability', 'available',
      'retailPrice', 35.00
    )
  );
  accessory_product_id := (result ->> 'productId')::uuid;

  insert into public.product_relations (
    source_product_id, target_product_id, relation_type, compatibility_status, notes
  ) values
    (spare_product_id, machine_product_id, 'spare_part_for', 'confirmed', 'Repuesto demostrativo confirmado.'),
    (machine_product_id, accessory_product_id, 'recommended_with', 'confirmed', 'Accesorio recomendado para demostración.'),
    (machine_product_id, spare_product_id, 'compatible_with', 'confirmed', 'Compatibilidad técnica demostrativa.');
end;
$$;

update public.products product
set product_line_id = line.id
from public.product_lines line
join public.brands brand on brand.id = line.brand_id and brand.slug = 'masglo'
where product.slug = 'demo-masglo-gel-evolution'
  and line.slug = 'gel-evolution'
  and product.brand_id = brand.id;

insert into public.color_shades(
  brand_id, product_line_id, name, code, tone_option_id, color_family_option_id
)
select distinct
  product.brand_id,
  product.product_line_id,
  variant.name,
  variant.sku,
  tone_value.option_id,
  family_value.option_id
from public.product_variants variant
join public.products product on product.id = variant.product_id
join public.attribute_templates template on template.id = product.template_id and template.code = 'ESMALTE_TONOS'
join public.variant_attribute_values tone_value on tone_value.variant_id = variant.id
join public.attribute_definitions tone_definition on tone_definition.id = tone_value.attribute_definition_id and tone_definition.code = 'tone'
join public.variant_attribute_values family_value on family_value.variant_id = variant.id
join public.attribute_definitions family_definition on family_definition.id = family_value.attribute_definition_id and family_definition.code = 'color_family'
where tone_value.option_id is not null and family_value.option_id is not null
on conflict do nothing;

update public.product_variants variant
set color_shade_id = shade.id
from public.products product, public.color_shades shade
where product.id = variant.product_id
  and shade.brand_id = product.brand_id
  and shade.product_line_id is not distinct from product.product_line_id
  and exists (
    select 1
    from public.variant_attribute_values value
    join public.attribute_definitions definition on definition.id = value.attribute_definition_id and definition.code = 'tone'
    where value.variant_id = variant.id and value.option_id = shade.tone_option_id
  );
