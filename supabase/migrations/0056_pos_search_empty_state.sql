-- ---------------------------------------------------------------------------
-- 0056 · El buscador de la venta ya no arranca en blanco
-- ---------------------------------------------------------------------------
-- Al abrir «Nueva venta» el buscador estaba vacío y no proponía nada, así que
-- la pantalla no decía qué hacer: había que saber de antemano qué teclear.
-- `pos_variant_search` devolvía explícitamente items/products vacíos cuando no
-- había término.
--
-- Ahora el caso sin término devuelve los MÁS VENDIDOS de esa sede en los
-- últimos 60 días, que es casi siempre lo que se está a punto de vender. No es
-- una lista nueva ni otra función: cae por la misma tubería que la búsqueda
-- normal, así que las tarjetas, los precios, el stock por sede y el umbral
-- mayorista salen exactamente igual.
--
-- Solo se devuelven TARJETAS DE PRODUCTO, no filas de variante: sin término no
-- existe «la variante exacta que pidió», y ofrecer un tono suelto sin que nadie
-- lo haya pedido sería inventar una intención.
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
  v_pattern := '%' || lower(coalesce(v_query, '')) || '%';

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
  candidatas as (
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
      -- Con término se busca en todo el catálogo; sin término, solo entre los
      -- más vendidos (si no, «vacío» devolvería los 1.000+ productos).
      and (v_query is not null or p.id in (select product_id from mas_vendidos))
      and (v_query is null or (
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
      ))
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
      where v_query is not null
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
$function$;
