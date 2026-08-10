-- ---------------------------------------------------------------------------
-- 0080 · Las proyecciones se mantienen solas, y el tablero también las lee
-- ---------------------------------------------------------------------------
-- 0078 creó las proyecciones y sus funciones de reconstrucción; 0079 cambió
-- quién las lee. Faltaba lo que las mantiene: hasta esta migración eran fotos
-- fijas, correctas al rellenarlas y desactualizadas al primer cambio.
--
-- Cada proyección tiene su propio disparador y su propio evento, y todos
-- comparan viejo contra nuevo antes de hacer nada. Eso no es afinado: es lo que
-- sostiene la separación. Un disparador que reaccione a «cualquier UPDATE de
-- product_variants» recalcularía precios al escribir un documento de búsqueda,
-- que es el defecto que estas proyecciones vienen a corregir.
--
-- Lo que queda garantizado:
--
--   renombrar una marca   → reconstruye documentos · NO recalcula precios
--   cambiar un precio     → recalcula el precio    · NO toca documentos
--   activar una variante  → recalcula el precio    · NO reescribe su documento
--   registrar una venta   → mueve inventory_stock  · NO toca ninguna proyección
--
-- Y `inventory_board` deja de leer la columna vieja de `product_variants`: era
-- el último consumidor que quedaba.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.inventory_board(p_branch_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_only_reposition boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_pattern text;
  v_from date;
  v_to date;
  v_dias integer;
  v_items jsonb;
begin
  -- Rangos explícitos, nunca `interval '30 days'` escondido en el medio: quien
  -- llama decide el periodo y la cobertura se puede auditar contra él.
  v_to := coalesce(p_to, current_date);
  v_from := coalesce(p_from, v_to - 29);
  v_dias := greatest((v_to - v_from) + 1, 1);

  v_pattern := case
    when nullif(btrim(coalesce(p_query, '')), '') is null then null
    else '%' || public.search_normalize(p_query) || '%'
  end;

  with posiciones as (
    select
      ip.variant_id,
      ip.branch_id,
      ip.on_hand,
      ip.reserved,
      ip.available_quantity,
      ip.unvalued_quantity,
      ip.average_unit_cost,
      ip.total_value,
      v.sku,
      v.name as variant_name,
      p.id as product_id,
      p.name as product_name,
      p.presentation,
      b.name as brand_name,
      cs.name as shade_name,
      cs.code as shade_code,
      cs.reference_color,
      br.name as branch_name
    from public.inventory_position ip
    join public.product_variants v on v.id = ip.variant_id
    join public.products p on p.id = v.product_id
    join public.brands b on b.id = p.brand_id
    join public.branches br on br.id = ip.branch_id
    left join public.color_shades cs on cs.id = v.color_shade_id
    where (p_branch_id is null or ip.branch_id = p_branch_id)
      and (
        v_pattern is null
        -- Contra la proyección, no contra la columna de product_variants.
        or exists (
          select 1 from public.variant_search_projection proyeccion
          where proyeccion.variant_id = v.id
            and proyeccion.search_document like v_pattern
        )
      )
  ),
  -- La salida del periodo sale de las ventas confirmadas, que son las que de
  -- verdad movieron mercadería.
  salidas as (
    select sl.variant_id, s.branch_id, sum(sl.quantity)::numeric as unidades
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    where s.status = 'confirmed'
      and s.issued_at >= v_from::timestamptz
      and s.issued_at < (v_to + 1)::timestamptz
    group by sl.variant_id, s.branch_id
  ),
  evaluadas as (
    select
      po.*,
      coalesce(sa.unidades, 0) as unidades_periodo,
      -- Cobertura en días: cuánto dura lo disponible al ritmo del periodo. Si
      -- no hubo salidas no se estima nada, se deja en nulo y la pantalla lo dice.
      case
        when coalesce(sa.unidades, 0) > 0
          then round(po.available_quantity / (sa.unidades / v_dias), 1)
        else null
      end as cobertura_dias
    from posiciones po
    left join salidas sa on sa.variant_id = po.variant_id and sa.branch_id = po.branch_id
  ),
  clasificadas as (
    select
      ev.*,
      case
        when ev.available_quantity <= 0 then 'agotado'
        when ev.cobertura_dias is not null and ev.cobertura_dias < 7 then 'cobertura'
        else null
      end as motivo
    from evaluadas ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'variantId', variant_id,
    'branchId', branch_id,
    'branchName', branch_name,
    'sku', sku,
    'variantName', variant_name,
    'productId', product_id,
    'productName', product_name,
    'presentation', presentation,
    'brandName', brand_name,
    'shadeName', shade_name,
    'shadeCode', shade_code,
    'referenceColor', reference_color,
    'onHand', on_hand,
    'reserved', reserved,
    'available', available_quantity,
    'unvaluedQuantity', unvalued_quantity,
    'averageUnitCost', average_unit_cost,
    'totalValue', total_value,
    'unitsInPeriod', unidades_periodo,
    'coverageDays', cobertura_dias,
    'needsReposition', motivo is not null,
    'reason', motivo
  ) order by
      -- Lo agotado primero, luego lo que menos dura, luego alfabético.
      case when motivo = 'agotado' then 0 when motivo = 'cobertura' then 1 else 2 end,
      cobertura_dias nulls last,
      product_name,
      shade_name nulls last
  ), '[]'::jsonb)
  into v_items
  from clasificadas
  where (not p_only_reposition or motivo is not null);

  return jsonb_build_object(
    'rango', jsonb_build_object('desde', v_from, 'hasta', v_to, 'dias', v_dias),
    'items', coalesce((select jsonb_agg(x) from (
      select x from jsonb_array_elements(v_items) x limit p_limit
    ) recortadas), '[]'::jsonb),
    'total', jsonb_array_length(v_items)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Quién mantiene cada proyección
-- ---------------------------------------------------------------------------
-- Todos por SENTENCIA con tablas de transición: una importación que toca 50 000
-- variantes reconstruye UNA vez con las 50 000, no 50 000 veces con una.
--
-- Y todos comparan viejo contra nuevo antes de hacer nada. Eso no es una
-- optimización: es lo que garantiza la separación. Si el disparador del precio
-- reaccionara a cualquier UPDATE de `product_variants`, escribir un documento
-- de búsqueda recalcularía precios — que es exactamente el defecto que estas
-- proyecciones vienen a corregir, una capa más abajo.

begin;

-- ---- variant_search_projection + product_catalog_projection.search_document ----

create or replace function public.trg_proj_search_from_variants_ins()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.refresh_variant_search_projection(array(select id from nuevas));
  perform public.refresh_variant_search_codes(array(select id from nuevas));
  perform public.refresh_product_catalog_search(array(select distinct product_id from nuevas));
  perform public.refresh_product_catalog_price(array(select distinct product_id from nuevas));
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_variants_upd()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_buscables uuid[];
  v_codigos uuid[];
  v_precio uuid[];
begin
  -- Cada conjunto se calcula por separado. Cambiar el nombre de una variante no
  -- puede recalcular su precio, y activarla no puede reescribir su documento
  -- salvo que también cambie algo buscable.
  select array(select n.id from nuevas n join viejas v on v.id = n.id
               where (n.name, n.sku, n.barcode, n.color_shade_id, n.product_id)
                  is distinct from (v.name, v.sku, v.barcode, v.color_shade_id, v.product_id))
    into v_buscables;

  select array(select n.id from nuevas n join viejas v on v.id = n.id
               where (n.sku, n.barcode) is distinct from (v.sku, v.barcode))
    into v_codigos;

  select array(select distinct n.product_id from nuevas n join viejas v on v.id = n.id
               where n.is_active is distinct from v.is_active)
    into v_precio;

  perform public.refresh_variant_search_projection(v_buscables);
  perform public.refresh_variant_search_codes(v_codigos);
  perform public.refresh_product_catalog_search(
    array(select distinct product_id from public.product_variants where id = any(v_buscables)));
  perform public.refresh_product_catalog_price(v_precio);
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_products()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_afectados uuid[];
begin
  select array(select n.id from nuevas n join viejas v on v.id = n.id
               where (n.code, n.name, n.presentation, n.product_type)
                  is distinct from (v.code, v.name, v.presentation, v.product_type))
    into v_afectados;

  perform public.refresh_variant_search_projection(
    array(select pv.id from public.product_variants pv where pv.product_id = any(v_afectados)));
  perform public.refresh_variant_search_codes(
    array(select pv.id from public.product_variants pv where pv.product_id = any(v_afectados)));
  perform public.refresh_product_catalog_search(v_afectados);
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_brands()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_variantes uuid[];
begin
  select array(select pv.id from public.product_variants pv
               join public.products p on p.id = pv.product_id
               join nuevas n on n.id = p.brand_id
               join viejas v on v.id = n.id
               where n.name is distinct from v.name)
    into v_variantes;

  perform public.refresh_variant_search_projection(v_variantes);
  perform public.refresh_product_catalog_search(
    array(select distinct pv.product_id from public.product_variants pv where pv.id = any(v_variantes)));
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_shades()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_variantes uuid[];
begin
  select array(select pv.id from public.product_variants pv
               join nuevas n on n.id = pv.color_shade_id
               join viejas v on v.id = n.id
               where (n.name, n.code) is distinct from (v.name, v.code))
    into v_variantes;

  perform public.refresh_variant_search_projection(v_variantes);
  perform public.refresh_variant_search_codes(v_variantes);
  perform public.refresh_product_catalog_search(
    array(select distinct pv.product_id from public.product_variants pv where pv.id = any(v_variantes)));
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_lines()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_variantes uuid[];
begin
  select array(select pv.id from public.product_variants pv
               join public.color_shades s on s.id = pv.color_shade_id
               join nuevas n on n.id = s.product_line_id
               join viejas v on v.id = n.id
               where n.name is distinct from v.name)
    into v_variantes;

  perform public.refresh_variant_search_projection(v_variantes);
  perform public.refresh_product_catalog_search(
    array(select distinct pv.product_id from public.product_variants pv where pv.id = any(v_variantes)));
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_values()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_variantes uuid[];
begin
  select array(select distinct variant_id from afectadas) into v_variantes;
  perform public.refresh_variant_search_projection(v_variantes);
  perform public.refresh_product_catalog_search(
    array(select distinct pv.product_id from public.product_variants pv where pv.id = any(v_variantes)));
  return null;
end;
$fn$;

create or replace function public.trg_proj_search_from_options()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_variantes uuid[];
begin
  select array(select distinct val.variant_id
               from public.variant_attribute_values val
               join nuevas n on n.id = val.option_id
               join viejas v on v.id = n.id
               where (n.value, n.label) is distinct from (v.value, v.label))
    into v_variantes;

  perform public.refresh_variant_search_projection(v_variantes);
  perform public.refresh_product_catalog_search(
    array(select distinct pv.product_id from public.product_variants pv where pv.id = any(v_variantes)));
  return null;
end;
$fn$;

-- ---- variant_search_codes desde los proveedores ----

create or replace function public.trg_proj_codes_from_suppliers()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.refresh_variant_search_codes(array(
    select distinct pv.id
    from public.product_variants pv
    join afectadas a
      on a.variant_id = pv.id
      or (a.variant_id is null and a.product_id = pv.product_id)));
  return null;
end;
$fn$;

-- ---- product_catalog_projection.starting_price, y SOLO eso ----

create or replace function public.trg_proj_price_from_prices()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.refresh_product_catalog_price(array(
    select distinct pv.product_id from public.product_variants pv
    join afectadas a on a.variant_id = pv.id));
  return null;
end;
$fn$;

revoke execute on function public.trg_proj_search_from_variants_ins() from public;
revoke execute on function public.trg_proj_search_from_variants_upd() from public;
revoke execute on function public.trg_proj_search_from_products() from public;
revoke execute on function public.trg_proj_search_from_brands() from public;
revoke execute on function public.trg_proj_search_from_shades() from public;
revoke execute on function public.trg_proj_search_from_lines() from public;
revoke execute on function public.trg_proj_search_from_values() from public;
revoke execute on function public.trg_proj_search_from_options() from public;
revoke execute on function public.trg_proj_codes_from_suppliers() from public;
revoke execute on function public.trg_proj_price_from_prices() from public;

drop trigger if exists product_variants_projections_ins on public.product_variants;
create trigger product_variants_projections_ins
after insert on public.product_variants
referencing new table as nuevas
for each statement execute function public.trg_proj_search_from_variants_ins();

drop trigger if exists product_variants_projections_upd on public.product_variants;
create trigger product_variants_projections_upd
after update on public.product_variants
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_variants_upd();

drop trigger if exists products_projections_upd on public.products;
create trigger products_projections_upd
after update on public.products
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_products();

drop trigger if exists brands_projections_upd on public.brands;
create trigger brands_projections_upd
after update on public.brands
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_brands();

drop trigger if exists color_shades_projections_upd on public.color_shades;
create trigger color_shades_projections_upd
after update on public.color_shades
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_shades();

drop trigger if exists product_lines_projections_upd on public.product_lines;
create trigger product_lines_projections_upd
after update on public.product_lines
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_lines();

drop trigger if exists variant_values_projections_ins on public.variant_attribute_values;
create trigger variant_values_projections_ins
after insert on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_proj_search_from_values();

drop trigger if exists variant_values_projections_upd on public.variant_attribute_values;
create trigger variant_values_projections_upd
after update on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_proj_search_from_values();

drop trigger if exists variant_values_projections_del on public.variant_attribute_values;
create trigger variant_values_projections_del
after delete on public.variant_attribute_values
referencing old table as afectadas
for each statement execute function public.trg_proj_search_from_values();

drop trigger if exists attribute_options_projections_upd on public.attribute_options;
create trigger attribute_options_projections_upd
after update on public.attribute_options
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_proj_search_from_options();

drop trigger if exists product_suppliers_projections_ins on public.product_suppliers;
create trigger product_suppliers_projections_ins
after insert on public.product_suppliers
referencing new table as afectadas
for each statement execute function public.trg_proj_codes_from_suppliers();

drop trigger if exists product_suppliers_projections_upd on public.product_suppliers;
create trigger product_suppliers_projections_upd
after update on public.product_suppliers
referencing new table as afectadas
for each statement execute function public.trg_proj_codes_from_suppliers();

drop trigger if exists product_suppliers_projections_del on public.product_suppliers;
create trigger product_suppliers_projections_del
after delete on public.product_suppliers
referencing old table as afectadas
for each statement execute function public.trg_proj_codes_from_suppliers();

drop trigger if exists variant_prices_projections_ins on public.variant_prices;
create trigger variant_prices_projections_ins
after insert on public.variant_prices
referencing new table as afectadas
for each statement execute function public.trg_proj_price_from_prices();

drop trigger if exists variant_prices_projections_upd on public.variant_prices;
create trigger variant_prices_projections_upd
after update on public.variant_prices
referencing new table as afectadas
for each statement execute function public.trg_proj_price_from_prices();

drop trigger if exists variant_prices_projections_del on public.variant_prices;
create trigger variant_prices_projections_del
after delete on public.variant_prices
referencing old table as afectadas
for each statement execute function public.trg_proj_price_from_prices();

commit;
