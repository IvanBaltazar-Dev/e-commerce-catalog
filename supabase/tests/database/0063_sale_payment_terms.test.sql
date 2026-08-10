begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Contra entrega es como se vende a provincia: la clienta adelanta por Yape, el
-- paquete se despacha —y el inventario baja— y el saldo llega días después,
-- cuando lo recibe. Lo que se comprueba aquí es que ese hueco entre mercadería y
-- dinero sea legítimo Y acotado: sin adelanto no vale, cobrar de más nunca vale,
-- y en mostrador no existe.
--
-- Y de paso, la reserva enlazada a su clienta (0062), porque la venta que nace
-- de ella tiene que heredarla sin que nadie se acuerde de pasarla.

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CONTRAE', 'Sede de contra entrega', 'Lima', false, 950
from public.companies c limit 1;

create temporary table fx on commit drop as
select (select id from public.branches where code = 'CONTRAE') as branch_id,
       (select id from public.product_variants where is_active order by created_at limit 1) as variant_id;

insert into public.persons (id, full_name, phone_normalized) values
  ('fc000000-0000-4000-8000-0000000000a1','Rosa Díaz','900000631');

-- La venta lleva su línea porque `assert_sale_discount_matches_lines` exige que
-- el bruto declarado sea la suma de lo vendido: sin ella, la venta no cuadra por
-- un motivo que no tiene nada que ver con lo que esta prueba mira.
create or replace function pg_temp.nueva_venta(p_metodo text, p_terms text, p_total numeric)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                            gross_subtotal, discount_total, total, payment_terms,
                            customer_name, customer_phone, customer_document, delivery_address)
  select v_id, fx.branch_id, 'NV-CE-' || left(v_id::text, 6),
         p_metodo::public.fulfillment_method, gen_random_uuid(),
         p_total, 0, p_total, p_terms::public.sale_payment_terms,
         'Rosa Díaz', '900000631', '45678912', 'Av. El Sol 890, Cusco'
  from fx;

  insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name,
                                 quantity, unit_price, discount_amount, subtotal,
                                 purchase_mode, line_order)
  select v_id, fx.variant_id, 'CE-1', 'Producto de prueba', 'Único',
         1, p_total, 0, p_total, 'retail', 0
  from fx;
  -- La entrega no es lo que se prueba aquí, pero 0061 la exige: se declara que
  -- recibe la propia clienta y se sigue con lo que sí importa, el dinero.
  insert into public.sale_parties (sale_id, role, is_buyer)
  values (v_id, (case when p_metodo = 'pickup' then 'pickup_authorized' else 'recipient' end)::public.sale_party_role, true);
  return v_id;
end;
$$;

select has_column('public','sales','payment_terms','la venta dice cuándo se cobra, no solo cuánto');
select has_column('public','reservations','person_id','la reserva guarda a quién se le reservó');

-- ---------------------------------------------------------------------------
-- Qué métodos la admiten — es un dato, no una convención
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select method::text from public.fulfillment_requirements
     where allows_on_delivery order by method::text $$,
  $$ values ('local_delivery'), ('shipping') $$,
  '1 · solo delivery y envío admiten contra entrega: en mostrador la clienta está delante'
);

-- ---------------------------------------------------------------------------
-- Lo que NO vale
-- ---------------------------------------------------------------------------
create temporary table v1 on commit drop as select pg_temp.nueva_venta('in_store', 'on_delivery', 50) as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'El pago contra entrega solo existe cuando hay algo que entregar: en mostrador y en recojo se cobra completo.',
  '2 · contra entrega en el mostrador no existe'
);
set constraints all deferred;
delete from public.sales where id = (select id from v1);

create temporary table v2 on commit drop as select pg_temp.nueva_venta('shipping', 'on_delivery', 50) as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Un pedido contra entrega necesita un adelanto: sin él no es contra entrega, es fiado.',
  '3 · sin adelanto no es contra entrega, es fiado'
);
set constraints all deferred;

