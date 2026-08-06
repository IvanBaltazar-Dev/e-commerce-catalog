-- Bloque 2 · Cierre — las dos lecturas operativas que §7 declaraba y que la
-- implementación había dejado sin contrato.
--
-- `docs/bloque-2-modelo.md` §7 lista cinco lecturas. Tres existen ya:
-- `variant_availability` como `variant_effective_availability` (0028),
-- `sale_detail` (0029) y `supplier_balances_by_currency` como la vista
-- `supplier_balances` (0030). Faltaban estas dos, y no son cosméticas: sin
-- ellas el arqueo diario y el kardex consultable solo existían como texto.
--
-- DOS DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. EL ARQUEO SE DERIVA DE LOS DOCUMENTOS, NO DE LA SESIÓN DE CAJA.
--    `cash_movements` (0032) solo se escribe cuando hay caja abierta, y su
--    propio contrato dice —correctamente— que obligar a abrir caja para poder
--    vender rompería la operación. Un arqueo construido sobre esa tabla
--    reportaría cero en cualquier día en que nadie abrió caja, con el dinero
--    realmente cobrado. Se deriva de los documentos de dinero y se reconcilia
--    contra el cajón, que es la única forma de que el descuadre sea visible en
--    lugar de invisible.
--
-- B. EL ADELANTO SE CUENTA EL DÍA QUE ENTRÓ, UNA SOLA VEZ.
--    El efectivo del día sale de `reservation_payments` más `sale_payments` con
--    `method <> 'reservation_advance'`. Las filas de adelanto trasladado se
--    listan APARTE, por `applied_at`, como conciliación: son la misma plata que
--    ya se contó el día que la clienta la entregó. Sin ese filtro, un adelanto
--    de enero reaparece en el arqueo de febrero y la caja parece cuadrar dos
--    veces con el mismo billete.

begin;

-- ---------------------------------------------------------------------------
-- 1. Arqueo diario
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: es dinero de la sede, no costo. La vendedora arquea su
-- propia caja, y la RLS de cada tabla ya la recorta a sus sedes.

