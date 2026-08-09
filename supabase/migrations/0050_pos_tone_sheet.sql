-- ---------------------------------------------------------------------------
-- 0050 — La hoja de tonos del POS (Fase 2, tercera velocidad de B1)
--
-- 0048 resolvió la primera velocidad: «sé qué quiere» → el buscador devuelve la
-- variante. Faltaba la tercera: «la clienta quiere elegir». Con 164 tonos de
-- Masglo en el catálogo real, teclear «masglo» devuelve 164 filas idénticas que
-- inundan el buscador y tapan los demás productos. Y no había forma de abrir
-- «todos los tonos de este esmalte» para que la clienta escoja mirando.
--
-- Esta migración añade dos cosas:
--
--   1. `pos_product_tones` — la hoja de tonos completa de UN producto: su
--      cabecera comercial (tonos totales, disponibles, precio, umbral mayorista
--      del producto) y TODOS sus tonos con lo que hace falta para elegir
--      mirando: foto real del tono, color de referencia, familia cromática,
--      acabado, código, y el stock DE ESA variante EN ESA sede.
--
--      Devuelve la lista entera de una vez, a propósito: la regla de
--      interacción exige que la cuadrícula NO se reordene ni se recargue
--      mientras la vendedora selecciona. Paginar por servidor obligaría a
--      refrescar en mitad de la selección, que es justo lo prohibido.
--
--   2. `pos_variant_search` con tres correcciones:
--      - agrupa por producto, para que la pantalla pueda ofrecer «164 tonos ·
--        152 disponibles → abrir» en vez de 164 filas;
--      - la disponibilidad se calcula EN LA SEDE desde la que se vende. Antes
--        agregaba todas las sedes activas, así que un tono agotado aquí podía
--        anunciarse como disponible porque quedaba stock en otra tienda;
--      - el precio sale de `variant_prices`, que es lo que se cobra, y no de
--        `products.unit_price`, que es la columna heredada de V1. Con el
--        catálogo real recién certificado esa columna vale 0.00 en 1.053 de
--        1.056 productos: el POS ofrecía «S/ 0.00» donde lo cierto es que
--        todavía NO HAY PRECIO. Sin precio vigente se devuelve null y la
--        pantalla lo dice; un cero es una cifra, y una cifra falsa se cobra.
--
-- Señales de relevancia (pestañas «Recientes» y «Más vendidos»): se derivan de
-- `sales` + `sale_lines`, sin tabla nueva, como se verificó al decidir el
-- diseño. La ventana de 30 días es rodante A PROPÓSITO — aquí «reciente»
-- significa «lo que esta vendedora ha despachado últimamente», no un periodo
-- contable; las comparaciones de negocio siguen exigiendo rangos explícitos.
--
-- SECURITY DEFINER con la misma doctrina de 0046/0048: la revalidación por sede
-- va explícita dentro, porque DEFINER apaga la RLS.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0. El precio vigente de una variante, en un solo sitio
-- ---------------------------------------------------------------------------
-- La regla de qué precio rige ya existía repartida por los contratos públicos
-- (0006, 0028, 0046) y es la misma que hace cumplir la guarda de publicación de
-- 0005: lista activa, precio activo y vigencia que contiene ahora. Aquí se
-- nombra una vez para que el POS no pueda enseñar un precio distinto del que
-- va a cobrar.
--
-- Devuelve null cuando no hay precio vigente. Null NO es cero: cero es una
-- cifra, y una cifra se cobra.

