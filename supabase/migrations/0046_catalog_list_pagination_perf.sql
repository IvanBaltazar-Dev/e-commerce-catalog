-- ---------------------------------------------------------------------------
-- 0046 — catalog_list_v2 pagina ANTES de construir las tarjetas (Bloque 5, §9)
--
-- El gate de rendimiento con volumen representativo (~1,500 SKUs) destapó que
-- `catalog_list_v2` agota el statement_timeout del rol público. El EXPLAIN
-- (ANALYZE, BUFFERS) mostró la causa exacta, no una intuición:
--
--     Function Scan … actual time=906ms … Buffers: shared hit=68849
--
-- 68 849 buffers (≈540 MB tocados) para devolver 24 productos. La función
-- materializaba la tarjeta COMPLETA —imagen, conteo de variantes, precios
-- mín/máx, resumen de disponibilidad con `variant_effective_availability`
-- por variante, y la variante destacada con sus propias subconsultas— para
-- CADA producto filtrado (los 1 500), y solo DESPUÉS ordenaba y cortaba 24.
-- Trabajo O(todos) para una página de 24.
--
-- La corrección, mínima y basada en la evidencia: se pagina sobre las claves
-- de orden BARATAS (nombre, destacado, orden, y el precio inicial —una sola
-- lateral— que exige el orden por precio) para obtener los 24 ids de la
-- página, y las laterales caras se construyen SOLO para esos 24. Los totales
-- y los filtros disponibles siguen saliendo de `filtered_products` (solo ids,
-- barato). Misma salida JSON, mismo orden, mismos totales — solo deja de
-- hacer 1 500 veces lo que basta hacer 24.
--
-- SEGUNDO hallazgo, más grave, del mismo EXPLAIN corrido con el ROL REAL:
--
--     as anon (RLS activa)   → 25 675 ms, Buffers shared hit=503 333
--     as postgres (sin RLS)  →    297 ms, Buffers shared hit= 30 792
--
-- La función era `stable` (INVOKER): cada acceso interno a productos,
-- variantes, precios, medios y atributos RE-EVALUABA las políticas RLS, y con
-- 1 500 productos eso es medio millón de comprobaciones — 25 s, por encima de
-- cualquier statement_timeout. Es exactamente la doctrina que el proyecto ya
-- aplica a los RPC de dominio: SECURITY DEFINER con la REVALIDACIÓN explícita
-- dentro. Aquí la revalidación es el propio filtro público —`is_active` y
-- `editorial_status = 'published'`, marca y categoría activas— que reproduce
-- letra por letra la política `is_public_catalog_product`. DEFINER no expone
-- ni un producto más que la RLS; solo deja de comprobar lo mismo 500 000
-- veces. Se añade el guard de categoría activa para que la equivalencia con
-- la política pública sea exacta.
--
-- No se añade ningún índice: el EXPLAIN no señaló un scan sin índice, señaló
-- volumen de trabajo. La regla §9 se respeta —no se optimiza por intuición—.
-- ---------------------------------------------------------------------------

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
security definer
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
    join public.brands brand on brand.id = product.brand_id and brand.is_active
    join public.categories product_category on product_category.id = product.category_id and product_category.is_active
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
            and public.variant_effective_availability(variant.id) = p_availability
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
  -- LA PÁGINA PRIMERO: se ordena por las claves baratas (y el precio inicial,
  -- una sola lateral) y se cortan 24 ids ANTES de construir nada caro.
  page_ids as materialized (
    select
      product.id as product_id,
      row_number() over (
        order by
          case when p_sort = 'featured' then product.is_featured end desc,
          case when p_sort = 'featured' then product.sort_order end asc,
          case when p_sort = 'name_asc' then lower(product.name) end asc,
          case when p_sort = 'name_desc' then lower(product.name) end desc,
          case when p_sort = 'price_asc' then pricing.starting_price end asc nulls last,
          case when p_sort = 'price_desc' then pricing.starting_price end desc nulls last,
          lower(product.name),
          product.id
      ) as ord
    from filtered_products filtered
    join public.products product on product.id = filtered.id
    cross join lateral (
      select min(price.amount) as starting_price
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
    order by ord
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  ),
  card_rows as materialized (
    select
      page.ord,
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
    from page_ids page
    join public.products product on product.id = page.product_id
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
        'available', count(*) filter (where public.variant_effective_availability(variant.id) = 'available'),
        'soldOut', count(*) filter (where public.variant_effective_availability(variant.id) = 'sold_out'),
        'consult', count(*) filter (where public.variant_effective_availability(variant.id) = 'consult')
      ) as summary
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ) availability
    left join lateral (
      select jsonb_build_object(
        'id', variant.id,
        'sku', variant.sku,
        'name', variant.name,
        'availability', public.variant_effective_availability(variant.id),
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
        ) order by card.ord
      )
      from card_rows card
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

-- El grant se conserva; 0045 ya dejó a anon/authenticated con EXECUTE sobre
-- esta firma, y `create or replace` no lo altera. Se reafirma por claridad.
grant execute on function public.catalog_list_v2(integer, integer, text, text, text, public.product_availability, jsonb, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El detalle comparte el mismo problema de RLS-por-fila (aunque de un solo
-- producto): se lleva a SECURITY DEFINER con su filtro publicado+activo como
-- revalidación. No se reescribe su cuerpo —ya es eficiente para un producto—;
-- solo se cambia el modo de seguridad con ALTER, que preserva la definición.
-- ---------------------------------------------------------------------------
alter function public.catalog_product_detail_v2(text) security definer;
