-- ---------------------------------------------------------------------------
-- 0079 · El POS y el catálogo leen las proyecciones
-- ---------------------------------------------------------------------------
-- 0078 creó las proyecciones y las rellenó. Esta migración cambia quién las
-- lee, y con eso desaparecen dos patrones que costaban segundos.
--
-- EL PRIMERO: cinco comparaciones con OR sobre cuatro tablas para los términos
-- de una o dos letras. Era el mismo error que 0072 vino a corregir, reaparecido
-- en otra forma. Ahora los identificadores son FILAS de `variant_search_codes`
-- —sku, internal_code, barcode, shade_code, supplier_code— y buscar «ml» es un
-- recorrido de rango sobre UNA columna indexada. Un identificador nuevo mañana
-- es otro `code_type`, no otra rama OR.
--
-- EL SEGUNDO: el catálogo preguntaba, por CADA uno de los 100 000 productos,
-- si alguna de sus variantes coincidía. Ahora pregunta al revés — documento
-- indexado → productos coincidentes → los 24 de la página — contra
-- `product_catalog_projection`, que tiene una fila por producto con el
-- documento agregado de sus variantes activas.
--
-- Y el precio inicial del orden sale de esa misma proyección, no de una columna
-- de `products` cuya escritura arrastraba los disparadores de la tabla.
--
-- LO QUE NO CAMBIA: la semántica del POS. Lo disponible sigue primero, la
-- disponibilidad se sigue leyendo de `inventory_stock` —no se proyecta— y el
-- precio se sigue calculando después del corte a 24.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pos_variant_search(p_branch_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_query text;
  v_pattern text;
  v_termino text;
  v_prefijo text;
  v_corto boolean;
  v_limit integer;
  v_seller uuid;
  v_result jsonb;
begin
  -- La revalidación NO es opcional: DEFINER apaga la RLS y este es el único
  -- sitio donde vuelve a comprobarse quién pregunta y por qué sede.
  perform public.assert_branch_access(p_branch_id, 'buscar productos para vender');

  v_seller := auth.uid();
  if v_seller is null then
    return jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'products', '[]'::jsonb);
  end if;

  v_query := nullif(btrim(coalesce(p_query, '')), '');
  v_limit := least(greatest(coalesce(p_limit, 24), 1), 60);

  -- Sin término NO se devuelve vacío. Un buscador en blanco al abrir la
  -- pantalla de venta no le dice a nadie qué hacer; los más vendidos de la
  -- sede sí, y son casi siempre lo que se está a punto de vender.
  v_termino := coalesce(public.search_normalize(v_query), '');
  v_corto := v_termino <> '' and length(v_termino) < 3;
  v_prefijo := v_termino || '%';
  v_pattern := '%' || v_termino || '%';

  with mas_vendidos as (
    -- Lo vendido en ESTA sede los últimos 60 días. Ventana rodante a
    -- propósito: aquí «más vendido» significa «lo que sale ahora», no un
    -- periodo contable.
    -- `sale_lines` guarda la VARIANTE (y el nombre del producto congelado al
    -- vender), no el product_id: hay que subir por product_variants.
    select pv.product_id, sum(sl.quantity) as unidades
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.product_variants pv on pv.id = sl.variant_id
    where s.branch_id = p_branch_id
      and s.status = 'confirmed'
      and s.issued_at >= now() - interval '60 days'
    group by pv.product_id
    order by unidades desc
    limit 6
  ),
  -- QUÉ coincide se resuelve primero, contra las proyecciones indexadas y
  -- sin tocar ninguna tabla de negocio. Con tres o más caracteres, el
  -- documento; con uno o dos, los códigos — que son FILAS de
  -- `variant_search_codes`, así que es un recorrido de rango sobre una sola
  -- columna indexada y no cinco comparaciones con OR sobre cuatro tablas.
  coincidencias as (
    select proyeccion.variant_id
    from public.variant_search_projection proyeccion
    where v_query is not null and not v_corto
      and proyeccion.search_document like v_pattern
    union
    select distinct codigo.variant_id
    from public.variant_search_codes codigo
    where v_query is not null and v_corto
      and codigo.normalized_code like v_prefijo
  ),
  candidatas as (
    select
      v.id                as variant_id,
      v.sku,
      v.barcode,
      v.name              as variant_name,
      p.id                as product_id,
      p.name              as product_name,
      p.presentation,
      p.wholesale_min_quantity,
      b.name              as brand_name,
      pl.name             as line_name,
      cs.name             as shade_name,
      cs.code             as shade_code,
      cs.reference_color,
      -- En la sede desde la que se vende, no agregando todas las tiendas.
      --
      -- La MISMA regla de `variant_effective_availability`, escrita aquí sobre
      -- la posición que este SELECT ya tiene unida. Llamar a la función costaba
      -- una segunda lectura de `product_variants` y de `inventory_stock` POR
      -- FILA, y con un término poco selectivo son 20 278 filas. La clave de
      -- `inventory_stock` es (variant_id, branch_id), así que la fila del join
      -- ES la posición de esta sede: no hay nada que sumar.
      --
      -- Si la regla cambia, cambia en los dos sitios. Por eso 0074 la fija con
      -- una prueba que compara esta expresión contra la función, variante a
      -- variante, sobre todas las combinaciones de estado y existencia.
      case
        when v.availability_status = 'consult'  then 'consult'::public.product_availability
        when v.availability_status = 'sold_out' then 'sold_out'::public.product_availability
        when v.availability_status = 'available'
         and v.tracks_inventory
         and coalesce(st.available_quantity, 0) <= 0
          then 'sold_out'::public.product_availability
        else v.availability_status
      end as availability,
      v.tracks_inventory,
      coalesce(st.available_quantity, 0) as available_quantity,
      case
        when v.barcode is not null and lower(v.barcode) = lower(v_query) then 0
        when v.sku is not null and lower(v.sku) = lower(v_query) then 1
        when cs.code is not null and lower(cs.code) = lower(v_query) then 2
        when cs.name is not null and lower(cs.name) like lower(v_query) || '%' then 3
        when lower(v.name) like lower(v_query) || '%' then 3
        else 4
      end as rango
    from public.product_variants v
    join public.products p on p.id = v.product_id
    join public.brands b on b.id = p.brand_id
    left join public.color_shades cs on cs.id = v.color_shade_id
    left join public.product_lines pl on pl.id = cs.product_line_id
    left join public.inventory_stock st
      on st.variant_id = v.id and st.branch_id = p_branch_id
    where v.is_active
      and p.is_active
      -- Con término se busca en todo el catálogo; sin término, solo entre los
      -- más vendidos (si no, «vacío» devolvería los 1.000+ productos).
      and (v_query is not null or p.id in (select product_id from mas_vendidos))
      -- Ya no se compara texto aquí: se une al conjunto que las
      -- proyecciones resolvieron arriba.
      and (v_query is null or v.id in (select variant_id from coincidencias))
  ),
  items as (
    select coalesce(jsonb_agg(fila order by rango, agotado, product_name, shade_name nulls last, variant_name), '[]'::jsonb) as data
    from (
      select
        rango,
        (availability = 'sold_out') as agotado,
        product_name,
        shade_name,
        variant_name,
        jsonb_build_object(
          'variantId', variant_id,
          'sku', sku,
          'barcode', barcode,
          'variantName', variant_name,
          'productId', product_id,
          'productName', product_name,
          'presentation', presentation,
          'brandName', brand_name,
          'lineName', line_name,
          'shadeName', shade_name,
          'shadeCode', shade_code,
          'referenceColor', reference_color,
          'unitPrice', unit_price,
          'wholesalePrice', wholesale_price,
          -- El umbral es del producto y lo configura la dueña. Nunca una constante.
          'wholesaleMinQuantity', wholesale_min_quantity,
          'availability', availability,
          'tracksInventory', tracks_inventory,
          'availableQuantity', available_quantity
        ) as fila
      from (
        -- EL CORTE VA PRIMERO. Ordenar exige conocer `rango` y si está agotado
        -- —y ambos son baratos ahora—, pero el precio solo lo necesitan las que
        -- se van a mostrar. Antes se calculaba el de las 20 278.
        select pagina.*, precio.retail as unit_price, precio.wholesale as wholesale_price
        from (
          select *
          from candidatas
          where v_query is not null
          order by rango, (availability = 'sold_out'), product_name, shade_name nulls last, variant_name
          limit v_limit
        ) pagina
        cross join lateral public.pos_variant_prices(pagina.variant_id) precio
      ) con_precio
      order by rango, (availability = 'sold_out'), product_name, shade_name nulls last, variant_name
    ) ordenadas
  ),
  -- Los productos que aportan varias coincidencias: la pantalla los ofrece como
  -- «164 tonos · 152 disponibles → abrir» en vez de inundar la lista.
  grupos as (
    select
      product_id, product_name, brand_name, presentation, wholesale_min_quantity,
      count(*)::integer as matched
    from candidatas
    group by 1, 2, 3, 4, 5
    having count(*) > 1
    order by count(*) desc, product_name
    limit 12
  ),
  senales as (
    -- Una sola pasada por las ventas recientes de los productos agrupados.
    select
      sl.variant_id,
      sv.product_id,
      max(s.issued_at) filter (where s.seller_id = v_seller) as last_sold_at,
      sum(sl.quantity)::integer                              as sold_units
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.product_variants sv on sv.id = sl.variant_id
    where s.status = 'confirmed'
      and s.issued_at >= now() - interval '30 days'
      and sv.product_id in (select product_id from grupos)
    group by sl.variant_id, sv.product_id
  ),
  -- Los tres tonos relevantes de la tarjeta: primero lo que ESTA vendedora
  -- despachó hace poco, después lo que más sale en la tienda. Nada de «los tres
  -- primeros alfabéticamente», que no le sirven a nadie.
  destacados as (
    select product_id, jsonb_agg(fila order by prioridad, orden desc) as data
    from (
      select
        sig.product_id,
        case when sig.last_sold_at is not null then 0 else 1 end as prioridad,
        coalesce(extract(epoch from sig.last_sold_at), sig.sold_units::numeric, 0) as orden,
        jsonb_build_object(
          'variantId', v3.id,
          'shadeName', cs3.name,
          'shadeCode', cs3.code,
          'variantName', v3.name,
          'referenceColor', cs3.reference_color,
          'swatchPath', (
            select ma.storage_path
            from public.product_media pm
            join public.media_assets ma on ma.id = pm.media_asset_id
            where pm.variant_id = v3.id and pm.media_role in ('swatch', 'main')
            order by (pm.media_role <> 'swatch'), pm.is_primary desc, pm.sort_order
            limit 1
          ),
          'availableQuantity', coalesce(st3.available_quantity, 0),
          'tracksInventory', v3.tracks_inventory,
          'reason', case when sig.last_sold_at is not null then 'reciente' else 'mas_vendido' end
        ) as fila,
        row_number() over (
          partition by sig.product_id
          order by (case when sig.last_sold_at is not null then 0 else 1 end),
                   coalesce(extract(epoch from sig.last_sold_at), sig.sold_units::numeric, 0) desc
        ) as puesto
      from senales sig
      join public.product_variants v3 on v3.id = sig.variant_id and v3.is_active
      left join public.color_shades cs3 on cs3.id = v3.color_shade_id
      left join public.inventory_stock st3
        on st3.variant_id = v3.id and st3.branch_id = p_branch_id
      where public.variant_effective_availability(v3.id, p_branch_id) = 'available'
    ) ranked
    where puesto <= 3
    group by product_id
  ),
  productos as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', g.product_id,
      'productName', g.product_name,
      'brandName', g.brand_name,
      'presentation', g.presentation,
      'priceFrom', catalogo.price_from,
      'priceTo', catalogo.price_to,
      'withoutPrice', catalogo.without_price,
      'wholesaleMinQuantity', g.wholesale_min_quantity,
      'wholesalePrice', catalogo.wholesale_from,
      'matchedVariants', g.matched,
      -- Los conteos son del PRODUCTO ENTERO, no de lo que coincidió: si la
      -- vendedora teclea «masglo roj» y salen 20, al abrir verá los 164.
      'toneCount', catalogo.tone_count,
      'availableCount', catalogo.available_count,
      'highlights', coalesce(d.data, '[]'::jsonb)
    ) order by g.matched desc, g.product_name), '[]'::jsonb) as data
    from grupos g
    cross join lateral (
      select
        count(*)::integer as tone_count,
        -- Misma regla que arriba, leída de la posición ya unida.
        count(*) filter (
          where v2.availability_status = 'available'
            and (not v2.tracks_inventory or coalesce(st2.available_quantity, 0) > 0)
        )::integer as available_count,
        min(precio2.retail) as price_from,
        min(precio2.wholesale) as wholesale_from,
        max(precio2.retail) as price_to,
        count(*) filter (where precio2.retail is null)::integer as without_price
      from public.product_variants v2
      left join public.inventory_stock st2
        on st2.variant_id = v2.id and st2.branch_id = p_branch_id
      cross join lateral public.pos_variant_prices(v2.id) precio2
      where v2.product_id = g.product_id and v2.is_active
    ) catalogo
    left join destacados d on d.product_id = g.product_id
  )
  select jsonb_build_object(
    'items',    (select data from items),
    'total',    jsonb_array_length((select data from items)),
    'products', (select data from productos)
  )
  into v_result;

  return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'products', '[]'::jsonb));
