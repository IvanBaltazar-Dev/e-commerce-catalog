-- ---------------------------------------------------------------------------
-- 0076 · Las facetas del catálogo se precalculan, no se descubren en cada visita
-- ---------------------------------------------------------------------------
-- Abrir /catalogo sin buscar nada costaba 41 s con 100 000 productos, y 25 de
-- esos segundos eran las FACETAS: `availableFilters` preguntaba, por cada
-- atributo filtrable y por cada una de sus opciones, si existía en el conjunto
-- filtrado. Con un EXISTS correlacionado. Son 657 recorridos del catálogo
-- entero para contestar algo que, cuando no hay ningún filtro puesto, es el
-- mismo en todas las visitas.
--
-- 0073 lo bajó a una sola pasada (~1 s). Sigue siendo demasiado para algo que
-- no cambia entre peticiones.
--
-- LA FORMA: una proyección con qué opciones existen de verdad en el catálogo
-- PUBLICADO. `catalog_list_v2` la lee en vez de descubrirla.
--
-- POR QUÉ SOLO SIRVE SIN FILTROS: las facetas de un conjunto filtrado son las
-- de ESE conjunto, no las del catálogo. Pero eso ya era barato —filtrar por
-- marca deja el listado en 163 ms— porque el conjunto es pequeño. Lo caro era
-- justo el caso en que la respuesta es global. Así que la proyección se usa
-- cuando no hay nada que estreche, y se calcula al vuelo cuando sí lo hay.
--
-- POR QUÉ POR DEFINICIÓN Y NO ENTERA: reconstruir la proyección completa cuesta
-- ~1 s con 100 000 productos. Si cada edición de un producto la reconstruyera
-- entera, habríamos movido el segundo de la lectura a la escritura. Se
-- reconstruye solo lo de las definiciones afectadas, que es un recorrido de
-- rango sobre `(attribute_definition_id, option_id, variant_id)` — el índice
-- que ya existía para las facetas.
-- ---------------------------------------------------------------------------

begin;

create table if not exists public.catalog_facet_presence (
  attribute_definition_id uuid not null references public.attribute_definitions(id) on delete cascade,
  option_id uuid not null references public.attribute_options(id) on delete cascade,
  primary key (attribute_definition_id, option_id)
);

comment on table public.catalog_facet_presence is
  'Qué opciones de atributo existen de verdad en el catálogo publicado. Proyección mantenida por disparador: la fuente sigue siendo product_attribute_values y variant_attribute_values. Solo la consulta el listado del catálogo cuando no hay ningún filtro que estreche el conjunto.';

alter table public.catalog_facet_presence enable row level security;

-- Nadie la lee directamente. Es infraestructura de `catalog_list_v2`, no una
-- superficie: quien quiere saber qué filtros hay pregunta por el contrato, que
-- es SECURITY DEFINER y la lee por dentro. Sin política y sin privilegios para
-- `anon` ni `authenticated`, la tabla no existe para el cliente — y la línea
-- base de privilegios de `anon` no se mueve.
revoke all on public.catalog_facet_presence from public, anon, authenticated;
grant select, insert, update, delete on public.catalog_facet_presence to service_role;

