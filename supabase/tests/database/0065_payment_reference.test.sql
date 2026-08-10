begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- La regla es una sola desde 0065: `payment_requires_reference`. Lo que aquí se
-- fija es su contenido —qué medios sí y cuáles no— y que las DOS tablas por las
-- que entra dinero la apliquen igual.
--
-- El agujero que cerró 0065: `reservation_payments` no la tenía. Un adelanto por
-- Yape sin código es dinero que entró y no se puede rastrear, exactamente lo que
-- 0057 vino a impedir para los cobros.

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'REFUNICA', 'Sede del número de operación', 'Lima', false, 952
from public.companies c limit 1;

create temporary table fx on commit drop as
select (select id from public.branches where code = 'REFUNICA') as branch_id,
       (select id from public.product_variants where is_active order by created_at limit 1) as variant_id;

-- ---------------------------------------------------------------------------
-- Qué dice la regla
-- ---------------------------------------------------------------------------
select ok(public.payment_requires_reference('yape'), '1 · Yape exige número de operación');
select ok(public.payment_requires_reference('plin'), '2 · Plin también');
select ok(public.payment_requires_reference('transfer'), '3 · la transferencia también');
select ok(public.payment_requires_reference('card'), '4 · la tarjeta también');

-- El efectivo no lleva porque no existe; `store_credit` y `other` quedan libres
-- porque exigir un código inexistente empuja a inventarlo.
select ok(not public.payment_requires_reference('cash'), '5 · el efectivo no: no tiene número que dar');
select ok(
  not public.payment_requires_reference('reservation_advance'),
  '6 · el adelanto trasladado tampoco: arrastra el código del pago original'
);

-- ---------------------------------------------------------------------------
-- Las DOS tablas por las que entra dinero la aplican
-- ---------------------------------------------------------------------------
create temporary table venta on commit drop as select gen_random_uuid() as id;
insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                          gross_subtotal, discount_total, total)
select venta.id, fx.branch_id, 'NV-RU-001', 'in_store', gen_random_uuid(), 0, 0, 0 from venta, fx;

select throws_ok(
  $$ insert into public.sale_payments (sale_id, method, amount)
     select id, 'yape', 10 from venta $$,
  '23514',
  null,
  '7 · un cobro por Yape sin código no entra'
);

create temporary table reserva on commit drop as select gen_random_uuid() as id;
insert into public.reservations (id, branch_id, reservation_number, customer_name,
                                 expires_at, total, client_operation_id)
select reserva.id, fx.branch_id, 'RS-RU-001', 'Rosa Díaz',
       now() + interval '2 days', 50, gen_random_uuid()
from reserva, fx;

-- Este es el que faltaba: hasta 0065 esta fila entraba sin problema.
select throws_ok(
  $$ insert into public.reservation_payments (reservation_id, method, amount)
     select id, 'yape', 10 from reserva $$,
  '23514',
  null,
  '8 · y un ADELANTO por Yape sin código tampoco: era el hueco de la regla'
);

select lives_ok(
  $$ insert into public.reservation_payments (reservation_id, method, amount, reference)
     select id, 'yape', 10, '00887766' from reserva $$,
  '9 · con su código, el adelanto entra'
);

select * from finish();

rollback;
