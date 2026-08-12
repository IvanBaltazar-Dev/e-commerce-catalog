\set ON_ERROR_STOP on

copy (
  with original_products as (
    select * from public.products where created_at < date '__CATALOG_SNAPSHOT_CUTOFF__'
  ),
  original_variants as (
    select variant.*
    from public.product_variants variant
    join original_products product on product.id = variant.product_id
  )
  select
    product.id as product_id,
    product.code as product_code,
    product.name as product_name,
    product.presentation,
    product.product_type,
    product.requires_lamp,
    product.lamp_type,
    product.description,
    product.short_description,
    product.editorial_status,
    product.media_backfill as product_media_status,
    brand.name as brand,
    brand.slug as brand_slug,
    brand.is_generic as brand_is_generic,
    line.name as product_line,
    line.slug as product_line_slug,
    category.name as category,
    category.slug as category_slug,
    template.code as template_code,
    template.name as template_name,
    variant.id as variant_id,
    variant.sku,
    variant.barcode,
    variant.name as variant_name,
    variant.variant_key,
    variant.availability_status,
    variant.is_default,
    variant.media_backfill as variant_media_status,
    shade.id as shade_id,
    shade.code as shade_code,
    shade.name as shade_name,
    shade.reference_color,
    color_family.value as color_family_value,
    color_family.label as color_family_label,
    coalesce(media.media_count, 0) as media_count,
    coalesce(media.product_media_count, 0) as product_media_count,
    coalesce(media.variant_media_count, 0) as variant_media_count,
    media.media_roles,
    media.storage_paths,
    media.variant_storage_paths
  from original_products product
  join public.brands brand on brand.id = product.brand_id
  join public.categories category on category.id = product.category_id
  join public.attribute_templates template on template.id = product.template_id
  left join public.product_lines line on line.id = product.product_line_id
  left join original_variants variant on variant.product_id = product.id
  left join public.color_shades shade on shade.id = variant.color_shade_id
  left join public.attribute_options color_family on color_family.id = shade.color_family_option_id
  left join lateral (
    select
      count(*) as media_count,
      count(*) filter (where product_media.product_id = product.id and product_media.variant_id is null) as product_media_count,
      count(*) filter (where product_media.variant_id = variant.id) as variant_media_count,
      string_agg(distinct product_media.media_role::text, '|') as media_roles,
      string_agg(distinct media_asset.storage_path, '|') as storage_paths,
      string_agg(distinct media_asset.storage_path, '|') filter (where product_media.variant_id = variant.id) as variant_storage_paths
    from public.product_media product_media
    join public.media_assets media_asset on media_asset.id = product_media.media_asset_id
    where product_media.product_id = product.id or product_media.variant_id = variant.id
  ) media on true
  order by brand.name, product.name, variant.sort_order, variant.name
) to '/tmp/bellaroshe_catalog_flat.csv' with (format csv, header true, encoding 'UTF8');

copy (
  with original_products as (
    select * from public.products where created_at < date '__CATALOG_SNAPSHOT_CUTOFF__'
  ),
  original_variants as (
    select variant.*
    from public.product_variants variant
    join original_products product on product.id = variant.product_id
  )
  select
    brand.id as brand_id,
    brand.name as brand,
    brand.slug as brand_slug,
    brand.is_generic,
    count(distinct product.id) as products,
    count(distinct variant.id) as variants,
    count(distinct line.id) as lines,
    count(distinct shade.id) as shades,
    count(distinct product_media.id) as media_links,
    count(distinct product.id) filter (where product.editorial_status = 'published') as published_products,
    count(distinct product.id) filter (where product.media_backfill = 'pending') as products_media_pending,
    count(distinct variant.id) filter (where variant.media_backfill = 'pending') as variants_media_pending
  from public.brands brand
  left join original_products product on product.brand_id = brand.id
  left join original_variants variant on variant.product_id = product.id
  left join public.product_lines line on line.brand_id = brand.id
  left join public.color_shades shade on shade.brand_id = brand.id
  left join public.product_media product_media on product_media.product_id = product.id or product_media.variant_id = variant.id
  group by brand.id
  order by products desc, brand.name
) to '/tmp/bellaroshe_brand_coverage_internal.csv' with (format csv, header true, encoding 'UTF8');

copy (
  with original_products as (
    select * from public.products where created_at < date '__CATALOG_SNAPSHOT_CUTOFF__'
  )
  select
    relation.id,
    relation.relation_type,
    relation.compatibility_status,
    relation.notes,
    relation.metadata,
    source_product.code as source_product_code,
    source_product.name as source_product_name,
    source_variant.sku as source_variant_sku,
    source_variant.name as source_variant_name,
    target_product.code as target_product_code,
    target_product.name as target_product_name,
    target_variant.sku as target_variant_sku,
    target_variant.name as target_variant_name
  from public.product_relations relation
  left join original_products source_product on source_product.id = relation.source_product_id
  left join public.product_variants source_variant on source_variant.id = relation.source_variant_id
  left join original_products target_product on target_product.id = relation.target_product_id
  left join public.product_variants target_variant on target_variant.id = relation.target_variant_id
  where source_product.id is not null
     or target_product.id is not null
     or source_variant.product_id in (select id from original_products)
     or target_variant.product_id in (select id from original_products)
  order by relation.relation_type, relation.id
) to '/tmp/bellaroshe_relations_internal.csv' with (format csv, header true, encoding 'UTF8');

copy (
  select
    definition.code as attribute_code,
    definition.name as attribute_name,
    definition.data_type,
    definition.scope,
    definition.is_filterable,
    definition.is_searchable,
    definition.is_variant_axis,
    template.code as template_code,
    template.name as template_name,
    template_attribute.is_required_override,
    template_attribute.scope_override,
    string_agg(option.value || ':' || option.label, '|' order by option.sort_order, option.value) as options
  from public.attribute_definitions definition
  left join public.template_attributes template_attribute on template_attribute.attribute_definition_id = definition.id
  left join public.attribute_templates template on template.id = template_attribute.template_id
  left join public.attribute_options option on option.attribute_definition_id = definition.id and option.is_active
  where definition.is_active
  group by definition.id, template.id, template_attribute.is_required_override, template_attribute.scope_override
  order by template.code nulls last, definition.sort_order, definition.code
) to '/tmp/bellaroshe_attributes_internal.csv' with (format csv, header true, encoding 'UTF8');