-- ---------------------------------------------------------------------------
-- Reconstrucción, acotada a las definiciones que cambiaron
-- ---------------------------------------------------------------------------
create or replace function public.refresh_catalog_facet_presence(p_definition_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  if p_definition_ids is null or array_length(p_definition_ids, 1) is null then
    return 0;
  end if;

  delete from public.catalog_facet_presence presencia
  where presencia.attribute_definition_id = any(p_definition_ids);

  insert into public.catalog_facet_presence (attribute_definition_id, option_id)
  select distinct value.attribute_definition_id, value.option_id
  from public.product_attribute_values value
  join public.products product on product.id = value.product_id
  where value.attribute_definition_id = any(p_definition_ids)
    and value.option_id is not null
    and product.is_active
    and product.editorial_status = 'published'
  union
  select distinct value.attribute_definition_id, value.option_id
  from public.variant_attribute_values value
  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
  join public.products product on product.id = variant.product_id
  where value.attribute_definition_id = any(p_definition_ids)
    and value.option_id is not null
    and product.is_active
    and product.editorial_status = 'published'
  on conflict do nothing;

  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

revoke execute on function public.refresh_catalog_facet_presence(uuid[]) from public;
grant execute on function public.refresh_catalog_facet_presence(uuid[]) to service_role;

create or replace function public.rebuild_catalog_facet_presence()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  delete from public.catalog_facet_presence;

  insert into public.catalog_facet_presence (attribute_definition_id, option_id)
  select distinct value.attribute_definition_id, value.option_id
  from public.product_attribute_values value
  join public.products product on product.id = value.product_id
  where value.option_id is not null
    and product.is_active and product.editorial_status = 'published'
  union
  select distinct value.attribute_definition_id, value.option_id
  from public.variant_attribute_values value
  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
  join public.products product on product.id = variant.product_id
  where value.option_id is not null
    and product.is_active and product.editorial_status = 'published';

  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

revoke execute on function public.rebuild_catalog_facet_presence() from public;
grant execute on function public.rebuild_catalog_facet_presence() to service_role;

-- ---------------------------------------------------------------------------
-- Quién avisa. Por sentencia, como en 0072: una importación masiva reconstruye
-- una vez con todas las definiciones tocadas, no una vez por fila.
-- ---------------------------------------------------------------------------
create or replace function public.trg_facets_from_variant_values()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_catalog_facet_presence(
    array(select distinct attribute_definition_id from afectadas where attribute_definition_id is not null));
  return null;
end;
$$;

create or replace function public.trg_facets_from_product_values()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_catalog_facet_presence(
    array(select distinct attribute_definition_id from afectadas where attribute_definition_id is not null));
  return null;
end;
$$;

-- Publicar o retirar un producto cambia qué opciones existen en el catálogo
-- publicado, aunque no se toque ningún valor de atributo.
create or replace function public.trg_facets_from_products()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_definiciones uuid[];
begin
  select array(
    select distinct value.attribute_definition_id
    from public.variant_attribute_values value
    join public.product_variants variant on variant.id = value.variant_id
    join nuevas n on n.id = variant.product_id
    join viejas v on v.id = n.id
    where (n.is_active, n.editorial_status) is distinct from (v.is_active, v.editorial_status)
    union
    select distinct value.attribute_definition_id
    from public.product_attribute_values value
    join nuevas n on n.id = value.product_id
    join viejas v on v.id = n.id
    where (n.is_active, n.editorial_status) is distinct from (v.is_active, v.editorial_status)
  ) into v_definiciones;

  perform public.refresh_catalog_facet_presence(v_definiciones);
  return null;
end;
$$;

create or replace function public.trg_facets_from_variants()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_definiciones uuid[];
begin
  select array(
    select distinct value.attribute_definition_id
    from public.variant_attribute_values value
    join nuevas n on n.id = value.variant_id
    join viejas v on v.id = n.id
    where n.is_active is distinct from v.is_active
  ) into v_definiciones;

  perform public.refresh_catalog_facet_presence(v_definiciones);
  return null;
end;
$$;

revoke execute on function public.trg_facets_from_variant_values() from public;
revoke execute on function public.trg_facets_from_product_values() from public;
revoke execute on function public.trg_facets_from_products() from public;
revoke execute on function public.trg_facets_from_variants() from public;

drop trigger if exists variant_values_refresh_facets_ins on public.variant_attribute_values;
create trigger variant_values_refresh_facets_ins
after insert on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_facets_from_variant_values();

drop trigger if exists variant_values_refresh_facets_upd on public.variant_attribute_values;
create trigger variant_values_refresh_facets_upd
after update on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_facets_from_variant_values();

drop trigger if exists variant_values_refresh_facets_del on public.variant_attribute_values;
create trigger variant_values_refresh_facets_del
after delete on public.variant_attribute_values
referencing old table as afectadas
for each statement execute function public.trg_facets_from_variant_values();

drop trigger if exists product_values_refresh_facets_ins on public.product_attribute_values;
create trigger product_values_refresh_facets_ins
after insert on public.product_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_facets_from_product_values();

drop trigger if exists product_values_refresh_facets_upd on public.product_attribute_values;
create trigger product_values_refresh_facets_upd
after update on public.product_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_facets_from_product_values();

drop trigger if exists product_values_refresh_facets_del on public.product_attribute_values;
create trigger product_values_refresh_facets_del
after delete on public.product_attribute_values
referencing old table as afectadas
for each statement execute function public.trg_facets_from_product_values();

drop trigger if exists products_refresh_facets on public.products;
create trigger products_refresh_facets
after update on public.products
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_facets_from_products();

drop trigger if exists product_variants_refresh_facets on public.product_variants;
create trigger product_variants_refresh_facets
after update on public.product_variants
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_facets_from_variants();

-- ---------------------------------------------------------------------------
-- El listado lee la proyección en vez de descubrir las facetas
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.catalog_list_v2(p_page integer DEFAULT 1, p_page_size integer DEFAULT 24, p_search text DEFAULT NULL::text, p_brand_slug text DEFAULT NULL::text, p_category_path text DEFAULT NULL::text, p_availability product_availability DEFAULT NULL::product_availability, p_attribute_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'featured'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  safe_page integer := greatest(coalesce(p_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(p_page_size, 24), 1), 100);
  safe_filters jsonb := coalesce(p_attribute_filters, '{}'::jsonb);
  -- El término pasa por la MISMA normalización que el documento. Si uno de
  -- los dos no pasa por `search_normalize`, «lámpara» no encuentra «lampara».
  v_pattern text := case
    when public.search_normalize(p_search) is null then null
    else '%' || public.search_normalize(p_search) || '%'
  end;
  -- ¿Hay algo que estreche el conjunto? Si no lo hay, las facetas son las del
  -- catálogo entero: la misma respuesta en todas las visitas, y por eso está
  -- precalculada en catalog_facet_presence. Si lo hay, el conjunto es pequeño
  -- y calcularlas al vuelo es barato — filtrar por marca deja el listado en
  -- 163 ms con 100 000 productos.
  v_sin_filtros boolean;
  result jsonb;
begin
  if jsonb_typeof(safe_filters) <> 'object' then
    raise exception using errcode = '22023', message = 'attribute_filters debe ser un objeto JSON.';
  end if;

  if coalesce(p_sort, 'featured') not in ('featured', 'name_asc', 'name_desc', 'price_asc', 'price_desc') then
    raise exception using errcode = '22023', message = 'Orden de catálogo no permitido.';
  end if;

  v_sin_filtros := p_brand_slug is null
    and p_category_path is null
    and p_availability is null
    and public.search_normalize(p_search) is null
    and safe_filters = '{}'::jsonb;

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
  -- Los filtros baratos van en su PROPIO paso. No es cosmetica: el anti-join
  -- de los filtros de atributo hace que el planificador estime 493 filas donde
  -- hay 100 007 —se equivoca 200 veces— y con esa estimacion elige bucle
  -- anidado, asi que recorre las 184 marcas y las 64 categorias UNA VEZ POR
  -- PRODUCTO. Cuatro segundos de los cinco que costaba listar. Separado, este
  -- primer paso se estima bien y el plan sale correcto.
  base_products as materialized (
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
      -- Una comparación contra un documento indexado, en vez de un tsvector
      -- (palabras completas), una similitud y dos ilike sin índice por producto.
      -- El documento de la variante ya incluye lo del producto, la marca, la
      -- línea, el tono y los atributos buscables: no hace falta mirar en cinco
      -- sitios porque ya están todos en uno.
      and (
        v_pattern is null
        or product.search_text like v_pattern
        or exists (
          select 1
          from public.product_variants variant
          where variant.product_id = product.id
            and variant.is_active
            and variant.search_document like v_pattern
        )
      )
  ),
  filtered_products as materialized (
    select base.id
    from base_products base
    where true
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
             where product_value.product_id = base.id
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
             where variant.product_id = base.id
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
          case when p_sort = 'price_asc' then product.starting_price end asc nulls last,
          case when p_sort = 'price_desc' then product.starting_price end desc nulls last,
          lower(product.name),
          product.id
      ) as ord
    from filtered_products filtered
    join public.products product on product.id = filtered.id
    -- El precio inicial ya vive en el producto, mantenido por disparador.
    -- Antes era una union de tres tablas POR PRODUCTO dentro del ORDER BY: con
    -- 100 000 productos, ordenar por precio costaba 14 s.
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
      product.starting_price,
      jsonb_build_object(
        'min', product.starting_price,
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
  -- Qué atributos y qué opciones existen DE VERDAD en el conjunto filtrado.
  -- Se calcula UNA vez. Antes cada atributo y cada opción preguntaban por su
  -- cuenta con un EXISTS correlacionado: 657 recorridos de los 100 000
  -- productos filtrados, 25 s. Aquí es una pasada y una tabla hash.
  facet_presence as materialized (
    -- Sin filtros: se LEE lo precalculado. Con filtros: se calcula, porque
    -- las facetas de un conjunto estrechado son las de ESE conjunto. Las dos
    -- ramas van guardadas por la misma condición, que no depende de la fila,
    -- así que el planificador la resuelve una vez y se salta la otra entera.
    select presencia.attribute_definition_id as definition_id, presencia.option_id
    from public.catalog_facet_presence presencia
    where v_sin_filtros
    union
    select distinct value.attribute_definition_id, value.option_id
    from public.product_attribute_values value
    join filtered_products filtered on filtered.id = value.product_id
    where not v_sin_filtros and value.option_id is not null
    union
    select distinct value.attribute_definition_id, value.option_id
    from public.variant_attribute_values value
    join public.product_variants variant on variant.id = value.variant_id and variant.is_active
    join filtered_products filtered on filtered.id = variant.product_id
    where not v_sin_filtros and value.option_id is not null
  ),

  available_filter_rows as (
    select
      definition.id,
      definition.code,
      definition.name,
      definition.data_type,
      definition.sort_order
    from public.attribute_definitions definition
    where definition.is_active
      and definition.is_filterable
      and exists (
        select 1 from facet_presence presence
        where presence.definition_id = definition.id
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
              and exists (
                select 1 from facet_presence presence
                where presence.option_id = option.id
              )
          ), '[]'::jsonb)
        ) order by filter.sort_order, filter.name
      )
      from available_filter_rows filter
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

commit;

select public.rebuild_catalog_facet_presence();

analyze public.catalog_facet_presence;