end;
$function$;

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
  v_termino text := coalesce(public.search_normalize(p_search), '');
  v_corto boolean := v_termino <> '' and length(v_termino) < 3;
  v_prefijo text := v_termino || '%';
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
  -- QUÉ productos coinciden, contra 100 000 filas indexadas. Antes esto
  -- era, por CADA producto, «¿alguna de tus variantes coincide?» — un
  -- EXISTS correlacionado contra los documentos de sus variantes.
  productos_coincidentes as materialized (
    select proyeccion.product_id
    from public.product_catalog_projection proyeccion
    where v_pattern is not null and not v_corto
      and proyeccion.search_document like v_pattern
    union
    select distinct variante.product_id
    from public.variant_search_codes codigo
    join public.variant_search_projection variante on variante.variant_id = codigo.variant_id
    where v_pattern is not null and v_corto
      and codigo.normalized_code like v_prefijo
  ),
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
      -- Una pertenencia a un conjunto ya resuelto por índice.
      and (v_pattern is null or product.id in (select product_id from productos_coincidentes))
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
          case when p_sort = 'price_asc' then catalogo.starting_price end asc nulls last,
          case when p_sort = 'price_desc' then catalogo.starting_price end desc nulls last,
          lower(product.name),
          product.id
      ) as ord
    from filtered_products filtered
    join public.products product on product.id = filtered.id
    left join public.product_catalog_projection catalogo on catalogo.product_id = product.id
    -- El precio inicial ya vive en el producto, mantenido por disparador.
    -- Antes era una union de tres tablas POR PRODUCTO dentro del ORDER BY: con
    -- 100 000 productos, ordenar por precio costaba 14 s.
    order by ord
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  ),
  -- El total se contaba DOS veces sobre una CTE materializada de 100 000
  -- filas: una para totalItems y otra para totalPages. Se cuenta una.
  total_items as materialized (
    select count(*)::integer as n from filtered_products
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
      catalogo.starting_price,
      jsonb_build_object(
        'min', catalogo.starting_price,
        'max', pricing.maximum_price,
        'currency', 'PEN'
      ) as price_range,
      availability.summary as availability_summary,
      variants.variant_count > 1 as has_multiple_variants,
      featured.variant as featured_variant
    from page_ids page
    join public.products product on product.id = page.product_id
    left join public.product_catalog_projection catalogo on catalogo.product_id = product.id
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
    'totalItems', (select n from total_items),
    'totalPages', ceil((select n from total_items)::numeric / safe_page_size)::integer,
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
