-- Contratos SQL V2 para catálogo público y evaluación canónica del carrito.

begin;

create or replace function public.catalog_list_v2(
  p_page integer default 1,
  p_page_size integer default 24,
  p_search text default null,
  p_brand_slug text default null,
  p_category_path text default null,
  p_availability public.product_availability default null,
  p_attribute_filters jsonb default '{}'::jsonb,
  p_sort text default 'featured'
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  safe_page integer := greatest(coalesce(p_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(p_page_size, 24), 1), 100);
  safe_filters jsonb := coalesce(p_attribute_filters, '{}'::jsonb);
  result jsonb;
begin
  if jsonb_typeof(safe_filters) <> 'object' then
    raise exception using errcode = '22023', message = 'attribute_filters debe ser un objeto JSON.';
  end if;

  if coalesce(p_sort, 'featured') not in ('featured', 'name_asc', 'name_desc', 'price_asc', 'price_desc') then
    raise exception using errcode = '22023', message = 'Orden de catálogo no permitido.';
  end if;

  with recursive
  selected_category as (
    select path.id
    from public.category_paths path
    where p_category_path is not null
      and (path.canonical_path = p_category_path or path.slug = p_category_path)
    order by (path.canonical_path = p_category_path) desc
    limit 1
  ),
  category_scope as (
    select id from selected_category
    union all
    select child.id
    from public.categories child
    join category_scope parent on child.parent_id = parent.id
    where child.is_active
  ),
  filtered_products as materialized (
    select product.id
    from public.products product
    join public.brands brand on brand.id = product.brand_id
    where product.is_active
      and product.editorial_status = 'published'
      and (p_brand_slug is null or brand.slug = p_brand_slug)
      and (
        p_category_path is null
        or product.category_id in (select id from category_scope)
      )
      and (
        p_availability is null
        or exists (
          select 1
          from public.product_variants variant
          where variant.product_id = product.id
            and variant.is_active
            and variant.availability_status = p_availability
        )
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or product.search_document @@ websearch_to_tsquery('simple', trim(p_search))
        or product.name operator(public.%) trim(p_search)
        or exists (
          select 1
          from public.product_variants variant
          where variant.product_id = product.id
            and variant.is_active
            and (
              variant.sku ilike '%' || trim(p_search) || '%'
              or variant.name ilike '%' || trim(p_search) || '%'
            )
        )
      )
      and not exists (
        select 1
        from jsonb_each(safe_filters) requested(code, values_json)
        join public.attribute_definitions definition
          on definition.code = requested.code
         and definition.is_active
         and definition.is_filterable
        where jsonb_typeof(requested.values_json) <> 'array'
           or not exists (
             select 1
             from public.product_attribute_values product_value
             join public.attribute_options option
               on option.id = product_value.option_id
             where product_value.product_id = product.id
               and product_value.attribute_definition_id = definition.id
               and option.value in (
                 select jsonb_array_elements_text(requested.values_json)
               )
             union all
             select 1
             from public.product_variants variant
             join public.variant_attribute_values variant_value
               on variant_value.variant_id = variant.id
             join public.attribute_options option
               on option.id = variant_value.option_id
             where variant.product_id = product.id
               and variant.is_active
               and variant_value.attribute_definition_id = definition.id
               and option.value in (
                 select jsonb_array_elements_text(requested.values_json)
               )
           )
      )
  ),
  card_rows as materialized (
    select
      product.id as product_id,
      product.slug,
      product.name,
      product.is_featured,
      product.sort_order,
      jsonb_build_object(
        'id', brand.id,
        'name', brand.name,
        'slug', brand.slug
      ) as brand,
      jsonb_build_object(
        'id', category.id,
        'name', category.name,
        'slug', category.slug,
        'path', category_path.canonical_path
      ) as category,
      product_image.storage_path as main_image,
      pricing.starting_price,
      jsonb_build_object(
        'min', pricing.starting_price,
        'max', pricing.maximum_price,
        'currency', 'PEN'
      ) as price_range,
      availability.summary as availability_summary,
      variants.variant_count > 1 as has_multiple_variants,
      featured.variant as featured_variant
    from filtered_products filtered
    join public.products product on product.id = filtered.id
    join public.brands brand on brand.id = product.brand_id
    join public.categories category on category.id = product.category_id
    left join public.category_paths category_path on category_path.id = category.id
    left join lateral (
      select media.storage_path
      from public.product_media association
      join public.media_assets media on media.id = association.media_asset_id
      where association.product_id = product.id
        and association.media_role = 'main'
      order by association.is_primary desc, association.sort_order, association.id
      limit 1
    ) product_image on true
    cross join lateral (
      select count(*)::integer as variant_count
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ) variants
    cross join lateral (
      select min(price.amount) as starting_price, max(price.amount) as maximum_price
      from public.product_variants variant
      join public.variant_prices price on price.variant_id = variant.id
      join public.price_lists price_list on price_list.id = price.price_list_id
      where variant.product_id = product.id
        and variant.is_active
        and price.is_active
        and price.validity @> now()
        and price_list.is_active
        and price_list.is_public
        and price_list.price_type = 'retail'
    ) pricing
    cross join lateral (
      select jsonb_build_object(
        'available', count(*) filter (where variant.availability_status = 'available'),
        'soldOut', count(*) filter (where variant.availability_status = 'sold_out'),
        'consult', count(*) filter (where variant.availability_status = 'consult')
      ) as summary
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ) availability
    left join lateral (
      select jsonb_build_object(
        'id', variant.id,
        'sku', variant.sku,
        'name', variant.name,
        'availability', variant.availability_status,
        'price', (
          select price.amount
          from public.variant_prices price
          join public.price_lists price_list on price_list.id = price.price_list_id
          where price.variant_id = variant.id
            and price.is_active
            and price.validity @> now()
            and price_list.is_active
            and price_list.is_public
            and price_list.price_type = 'retail'
          order by price_list.priority desc, price.amount
          limit 1
        ),
        'image', coalesce(
          (
            select media.storage_path
            from public.product_media association
            join public.media_assets media on media.id = association.media_asset_id
            where association.variant_id = variant.id
            order by association.is_primary desc, association.sort_order, association.id
            limit 1
          ),
          product_image.storage_path
        )
      ) as variant
      from public.product_variants variant
      where variant.product_id = product.id
        and variant.is_active
      order by variant.is_default desc, variant.sort_order, variant.id
      limit 1
    ) featured on true
  ),
  ordered_cards as materialized (
    select *
    from card_rows card
    order by
      case when p_sort = 'featured' then card.is_featured end desc,
      case when p_sort = 'featured' then card.sort_order end asc,
      case when p_sort = 'name_asc' then lower(card.name) end asc,
      case when p_sort = 'name_desc' then lower(card.name) end desc,
      case when p_sort = 'price_asc' then card.starting_price end asc nulls last,
      case when p_sort = 'price_desc' then card.starting_price end desc nulls last,
      lower(card.name),
      card.product_id
  ),
  paged_cards as (
    select *
    from ordered_cards
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  ),
  available_filter_rows as (
    select distinct
      definition.id,
      definition.code,
      definition.name,
      definition.data_type,
      definition.sort_order
    from public.attribute_definitions definition
    where definition.is_active
      and definition.is_filterable
      and exists (
        select 1
        from public.product_attribute_values value
        join filtered_products filtered on filtered.id = value.product_id
        where value.attribute_definition_id = definition.id
        union all
        select 1
        from public.variant_attribute_values value
        join public.product_variants variant on variant.id = value.variant_id and variant.is_active
        join filtered_products filtered on filtered.id = variant.product_id
        where value.attribute_definition_id = definition.id
      )
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'productId', card.product_id,
          'slug', card.slug,
          'name', card.name,
          'brand', card.brand,
          'category', card.category,
          'mainImage', card.main_image,
          'startingPrice', card.starting_price,
          'priceRange', card.price_range,
          'availabilitySummary', card.availability_summary,
          'hasMultipleVariants', card.has_multiple_variants,
          'featuredVariant', card.featured_variant
        ) order by card.is_featured desc, card.sort_order, lower(card.name), card.product_id
      )
      from paged_cards card
    ), '[]'::jsonb),
    'page', safe_page,
    'pageSize', safe_page_size,
    'totalItems', (select count(*) from filtered_products),
    'totalPages', ceil((select count(*) from filtered_products)::numeric / safe_page_size)::integer,
    'availableFilters', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', filter.code,
          'name', filter.name,
          'dataType', filter.data_type,
          'options', coalesce((
            select jsonb_agg(
              jsonb_build_object('value', option.value, 'label', option.label)
              order by option.sort_order, option.label
            )
            from public.attribute_options option
            where option.attribute_definition_id = filter.id
              and option.is_active
              and (
                exists (
                  select 1
                  from public.product_attribute_values value
                  join filtered_products filtered on filtered.id = value.product_id
                  where value.option_id = option.id
                )
                or exists (
                  select 1
                  from public.variant_attribute_values value
                  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
                  join filtered_products filtered on filtered.id = variant.product_id
                  where value.option_id = option.id
                )
              )
          ), '[]'::jsonb)
        ) order by filter.sort_order, filter.name
      )
      from available_filter_rows filter
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.catalog_product_detail_v2(p_slug text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'productId', product.id,
    'code', product.code,
    'slug', product.slug,
    'name', product.name,
    'shortDescription', product.short_description,
    'description', product.description,
    'brand', jsonb_build_object(
      'id', brand.id,
      'name', brand.name,
      'slug', brand.slug
    ),
    'category', jsonb_build_object(
      'id', category.id,
      'name', category.name,
      'slug', category.slug,
      'path', category_path.canonical_path
    ),
    'template', jsonb_build_object(
      'id', template.id,
      'code', template.code,
      'name', template.name
    ),
    'attributes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', definition.code,
          'name', definition.name,
          'dataType', definition.data_type,
          'unit', definition.unit,
          'value', coalesce(
            to_jsonb(option.label),
            to_jsonb(value.value_text),
            to_jsonb(value.value_number),
            to_jsonb(value.value_boolean),
            to_jsonb(value.value_date),
            value.value_json
          )
        ) order by definition.sort_order, definition.name
      )
      from public.product_attribute_values value
      join public.attribute_definitions definition on definition.id = value.attribute_definition_id
      left join public.attribute_options option on option.id = value.option_id
      where value.product_id = product.id
    ), '[]'::jsonb),
    'media', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', media.id,
          'role', association.media_role,
          'path', media.storage_path,
          'mimeType', media.mime_type,
          'altText', media.alt_text,
          'isPrimary', association.is_primary
        ) order by association.media_role, association.is_primary desc, association.sort_order
      )
      from public.product_media association
      join public.media_assets media on media.id = association.media_asset_id
      where association.product_id = product.id
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'name', variant.name,
          'variantKey', variant.variant_key,
          'availability', variant.availability_status,
          'isDefault', variant.is_default,
          'attributes', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'code', definition.code,
                'name', definition.name,
                'dataType', definition.data_type,
                'unit', definition.unit,
                'value', coalesce(
                  to_jsonb(option.label),
                  to_jsonb(value.value_text),
                  to_jsonb(value.value_number),
                  to_jsonb(value.value_boolean),
                  to_jsonb(value.value_date),
                  value.value_json
                ),
                'optionValue', option.value
              ) order by definition.sort_order, definition.name
            )
            from public.variant_attribute_values value
            join public.attribute_definitions definition on definition.id = value.attribute_definition_id
            left join public.attribute_options option on option.id = value.option_id
            where value.variant_id = variant.id
          ), '[]'::jsonb),
          'prices', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'priceListCode', price_list.code,
                'type', price_list.price_type,
                'amount', price.amount,
                'minimumQuantity', price.minimum_quantity,
                'currency', price_list.currency
              ) order by price_list.priority desc, price.minimum_quantity
            )
            from public.variant_prices price
            join public.price_lists price_list on price_list.id = price.price_list_id
            where price.variant_id = variant.id
              and price.is_active
              and price.validity @> now()
              and price_list.is_active
              and price_list.is_public
          ), '[]'::jsonb),
          'media', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', media.id,
                'role', association.media_role,
                'path', media.storage_path,
                'mimeType', media.mime_type,
                'altText', media.alt_text,
                'isPrimary', association.is_primary
              ) order by association.is_primary desc, association.sort_order
            )
            from public.product_media association
            join public.media_assets media on media.id = association.media_asset_id
            where association.variant_id = variant.id
          ), '[]'::jsonb)
        ) order by variant.is_default desc, variant.sort_order, variant.name
      )
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ), '[]'::jsonb),
    'wholesaleRules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rule.id,
          'name', rule.name,
          'scopeType', rule.scope_type,
          'minimumQuantity', rule.minimum_quantity,
          'mixingPolicy', rule.mixing_policy,
          'priceListCode', price_list.code,
          'priority', rule.priority
        ) order by rule.priority desc, rule.minimum_quantity
      )
      from public.wholesale_rules rule
      join public.price_lists price_list on price_list.id = rule.price_list_id
      where rule.is_active
        and (rule.valid_from is null or rule.valid_from <= now())
        and (rule.valid_to is null or rule.valid_to > now())
        and (
          rule.product_id = product.id
          or rule.brand_id = product.brand_id
          or rule.category_id = product.category_id
          or rule.variant_id in (
            select variant.id from public.product_variants variant
            where variant.product_id = product.id and variant.is_active
          )
        )
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', relation.id,
          'type', relation.relation_type,
          'compatibilityStatus', relation.compatibility_status,
          'sourceProductId', relation.source_product_id,
          'sourceVariantId', relation.source_variant_id,
          'targetProductId', relation.target_product_id,
          'targetVariantId', relation.target_variant_id,
          'notes', relation.notes
        ) order by relation.sort_order, relation.id
      )
      from public.product_relations relation
      where relation.is_active
        and (
          relation.source_product_id = product.id
          or relation.target_product_id = product.id
          or relation.source_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
          or relation.target_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
        )
    ), '[]'::jsonb)
  )
  from public.products product
  join public.brands brand on brand.id = product.brand_id
  join public.categories category on category.id = product.category_id
  join public.attribute_templates template on template.id = product.template_id
  left join public.category_paths category_path on category_path.id = category.id
  where product.slug = p_slug
    and product.is_active
    and product.editorial_status = 'published';