create or replace function public.daily_cash_summary(
  p_branch_id uuid,
  p_date date default current_date
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform public.assert_branch_access(p_branch_id, 'consultar el arqueo');

  with
  -- ENTRADAS. Cobros de venta por su fecha de recepción, excluyendo el adelanto
  -- trasladado: ese dinero entró el día de la reserva y ya se contó entonces.
  sale_income as (
    select p.method, sum(p.amount) as amount, count(*) as entries
    from public.sale_payments p
    join public.sales s on s.id = p.sale_id
    where s.branch_id = p_branch_id
      and p.method <> 'reservation_advance'
      and p.received_at >= p_date::timestamptz
      and p.received_at < (p_date + 1)::timestamptz
    group by p.method
  ),
  -- Adelantos recibidos hoy: entran al arqueo de hoy aunque la venta llegue
  -- meses después.
  advance_income as (
    select p.method, sum(p.amount) as amount, count(*) as entries
    from public.reservation_payments p
    join public.reservations r on r.id = p.reservation_id
    where r.branch_id = p_branch_id
      and p.received_at >= p_date::timestamptz
      and p.received_at < (p_date + 1)::timestamptz
    group by p.method
  ),
  income as (
    select method, sum(amount) as amount, sum(entries) as entries
    from (select * from sale_income union all select * from advance_income) all_income
    group by method
  ),
  -- SALIDAS. Reembolsos, gastos y pagos a proveedor. Sin el método, el arqueo no
  -- puede restar el efectivo que sale del cajón y el descuadre acabaría
  -- atribuido a quien atendió.
  refund_outflow as (
    select f.method, sum(f.amount) as amount, count(*) as entries
    from public.refunds f
    where f.branch_id = p_branch_id
      and f.paid_at >= p_date::timestamptz
      and f.paid_at < (p_date + 1)::timestamptz
    group by f.method
  ),
  expense_outflow as (
    select e.method, sum(e.amount) as amount, count(*) as entries
    from public.expenses e
    where e.branch_id = p_branch_id
      and e.voided_at is null
      and e.incurred_at = p_date
    group by e.method
  ),
  supplier_outflow as (
    select p.method, sum(p.amount) as amount, count(*) as entries
    from public.supplier_payments p
    where p.branch_id = p_branch_id
      and p.paid_at >= p_date::timestamptz
      and p.paid_at < (p_date + 1)::timestamptz
    group by p.method
  ),
  outflow as (
    select method, sum(amount) as amount, sum(entries) as entries
    from (
      select * from refund_outflow
      union all select * from expense_outflow
      union all select * from supplier_outflow
    ) all_outflow
    group by method
  ),
  -- CONCILIACIÓN. El adelanto aplicado hoy a una venta no es dinero nuevo.
  applied_advances as (
    select coalesce(sum(p.amount), 0) as amount, count(*) as entries
    from public.sale_payments p
    join public.sales s on s.id = p.sale_id
    where s.branch_id = p_branch_id
      and p.method = 'reservation_advance'
      and p.applied_at >= p_date::timestamptz
      and p.applied_at < (p_date + 1)::timestamptz
  ),
  -- El cajón, cuando alguien lo abrió. Su ausencia no invalida el arqueo.
  drawer as (
    select
      coalesce(sum(m.amount) filter (where m.method = 'cash'), 0) as cash_in_drawer,
      count(distinct m.cash_session_id) as sessions
    from public.cash_movements m
    where m.branch_id = p_branch_id
      and m.occurred_at >= p_date::timestamptz
      and m.occurred_at < (p_date + 1)::timestamptz
  )
  select jsonb_build_object(
    'branchId', p_branch_id,
    'date', p_date,
    'income', coalesce((
      select jsonb_object_agg(method, jsonb_build_object('amount', amount, 'entries', entries))
      from income
    ), '{}'::jsonb),
    'outflow', coalesce((
      select jsonb_object_agg(method, jsonb_build_object('amount', amount, 'entries', entries))
      from outflow
    ), '{}'::jsonb),
    'incomeTotal', coalesce((select sum(amount) from income), 0),
    'outflowTotal', coalesce((select sum(amount) from outflow), 0),
    'net', coalesce((select sum(amount) from income), 0) - coalesce((select sum(amount) from outflow), 0),
    'cashIncome', coalesce((select amount from income where method = 'cash'), 0),
    'cashOutflow', coalesce((select amount from outflow where method = 'cash'), 0),
    'cashNet', coalesce((select amount from income where method = 'cash'), 0)
                 - coalesce((select amount from outflow where method = 'cash'), 0),
    -- Listado APARTE, nunca sumado: es la misma plata contada el día que entró.
    'appliedAdvances', (select jsonb_build_object('amount', amount, 'entries', entries) from applied_advances),
    'drawer', (select jsonb_build_object('cashInDrawer', cash_in_drawer, 'sessions', sessions) from drawer)
  ) into result;

  return result;
end;
$$;

comment on function public.daily_cash_summary(uuid, date) is
  'Arqueo del día por sede y método. Suma por la fecha en que ENTRÓ el dinero y '
  'lista los adelantos trasladados aparte para no contarlos dos veces.';

-- ---------------------------------------------------------------------------
-- 2. Kardex consultable
-- ---------------------------------------------------------------------------
-- El orden autoritativo es `id`, no `occurred_at`: con el candado retenido
-- durante todo un RPC, `now()` da el mismo instante a varios asientos y el
-- kardex leído por fecha muestra saldos fuera de secuencia. occurred_at es
-- informativo; la secuencia manda.
--
-- El bloque monetario se recorta por rol de forma explícita, no solo por la RLS
-- de la tabla: inventory_movements es legible por el personal de la sede —lo
-- necesita para entender su propio stock— y sus columnas de costo no.

create or replace function public.inventory_ledger(
  p_variant_id uuid,
  p_branch_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  reveal_cost boolean := public.is_admin();
begin
  perform public.assert_branch_access(p_branch_id, 'consultar el kardex');

  select jsonb_build_object(
    'variantId', p_variant_id,
    'branchId', p_branch_id,
    'sku', (select v.sku from public.product_variants v where v.id = p_variant_id),
    'onHand', coalesce((
      select s.on_hand from public.inventory_stock s
      where s.variant_id = p_variant_id and s.branch_id = p_branch_id
    ), 0),
    'reserved', coalesce((
      select s.reserved from public.inventory_stock s
      where s.variant_id = p_variant_id and s.branch_id = p_branch_id
    ), 0),
    'entries', coalesce((
      select jsonb_agg(entry order by entry_id)
      from (
        select
          m.id as entry_id,
          jsonb_build_object(
            'id', m.id,
            'movementType', m.movement_type,
            'quantity', m.quantity,
            'balanceAfter', m.balance_after,
            'sourceType', m.source_type,
            'sourceId', m.source_id,
            'sourceLabel', m.source_label,
            'actorLabel', m.actor_label,
            'reason', m.reason,
            'occurredAt', m.occurred_at,
            'cost', case when reveal_cost then jsonb_build_object(
              'unitCost', m.unit_cost,
              'valueDelta', m.value_delta,
              'valueAfter', m.value_after,
              'costBasis', m.cost_basis,
              'valuedUnits', m.valued_units,
              'unvaluedUnits', m.unvalued_units
            ) end
          ) as entry
        from public.inventory_movements m
        where m.variant_id = p_variant_id
          and m.branch_id = p_branch_id
          and (p_from is null or m.occurred_at >= p_from)
          and (p_to is null or m.occurred_at < p_to)
        order by m.id desc
        limit least(coalesce(p_limit, 200), 1000)
      ) page
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

comment on function public.inventory_ledger(uuid, uuid, timestamptz, timestamptz, integer) is
  'Kardex de una variante en una sede, ordenado por la identidad monótona del '
  'asiento. occurred_at es informativo: la secuencia es la autoridad.';

-- ---------------------------------------------------------------------------
-- 3. El kardex deja de publicar sus columnas monetarias
-- ---------------------------------------------------------------------------
-- HUECO REAL, comprobado: `0028` concede `select` de tabla completa sobre
-- inventory_movements al personal de la sede —lo necesita para entender su
-- propio stock— y esa tabla lleva unit_cost, value_delta y value_after. Una
-- vendedora podía leer el costo de cada asiento con una sola consulta a
-- PostgREST, justo lo que §8 declara en cero filas para ella.
--
-- La RLS no recorta columnas y un GRANT por columna no distingue a la
-- administradora de la vendedora —las dos son `authenticated`—. La única forma
-- correcta es cerrar las columnas a la tabla y servirlas por un objeto DEFINER
-- que sí sabe quién pregunta: `inventory_ledger`.

revoke select on public.inventory_movements from authenticated;

grant select (
  id, variant_id, branch_id, variant_sku, variant_label, branch_label,
  movement_type, quantity, balance_after,
  source_type, source_id, source_label,
  actor_id, actor_label, reason, occurred_at
) on public.inventory_movements to authenticated;

comment on column public.inventory_movements.unit_cost is
  'Costo del asiento. NO legible por `authenticated` desde la tabla: se sirve '
  'por inventory_ledger(), que lo recorta a administración.';

-- ---------------------------------------------------------------------------
-- 4. Privilegios
-- ---------------------------------------------------------------------------

revoke all on function public.daily_cash_summary(uuid, date) from public, anon;
revoke all on function public.inventory_ledger(uuid, uuid, timestamptz, timestamptz, integer) from public, anon;

grant execute on function public.daily_cash_summary(uuid, date) to authenticated, service_role;
grant execute on function public.inventory_ledger(uuid, uuid, timestamptz, timestamptz, integer)
to authenticated, service_role;

commit;