create or replace function public.pos_variant_prices(p_variant_id uuid)
returns table (retail numeric, wholesale numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select
    max(vp.amount) filter (where pl.price_type = 'retail')    as retail,
    max(vp.amount) filter (where pl.price_type = 'wholesale') as wholesale
  from public.variant_prices vp
  join public.price_lists pl on pl.id = vp.price_list_id
  where vp.variant_id = p_variant_id
    and vp.is_active
    and vp.validity @> now()
    and pl.is_active;
$$;

comment on function public.pos_variant_prices(uuid) is
  'Precio minorista y mayorista vigentes de una variante para el POS. Null '
  'cuando no hay precio: el catálogo importado todavía no tiene, y un cero '
  'impreso en la pantalla de venta se acaba cobrando.';

revoke all on function public.pos_variant_prices(uuid) from public, anon;
grant execute on function public.pos_variant_prices(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Hoja de tonos de un producto
-- ---------------------------------------------------------------------------

create or replace function public.pos_product_tones(
  p_branch_id uuid,
  p_product_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_seller uuid;
  v_result jsonb;
begin
  perform public.assert_branch_access(p_branch_id, 'ver los tonos de un producto');

  -- Sin sesión no hay vendedora y no hay nada que abrir.
  v_seller := auth.uid();
  if v_seller is null then
    return jsonb_build_object('product', null, 'families', '[]'::jsonb, 'tones', '[]'::jsonb);
  end if;

  with senales as (
    -- Una sola pasada por las ventas de los últimos 30 días. Preguntar «¿se
    -- vendió?» variante por variante costaría 164 consultas al abrir Masglo.
    select
      sl.variant_id,
      max(s.issued_at) filter (where s.seller_id = v_seller) as last_sold_at,
      sum(sl.quantity)::integer                              as sold_units
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.product_variants sv on sv.id = sl.variant_id
    where s.status = 'confirmed'
      and s.issued_at >= now() - interval '30 days'
      and sv.product_id = p_product_id
    group by sl.variant_id
  ),
  base as (
    select
      v.id                  as variant_id,
      v.sku,
      v.barcode,
      v.name                as variant_name,
      v.sort_order,
      v.tracks_inventory,
      cs.name               as shade_name,
      cs.code               as shade_code,
      cs.reference_color,
      fam.value             as family_value,
      fam.label             as family_label,
      coalesce(fam.sort_order, 9999) as family_sort,
      fin.label             as finish_label,
      swatch.storage_path   as swatch_path,
      -- Con la sede: un tono agotado aquí no se anuncia por el stock de otra.
      public.variant_effective_availability(v.id, p_branch_id) as availability,
      coalesce(st.available_quantity, 0) as available_quantity,
      precio.retail         as unit_price,
      precio.wholesale      as wholesale_price,
      sig.last_sold_at,
      coalesce(sig.sold_units, 0) as sold_units
    from public.product_variants v
    left join public.color_shades cs on cs.id = v.color_shade_id
    left join public.attribute_options fam on fam.id = cs.color_family_option_id
    left join public.inventory_stock st
      on st.variant_id = v.id and st.branch_id = p_branch_id
    cross join lateral public.pos_variant_prices(v.id) precio
    left join senales sig on sig.variant_id = v.id
    -- El acabado se nombra siempre que exista: un círculo plano no distingue un
    -- glitter de un cremoso, y la clienta pregunta justo por eso.
    left join lateral (
      select ao.label
      from public.variant_attribute_values vav
      join public.attribute_definitions ad
        on ad.id = vav.attribute_definition_id and ad.code = 'finish_type'
      join public.attribute_options ao on ao.id = vav.option_id
      where vav.variant_id = v.id
      limit 1
    ) fin on true
    -- La foto real manda sobre el color plano. `swatch` antes que `main` porque
    -- la primera es el tono aplicado y la segunda suele ser el envase.
    left join lateral (
      select ma.storage_path
      from public.product_media pm
      join public.media_assets ma on ma.id = pm.media_asset_id
      where pm.variant_id = v.id
        and pm.media_role in ('swatch', 'main')
      order by (pm.media_role <> 'swatch'), pm.is_primary desc, pm.sort_order
      limit 1
    ) swatch on true
    where v.product_id = p_product_id
      and v.is_active
  ),
  resumen as (
    select
      count(*)::integer as tone_count,
      count(*) filter (where availability = 'available')::integer as available_count,
      -- Un rango, no un precio único: dentro del mismo esmalte puede haber
      -- tonos con precio y tonos sin él, y decir «S/ 12.50» de todos mentiría.
      min(unit_price) as price_from,
      max(unit_price) as price_to,
      count(*) filter (where unit_price is null)::integer as without_price
    from base
  ),
  cabecera as (
    select jsonb_build_object(
      'productId', p.id,
      'name', p.name,
      'brandName', b.name,
      'lineName', pl.name,
      'presentation', p.presentation,
      'priceFrom', resumen.price_from,
      'priceTo', resumen.price_to,
      'withoutPrice', resumen.without_price,
      -- Del producto y configurable por la dueña. Jamás una constante.
      'wholesaleMinQuantity', p.wholesale_min_quantity,
      'toneCount', resumen.tone_count,
      'availableCount', resumen.available_count
    ) as data
    from public.products p
    join public.brands b on b.id = p.brand_id
    left join public.product_lines pl on pl.id = p.product_line_id
    cross join resumen
    where p.id = p_product_id and p.is_active
  ),
  -- Solo las familias PRESENTES en este producto, con su conteo: un filtro que
  -- ofrece «Azules» para un esmalte sin azules es una pantalla que miente.
  familias as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'value', family_value,
      'label', family_label,
      'toneCount', tone_count,
      'availableCount', available_count
    ) order by family_sort, family_label), '[]'::jsonb) as data
    from (
      select
        family_value,
        family_label,
        min(family_sort)  as family_sort,
        count(*)::integer as tone_count,
        count(*) filter (where availability = 'available')::integer as available_count
      from base
      where family_value is not null
      group by family_value, family_label
    ) agrupadas
  ),
  -- Orden estable y cromático: los tonos de la misma familia juntos, como en la
  -- carta física. Alfabético colocaría un rojo entre dos azules.
  tonos as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'variantId', variant_id,
      'sku', sku,
      'barcode', barcode,
      'variantName', variant_name,
      'shadeName', shade_name,
      'shadeCode', shade_code,
      'referenceColor', reference_color,
      'familyValue', family_value,
      'familyLabel', family_label,
      'finishLabel', finish_label,
      'swatchPath', swatch_path,
      'availability', availability,
      'tracksInventory', tracks_inventory,
      'availableQuantity', available_quantity,
      'unitPrice', unit_price,
      'wholesalePrice', wholesale_price,
      'lastSoldAt', last_sold_at,
      'soldUnits', sold_units
    ) order by family_sort, coalesce(shade_name, variant_name), sort_order), '[]'::jsonb) as data
    from base
  )
  select jsonb_build_object(
    'product',  (select data from cabecera),
    'families', (select data from familias),
    'tones',    (select data from tonos)
  )
  into v_result;

  return coalesce(v_result, jsonb_build_object('product', null, 'families', '[]'::jsonb, 'tones', '[]'::jsonb));
