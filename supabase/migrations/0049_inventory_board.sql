-- ---------------------------------------------------------------------------
-- 0049 — inventory_board: existencias y reposición desde una sola definición
--
-- D1 (Inventario) y D2 (Reposición) son el mismo circuito: se vendió, bajó el
-- stock, se está agotando, hay que reponer. Por eso comparten función y no
-- cálculo: si Reposición decidiera por su cuenta qué está por agotarse, y el
-- Inicio lo decidiera por la suya, la dueña vería dos números distintos para
-- la misma pregunta.
--
-- Ninguna cantidad se calcula aquí. Todas salen de `inventory_position`, que
-- es la fuente de inventario que ya existía, y cada una es explicable por sus
-- movimientos: `inventory_movements.balance_after` deja el rastro completo y
-- `inventory_ledger` lo sirve como kardex.
--
-- Lo único que esta función AÑADE es la señal de reposición, y la añade con su
-- razón en texto, porque «hay que reponer» sin el porqué no es información
-- accionable:
--
--   agotado        available_quantity <= 0. Indiscutible.
--   cobertura      hay ventas en el periodo y el stock dura menos de 7 días.
--   sin_señal      no hay ventas en el periodo: la cobertura NO es calculable
--                  y se dice, en vez de inventar un umbral.
--
-- No se usa un mínimo fijo tipo «5 unidades» a propósito. No existe punto de
-- reposición configurable en el modelo, y un número inventado trata igual a un
-- esmalte que vende 40 al día y a un torno que vende uno al año.
--
-- SECURITY INVOKER deliberado: `inventory_position` ya recorta por sede con
-- RLS, y aquí las filas están acotadas por las existencias de la sede, no por
-- el catálogo entero. No hay medio millón de comprobaciones que ahorrar como
-- en 0046, así que no hace falta DEFINER ni revalidar a mano.
-- ---------------------------------------------------------------------------

create or replace function public.inventory_board(
  p_branch_id uuid default null,
  p_query text default null,
  p_from date default null,
  p_to date default null,
  p_only_reposition boolean default false,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
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
    else '%' || lower(btrim(p_query)) || '%'
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
        or lower(p.name) like v_pattern
        or lower(coalesce(v.sku, '')) like v_pattern
        or lower(v.name) like v_pattern
        or lower(b.name) like v_pattern
        or lower(coalesce(cs.name, '')) like v_pattern
        or lower(coalesce(cs.code, '')) like v_pattern
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
$$;

comment on function public.inventory_board(uuid, text, date, date, boolean, integer) is
  'Existencias por variante y señal de reposición con su razón (D1+D2). Las cantidades salen de inventory_position; la cobertura, de las ventas confirmadas del periodo.';

revoke all on function public.inventory_board(uuid, text, date, date, boolean, integer) from public;
grant execute on function public.inventory_board(uuid, text, date, date, boolean, integer) to authenticated;
