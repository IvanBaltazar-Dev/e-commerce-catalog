begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Lo que se comprueba aquí son las TRES dimensiones separadas de verdad —vale,
-- dónde está, cuánto se cobró— y que la política del adelanto salga entera del
-- dato, sin ningún umbral escondido en el código.
--
-- Las combinaciones que faltaban tras 0063 y que Ivan pidió cerrar: adelanto
-- repartido en dos medios, saldo con un medio distinto, cobrar sobre una venta
-- anulada, devolver una venta a medio cobrar, entregar sin cobrar y cobrar sin
-- entregar.

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'TRESDIM', 'Sede de las tres dimensiones', 'Lima', false, 951
from public.companies c limit 1;

create temporary table fx on commit drop as
select (select id from public.branches where code = 'TRESDIM') as branch_id,
       (select id from public.product_variants where is_active order by created_at limit 1) as variant_id;

create or replace function pg_temp.venta_con_saldo(p_metodo text, p_total numeric, p_adelanto numeric)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                            gross_subtotal, discount_total, total, payment_terms,
                            customer_name, customer_phone, customer_document, delivery_address)
  select v_id, fx.branch_id, 'NV-3D-' || left(v_id::text, 6),
         p_metodo::public.fulfillment_method, gen_random_uuid(),
         p_total, 0, p_total, 'on_delivery',
         'Rosa Díaz', '900000651', '45678912', 'Av. El Sol 890, Cusco'
  from fx;

  insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name,
                                 quantity, unit_price, discount_amount, subtotal, purchase_mode, line_order)
  select v_id, fx.variant_id, '3D-1', 'Producto de prueba', 'Único',
         1, p_total, 0, p_total, 'retail', 0
  from fx;

  insert into public.sale_parties (sale_id, role, is_buyer) values (v_id, 'recipient', true);

  if p_adelanto > 0 then
    insert into public.sale_payments (sale_id, method, amount, reference)
    values (v_id, 'yape', p_adelanto, '00887766');
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- La política del adelanto sale ENTERA del dato
-- ---------------------------------------------------------------------------
select is(
  (select min_advance_percent from public.fulfillment_requirements where method = 'shipping'),
  null,
  '1 · el porcentaje mínimo es NULL: «no se fija cuánto», que no es cero'
);

-- NULL con requires_advance = true significa «algo, y la dueña no dice cuánto».
create temporary table v2 on commit drop as select pg_temp.venta_con_saldo('shipping', 50, 0) as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Un pedido contra entrega necesita un adelanto: sin él no es contra entrega, es fiado.',
  '2 · exige adelanto sin fijar porcentaje: cero no basta'
);
set constraints all deferred;
delete from public.sales where id = (select id from v2);

-- Y si la dueña decide que no hace falta adelanto, deja de hacer falta. Sin
-- tocar código: es la misma función leyendo otra fila.
update public.fulfillment_requirements set requires_advance = false where method = 'shipping';
create temporary table v3 on commit drop as select pg_temp.venta_con_saldo('shipping', 50, 0) as id;
select lives_ok(
  'set constraints all immediate',
  '3 · con requires_advance = false, un pedido sin adelanto pasa'
);
set constraints all deferred;
delete from public.sales where id = (select id from v3);
update public.fulfillment_requirements set requires_advance = true where method = 'shipping';

-- Y si fija un 30 %, el umbral es ese y el mensaje lo dice.
update public.fulfillment_requirements set min_advance_percent = 30 where method = 'shipping';
create temporary table v4 on commit drop as select pg_temp.venta_con_saldo('shipping', 50, 10) as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'El adelanto es de 10.00 y para este método hay que adelantar al menos 15.00 (30.00 % del total).',
  '4 · con un 30 % fijado, 10 sobre 50 no alcanza y el aviso dice cuánto falta'
);
set constraints all deferred;
delete from public.sales where id = (select id from v4);
update public.fulfillment_requirements set min_advance_percent = null where method = 'shipping';

-- ---------------------------------------------------------------------------
-- Adelanto repartido, saldo con otro medio
-- ---------------------------------------------------------------------------
create temporary table v5 on commit drop as select pg_temp.venta_con_saldo('shipping', 50, 10) as id;
insert into public.sale_payments (sale_id, method, amount, reference)
select id, 'plin', 5, '00990022' from v5;
select lives_ok(
  'set constraints all immediate',
  '5 · el adelanto puede venir en dos medios: 10 por Yape y 5 por Plin'
);
set constraints all deferred;