end;
$$;

comment on function public.pos_product_tones(uuid, uuid) is
  'Hoja de tonos completa de un producto para el POS (B1, tercera velocidad). '
  'Devuelve todos los tonos de una vez porque la cuadrícula no puede recargarse '
  'mientras la vendedora selecciona. Revalida la sede dentro: es SECURITY DEFINER.';

revoke all on function public.pos_product_tones(uuid, uuid) from public, anon;
grant execute on function public.pos_product_tones(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Búsqueda del POS: además de variantes, los productos agrupados
-- ---------------------------------------------------------------------------

create or replace function public.pos_variant_search(
  p_branch_id uuid,
  p_query text default null,
  p_limit integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text;
  v_pattern text;
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

  if v_query is null then
    return jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'products', '[]'::jsonb);
  end if;

  v_pattern := '%' || lower(v_query) || '%';

  with candidatas as (
    select
      v.id                as variant_id,
      v.sku,
      v.barcode,
      v.name              as variant_name,
      p.id                as product_id,
      p.name              as product_name,
      p.presentation,
      -- De `variant_prices`, que es lo que se cobra. Null si no hay vigente.
      precio.retail       as unit_price,
      precio.wholesale    as wholesale_price,
      p.wholesale_min_quantity,
      b.name              as brand_name,
      pl.name             as line_name,
      cs.name             as shade_name,
      cs.code             as shade_code,
      cs.reference_color,
      -- En la sede desde la que se vende, no agregando todas las tiendas.
      public.variant_effective_availability(v.id, p_branch_id) as availability,
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
    cross join lateral public.pos_variant_prices(v.id) precio
    where v.is_active
      and p.is_active
      and (
        lower(p.name) like v_pattern
        or lower(coalesce(p.code, '')) like v_pattern
        or lower(coalesce(p.presentation, '')) like v_pattern
        or lower(b.name) like v_pattern
        or lower(coalesce(pl.name, '')) like v_pattern
        or lower(coalesce(cs.name, '')) like v_pattern
        or lower(coalesce(cs.code, '')) like v_pattern
        or lower(v.name) like v_pattern
        or lower(coalesce(v.sku, '')) like v_pattern
        or lower(coalesce(v.barcode, '')) like v_pattern
      )
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
      from candidatas
      order by rango, (availability = 'sold_out'), product_name, shade_name nulls last, variant_name
      limit v_limit
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
        count(*) filter (
          where public.variant_effective_availability(v2.id, p_branch_id) = 'available'
        )::integer as available_count,
        min(precio2.retail) as price_from,
        max(precio2.retail) as price_to,
        count(*) filter (where precio2.retail is null)::integer as without_price
      from public.product_variants v2
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
$$;

comment on function public.pos_variant_search(uuid, text, integer) is
  'Búsqueda del POS que devuelve la variante directa (B1) y, agrupados, los '
  'productos que aportan varias coincidencias para abrir su hoja de tonos. '
  'Revalida el alcance por sede dentro, porque es SECURITY DEFINER.';

revoke all on function public.pos_variant_search(uuid, text, integer) from public, anon;
grant execute on function public.pos_variant_search(uuid, text, integer) to authenticated;

-- Abrir una hoja de tonos pregunta qué se vendió en los últimos 30 días.
-- `sale_lines_variant_idx` cubre la búsqueda por variante, pero el filtro por
-- estado y fecha vive en `sales`: sin este índice, cada apertura recorre el
-- historial completo de ventas confirmadas.
create index if not exists sales_status_issued_idx
on public.sales (status, issued_at desc);
