-- ---------------------------------------------------------------------------
-- 0059 · El mayoreo que se anuncia es el que se cobra
-- ---------------------------------------------------------------------------
-- Tres unidades de un esmalte con mayorista «S/ 10.50 desde 3» se cobraban a
-- S/ 12.50: 37.50 en vez de 31.50. La tarjeta anunciaba un descuento que el
-- carrito no aplicaba nunca.
--
-- La causa no era un cálculo mal hecho, sino DOS SISTEMAS DE MAYOREO que no se
-- hablaban:
--
--   · `products.wholesale_min_quantity` + la lista de precios mayorista. Es lo
--     que configura la dueña, lo que lee `pos_variant_prices` y lo que anuncia
--     la tarjeta del POS. Hay 1.056 productos con umbral puesto aquí.
--
--   · `wholesale_rules`, la tabla de reglas por variante/producto/marca/
--     categoría. Es lo ÚNICO que miraba `evaluate_cart_v2`. Tenía UNA fila
--     activa, y de otro producto.
--
-- O sea: para 1.055 de 1.056 productos, el POS prometía un precio que el
-- cobro ignoraba. Y como el importe lo calcula la base, no la pantalla, el
-- error llegaba hasta la venta registrada.
--
-- La regla del negocio es la primera: el umbral es POR PRODUCTO, suma TODAS sus
-- variantes, y lo configura la dueña —no es 3 fijo—. Así que `evaluate_cart_v2`
-- pasa a honrarla cuando ninguna regla explícita coincide. `wholesale_rules`
-- sigue mandando donde exista: es más específica y permite marca y categoría.
--
-- Ojo con el alcance: esta función también la usa la tienda pública, así que
-- corrige el precio en las dos superficies a la vez. Es lo correcto —un mismo
-- carrito no puede costar distinto según por dónde entre— pero conviene saberlo.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.evaluate_cart_v2(p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
      public.variant_effective_availability(variant.id) as availability_status,
      product.name as product_name,
      product.wholesale_min_quantity,
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
      coalesce(applied.amount, umbral.amount) as wholesale_price,
      case
        when line.availability_status = 'consult' then 'consult'
        when applied.rule_id is not null and applied.amount is not null then 'wholesale'
        when umbral.amount is not null then 'wholesale'
        else 'retail'
      end as purchase_mode,
      case
        when line.availability_status = 'consult' then null
        when applied.rule_id is not null and applied.amount is not null then applied.amount
        when umbral.amount is not null then umbral.amount
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
    -- Umbral propio del producto: la regla que de verdad usa la dueña.
    -- Solo entra si NINGUNA regla explícita coincidió, para no pisarlas.
    left join lateral (
      select price.amount
      from public.variant_prices price
      join public.price_lists price_list on price_list.id = price.price_list_id
      where applied.rule_id is null
        and line.wholesale_min_quantity is not null
        and line.product_quantity >= line.wholesale_min_quantity
        and price.variant_id = line.variant_id
        and price.is_active
        and price.validity @> now()
        and price_list.is_active
        and price_list.is_public
        and price_list.price_type = 'wholesale'
      order by price_list.priority desc, price.minimum_quantity desc
      limit 1
    ) umbral on true
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
          when line.rule_id is not null then jsonb_build_object(
            'id', line.rule_id,
            'name', line.rule_name,
            'minimumQuantity', line.minimum_quantity,
            'mixingPolicy', line.mixing_policy
          )
          -- El umbral del producto no tiene fila en wholesale_rules, pero la
          -- pantalla necesita el mínimo para explicar el asterisco.
          when line.purchase_mode = 'wholesale' then jsonb_build_object(
            'id', null,
            'name', 'Precio mayorista del producto',
            'minimumQuantity', line.wholesale_min_quantity,
            'mixingPolicy', 'product'
          )
          else null
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
$function$;