create temporary table cobro5 on commit drop as
select public.settle_sale_balance(
  (select id from v5),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 35)),
  gen_random_uuid()
) as detalle;

select is(
  (select (detalle ->> 'balance')::numeric from cobro5), 0::numeric,
  '6 · y el saldo se cobra en efectivo, que no es el medio del adelanto'
);

select is(
  (select jsonb_array_length(detalle -> 'payments') from cobro5), 3,
  '7 · la venta conserva sus tres cobros, cada uno con su medio y su fecha'
);

-- ---------------------------------------------------------------------------
-- Las tres dimensiones no se tocan entre sí
-- ---------------------------------------------------------------------------
select is(
  (select fulfillment_status::text from public.sales where id = (select id from v5)),
  'pending',
  '8 · cobrada por completo y todavía sin entregar: cobrar no entrega'
);

-- Entregar sin haber cobrado tampoco es un error.
create temporary table v9 on commit drop as select pg_temp.venta_con_saldo('local_delivery', 50, 10) as id;
set constraints all immediate;
set constraints all deferred;
select is(
  (select public.mark_sale_fulfillment(id, 'delivered') ->> 'balance' from v9),
  '40.00',
  '9 · entregada y debiendo 40: entregar no cobra'
);

-- Una venta de mostrador nace entregada: la clienta se lleva su bolsa.
create temporary table v10 on commit drop as select gen_random_uuid() as id;
insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                          gross_subtotal, discount_total, total)
select v10.id, fx.branch_id, 'NV-3D-MOS', 'in_store', gen_random_uuid(), 0, 0, 0 from v10, fx;
select is(
  (select fulfillment_status::text from public.sales where id = (select id from v10)),
  'delivered',
  '10 · en el mostrador la venta nace entregada, sin que nadie lo marque'
);

-- Un pedido no vuelve atrás en su entrega.
select throws_ok(
  format($$ select public.mark_sale_fulfillment(%L::uuid, 'ready') $$, (select id from v9)),
  '23514',
  'Este pedido ya se entregó. Si volvió, lo que corresponde es una devolución.',
  '11 · lo entregado no se desentrega: para eso está la devolución'
);

create temporary table v12 on commit drop as select pg_temp.venta_con_saldo('shipping', 50, 10) as id;
select is(
  (select public.mark_sale_fulfillment(id, 'dispatched') ->> 'fulfillmentStatus' from v12),
  'dispatched',
  '12 · se puede saltar «preparado» e ir directo a despachado'
);

select throws_ok(
  format($$ select public.mark_sale_fulfillment(%L::uuid, 'pending') $$, (select id from v12)),
  '23514',
  'Un pedido no vuelve atrás en su entrega: corrige lo que esté mal y avanza.',
  '13 · pero no se puede retroceder'
);

-- ---------------------------------------------------------------------------
-- Anulada: el saldo se resuelve devolviendo, no cobrando
-- ---------------------------------------------------------------------------
update public.sales set status = 'cancelled' where id = (select id from v12);

select throws_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',40)), gen_random_uuid()) $$,
         (select id from v12)),
  '23514',
  'Esta venta está anulada: su saldo se resuelve por devolución, no cobrando.',
  '14 · sobre una venta anulada no se cobra saldo'
);

select throws_ok(
  format($$ select public.mark_sale_fulfillment(%L::uuid, 'delivered') $$, (select id from v12)),
  '23514',
  'Esta venta está anulada: ya no hay nada que entregar.',
  '15 · ni se entrega'
);

-- ---------------------------------------------------------------------------
-- Pendientes: una sola lectura, con el saldo ya resuelto
-- ---------------------------------------------------------------------------
-- v5 está cobrada y sin entregar; v9 entregada y debiendo. Las dos son
-- pendientes, por motivos distintos, y la misma consulta las devuelve.
select is(
  (select count(*)::int
   from jsonb_array_elements(public.pending_operations() -> 'sales') p
   where (p ->> 'id')::uuid in (select id from v5 union all select id from v9)),
  2,
  '16 · pendientes reúne lo que falta entregar y lo que falta cobrar en una lectura'
);

select * from finish();

rollback;