$$;

create or replace function public.evaluate_cart_v2(p_lines jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
begin
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Las líneas del carrito deben ser un arreglo JSON.';
  end if;

  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 50 then
    raise exception using errcode = '22023', message = 'El carrito debe contener entre 1 y 50 líneas.';
  end if;

  with
  input_lines as (
    select
      (line ->> 'variantId')::uuid as variant_id,
      greatest(coalesce((line ->> 'quantity')::integer, 1), 1) as quantity,
      row_number() over () as input_order
    from jsonb_array_elements(p_lines) line
  ),
  enriched as materialized (
    select
      input.input_order,
      input.variant_id,
      input.quantity,
      variant.product_id,
      variant.sku,
      variant.name as variant_name,
      variant.availability_status,
      product.name as product_name,
      product.slug,
      product.brand_id,
      product.category_id,
      brand.name as brand_name,
      coalesce(
        (
          select media.storage_path
          from public.product_media association
          join public.media_assets media on media.id = association.media_asset_id
          where association.variant_id = variant.id
          order by association.is_primary desc, association.sort_order, association.id
          limit 1
        ),
        (
          select media.storage_path
          from public.product_media association
          join public.media_assets media on media.id = association.media_asset_id
          where association.product_id = product.id and association.media_role = 'main'
          order by association.is_primary desc, association.sort_order, association.id
          limit 1
        )
      ) as image_path
    from input_lines input
    join public.product_variants variant on variant.id = input.variant_id and variant.is_active
    join public.products product on product.id = variant.product_id
    join public.brands brand on brand.id = product.brand_id
    where product.is_active and product.editorial_status = 'published'
  ),
  totals as materialized (
    select
      line.*,
      sum(line.quantity) over (partition by line.product_id) as product_quantity,
      sum(line.quantity) over (partition by line.brand_id) as brand_quantity,
      sum(line.quantity) over (partition by line.category_id) as category_quantity
    from enriched line
  ),
  evaluated as materialized (
    select
      line.*,
      retail.amount as retail_price,
      applied.rule_id,
      applied.rule_name,
      applied.mixing_policy,
      applied.minimum_quantity,
      applied.amount as wholesale_price,
      case
        when line.availability_status = 'consult' then 'consult'
        when applied.rule_id is not null and applied.amount is not null then 'wholesale'
        else 'retail'
      end as purchase_mode,
      case
        when line.availability_status = 'consult' then null
        when applied.rule_id is not null and applied.amount is not null then applied.amount
        else retail.amount
      end as applied_price
    from totals line
    left join lateral (
      select price.amount
      from public.variant_prices price
      join public.price_lists price_list on price_list.id = price.price_list_id
      where price.variant_id = line.variant_id
        and price.is_active
        and price.validity @> now()
        and price_list.is_active
        and price_list.is_public
        and price_list.price_type = 'retail'
      order by price_list.priority desc, price.minimum_quantity desc
      limit 1
    ) retail on true
    left join lateral (
      select
        rule.id as rule_id,
        rule.name as rule_name,
        rule.mixing_policy,
        rule.minimum_quantity,
        price.amount
      from public.wholesale_rules rule
      join public.price_lists price_list on price_list.id = rule.price_list_id
      left join public.variant_prices price
        on price.variant_id = line.variant_id
       and price.price_list_id = rule.price_list_id
       and price.is_active
       and price.validity @> now()
      where rule.is_active
        and (rule.valid_from is null or rule.valid_from <= now())
        and (rule.valid_to is null or rule.valid_to > now())
        and price_list.is_active
        and price_list.is_public
        and (
          (rule.variant_id = line.variant_id and line.quantity >= rule.minimum_quantity)
          or (rule.product_id = line.product_id and line.product_quantity >= rule.minimum_quantity)
          or (rule.brand_id = line.brand_id and line.brand_quantity >= rule.minimum_quantity)
          or (rule.category_id = line.category_id and line.category_quantity >= rule.minimum_quantity)
        )
      order by
        rule.priority desc,
        case rule.scope_type
          when 'variant' then 4
          when 'product' then 3
          when 'brand' then 2
          when 'category' then 1
        end desc,
        rule.minimum_quantity desc
      limit 1
    ) applied on true
  )
  select jsonb_build_object(
    'lines', coalesce(jsonb_agg(
      jsonb_build_object(
        'productId', line.product_id,
        'variantId', line.variant_id,
        'sku', line.sku,
        'productName', line.product_name,
        'variantName', line.variant_name,
        'brandName', line.brand_name,
        'slug', line.slug,
        'imagePath', line.image_path,
        'quantity', line.quantity,
        'unitPrice', line.applied_price,
        'purchaseMode', line.purchase_mode,
        'availability', line.availability_status,
        'subtotal', case
          when line.applied_price is null then null
          else line.applied_price * line.quantity
        end,
        'wholesaleRule', case
          when line.rule_id is null then null
          else jsonb_build_object(
            'id', line.rule_id,
            'name', line.rule_name,
            'minimumQuantity', line.minimum_quantity,
            'mixingPolicy', line.mixing_policy
          )
        end,
        'productQuantity', line.product_quantity
      ) order by line.input_order
    ), '[]'::jsonb),
    'totalUnits', coalesce(sum(line.quantity), 0),
    'subtotal', sum(line.applied_price * line.quantity) filter (where line.applied_price is not null),
    'unresolvedLines', count(*) filter (
      where line.availability_status = 'consult' or line.applied_price is null
    )
  ) into result
  from evaluated line;

  if jsonb_array_length(result -> 'lines') <> jsonb_array_length(p_lines) then
    raise exception using
      errcode = '22023',
      message = 'Una o más variantes no existen, están inactivas o no son públicas.';
  end if;

  return result;
end;
$$;

revoke execute on function public.catalog_list_v2(
  integer, integer, text, text, text, public.product_availability, jsonb, text
) from public;
revoke execute on function public.catalog_product_detail_v2(text) from public;
revoke execute on function public.evaluate_cart_v2(jsonb) from public;

grant execute on function public.catalog_list_v2(
  integer, integer, text, text, text, public.product_availability, jsonb, text
) to anon, authenticated, service_role;
grant execute on function public.catalog_product_detail_v2(text)
to anon, authenticated, service_role;
grant execute on function public.evaluate_cart_v2(jsonb)
to anon, authenticated, service_role;

commit;