-- Cobrar de más no vale nunca, con las condiciones que sean.
insert into public.sale_payments (sale_id, method, amount, reference)
select id, 'yape', 60, '00990011' from v2;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Los pagos suman 60.00 y el total de la venta es 50.00: lo que sobra no es vuelto.',
  '4 · cobrar más que el total no es vuelto, ni adelanto, ni saldo a favor'
);
set constraints all deferred;
delete from public.sales where id = (select id from v2);

-- Y la venta de siempre sigue teniendo que cuadrar al céntimo.
create temporary table v3 on commit drop as select pg_temp.nueva_venta('in_store', 'immediate', 50) as id;
insert into public.sale_payments (sale_id, method, amount) select id, 'cash', 30 from v3;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Los pagos aplicados suman 30.00 y el total de la venta es 50.00.',
  '5 · una venta normal a medio pagar sigue sin poder registrarse'
);
set constraints all deferred;
delete from public.sales where id = (select id from v3);

-- ---------------------------------------------------------------------------
-- Lo que SÍ: mercadería fuera, dinero a medias, y eso es correcto
-- ---------------------------------------------------------------------------
create temporary table v6 on commit drop as select pg_temp.nueva_venta('shipping', 'on_delivery', 50) as id;
insert into public.sale_payments (sale_id, method, amount, reference)
select id, 'yape', 10, '00887766' from v6;
select lives_ok(
  'set constraints all immediate',
  '6 · un envío despachado con adelanto de 10 sobre 50 es una venta válida'
);
set constraints all deferred;

select is(
  (select (public.sale_detail(id) ->> 'balance')::numeric from v6),
  40::numeric,
  '7 · el saldo se deriva de los pagos: no hay columna que pueda desfasarse'
);

-- ---------------------------------------------------------------------------
-- Cobrar el saldo
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',5)), gen_random_uuid()) $$,
         (select id from v6)),
  '23514',
  'El saldo pendiente es 40.00 y lo que se está cobrando suma 5.00.',
  '8 · cobrar un saldo que no cuadra no pasa'
);

create temporary table cobro on commit drop as
select public.settle_sale_balance(
  (select id from v6),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 40)),
  gen_random_uuid()
) as detalle;

select is(
  (select (detalle ->> 'balance')::numeric from cobro), 0::numeric,
  '9 · cobrado el saldo, la venta no debe nada'
);

-- Las condiciones NO se sobrescriben: cómo se vendió es un hecho, y borrarlo
-- dejaría sin respuesta la pregunta de cuánto se vende contra entrega.
select is(
  (select detalle ->> 'paymentTerms' from cobro), 'on_delivery',
  '10 · la venta sigue diciendo que se vendió contra entrega'
);

select throws_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',40)), gen_random_uuid()) $$,
         (select id from v6)),
  '23514',
  'Esta venta ya está cobrada por completo.',
  '11 · no se puede cobrar dos veces el mismo saldo'
);

-- ---------------------------------------------------------------------------
-- La reserva y su clienta (0062)
-- ---------------------------------------------------------------------------
-- La venta que nace de una reserva hereda su clienta sin que el llamador tenga
-- que acordarse: que no pueda olvidarlo es la garantía, no que se acuerde.
create temporary table res on commit drop as
select gen_random_uuid() as id;

insert into public.reservations (id, branch_id, reservation_number, customer_name,
                                 expires_at, total, client_operation_id, person_id)
select res.id, fx.branch_id, 'RS-CE-001', 'Rosa Díaz',
       now() + interval '2 days', 50, gen_random_uuid(),
       'fc000000-0000-4000-8000-0000000000a1'
from res, fx;

create temporary table v12 on commit drop as
select gen_random_uuid() as id;

insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                          gross_subtotal, discount_total, total, reservation_id)
select v12.id, fx.branch_id, 'NV-CE-HER', 'in_store', gen_random_uuid(), 0, 0, 0, res.id
from v12, fx, res;

select is(
  (select person_id from public.sales where id = (select id from v12)),
  'fc000000-0000-4000-8000-0000000000a1'::uuid,
  '12 · la venta hereda la clienta de su reserva sin que nadie la pase a mano'
);

select * from finish();

rollback;
