-- ---------------------------------------------------------------------------
-- 0048 — pos_variant_search: la venta encuentra el TONO, no el producto (B1)
--
-- La primera de las tres velocidades del POS es la principal: «sé qué quiere».
-- Hasta ahora el buscador devolvía productos, así que teclear «Abrumadora»
-- obligaba a abrir el esmalte y recorrer sus 200 tonos para encontrar el que
-- la vendedora ya sabía cuál era. Eso convierte la ruta más frecuente en la
-- más larga.
--
-- Esta función devuelve la VARIANTE directamente, buscando por todo lo que una
-- persona puede teclear o escanear en mostrador: producto, marca, línea,
-- nombre y código de tono, SKU y código de barras.
--
-- Orden de resultados por cómo se usa, no alfabético:
--   0  código de barras exacto  → viene de un escáner, no hay ambigüedad
--   1  SKU exacto
--   2  código de tono exacto    → «MSG-114» tecleado a mano
--   3  el nombre del tono empieza por lo tecleado  → «Abru» → «Abrumadora»
--   4  el resto de coincidencias
-- Dentro de cada grupo, lo disponible antes que lo agotado: un tono sin stock
-- no es lo que quiere ver primero quien está cobrando.
--
-- SECURITY DEFINER siguiendo la doctrina de 0046: con INVOKER, cada acceso a
-- productos, variantes, tonos y existencias re-evaluaría la RLS por fila. La
-- revalidación va explícita dentro y es la misma que exige el dominio —
-- assert_branch_access—, así que no se expone ni una fila que la RLS no
-- dejara ver: sin sesión no devuelve nada, y con sesión solo de sedes propias.
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
  v_rows jsonb;
begin
  -- La revalidación NO es opcional: DEFINER apaga la RLS y este es el único
  -- sitio donde vuelve a comprobarse quién pregunta y por qué sede.
  perform public.assert_branch_access(p_branch_id, 'buscar productos para vender');

  -- Sin sesión no hay personal y no hay nada que devolver. assert_branch_access
  -- deja pasar a auth.uid() nulo (lo usan los seeds), así que aquí se corta.
  if auth.uid() is null then
    return jsonb_build_object('items', '[]'::jsonb, 'total', 0);
  end if;

  v_query := nullif(btrim(coalesce(p_query, '')), '');
  v_limit := least(greatest(coalesce(p_limit, 24), 1), 60);

  if v_query is null then
    return jsonb_build_object('items', '[]'::jsonb, 'total', 0);
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
      p.unit_price,
      p.wholesale_price,
      p.wholesale_min_quantity,
      b.name              as brand_name,
      pl.name             as line_name,
      cs.name             as shade_name,
      cs.code             as shade_code,
      cs.reference_color,
      public.variant_effective_availability(v.id) as availability,
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
  ordenadas as (
    select *
    from candidatas
    order by
      rango,
      -- Lo que se puede vender, primero. Quien cobra no quiere ver agotados.
      (availability = 'sold_out') asc,
      product_name,
      shade_name nulls last,
      variant_name
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
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
  ) order by rango,
      (availability = 'sold_out') asc,
      product_name,
      shade_name nulls last,
      variant_name), '[]'::jsonb)
  into v_rows
  from ordenadas;

  return jsonb_build_object('items', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

comment on function public.pos_variant_search(uuid, text, integer) is
  'Búsqueda del POS que devuelve la variante directa (B1). Revalida el alcance por sede dentro, porque es SECURITY DEFINER.';

revoke all on function public.pos_variant_search(uuid, text, integer) from public;
grant execute on function public.pos_variant_search(uuid, text, integer) to authenticated;

-- El buscador teclea letra a letra: sin índices sobre lo que se busca, cada
-- pulsación es un scan secuencial de todas las variantes.
create index if not exists color_shades_name_trgm_idx
  on public.color_shades using gin (lower(name) public.gin_trgm_ops);

create index if not exists product_variants_barcode_idx
  on public.product_variants (lower(barcode))
  where barcode is not null;
