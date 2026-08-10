begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','e0000000-0000-4000-8000-000000000001','authenticated','authenticated','ret-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','e0000000-0000-4000-8000-000000000002','authenticated','authenticated','ret-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('e0000000-0000-4000-8000-000000000001','admin','Propietaria devoluciones'),
  ('e0000000-0000-4000-8000-000000000002','seller','Vendedora devoluciones');

-- Sede propia: las aserciones declaran existencias y valores absolutos, y
-- sobre la sede principal dependerían de lo que dejaran antes el seed de
-- demostración o cualquier otra prueba.
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'RETTEST', 'Sede de devoluciones de prueba', 'Lima', false, 937
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO') as v_costo,
  (select id from public.product_variants where sku = 'DEMO-ESM-NUDE') as v_libre,
  (select id from public.branches where code = 'RETTEST')              as b1,
  'e0000000-0000-4000-8000-000000000001'::uuid                         as admin_id,
  'e0000000-0000-4000-8000-000000000002'::uuid                         as seller_id;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, b1, true from fx;

set local request.jwt.claims = '{"sub":"e0000000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.product_variants set tracks_inventory = true where id = (select v_costo from fx);

-- Una venta completa a un precio conocido, para no depender de la tarifa.
create or replace function pg_temp.quick_sale(p_branch uuid, p_variant uuid, p_qty integer)
returns jsonb
language plpgsql
as $$
declare
  cart jsonb := jsonb_build_array(jsonb_build_object('variantId', p_variant, 'quantity', p_qty));
  amount numeric := (public.evaluate_cart_v2(cart) ->> 'subtotal')::numeric;
begin
  return public.register_sale(
    p_branch, cart,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', amount)),
    gen_random_uuid()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'sale_cancellations', '1 · Existe la anulación');
select has_table('public', 'returns', '2 · Existe la devolución');
select has_table('public', 'return_lines', '3 · Existen sus líneas');
select has_table('public', 'refunds', '4 · Existe el reembolso');

-- Los tres contratos escriben inventario y dinero: no pueden depender de que la
-- RLS del llamador les deje pasar.
select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('cancel_sale', 'register_return', 'cancel_reservation', 'restore_sold_units')
     and not prosecdef),
  0,
  '5 · Los contratos de anulación y devolución son SECURITY DEFINER'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('cancel_sale', 'register_return', 'cancel_reservation',
                       'restore_sold_units', 'sale_margin', 'return_detail')),
  false,
  '6 · Ninguno es alcanzable por anon'
);

select is(
  (select count(*)::integer
   from (values ('sale_cancellations'), ('returns'), ('return_lines'), ('refunds')) as required(t)
   where not exists (
     select 1 from pg_trigger tr
     where tr.tgrelid = ('public.' || required.t)::regclass
       and tr.tgname = 'audit_' || required.t and not tr.tgisinternal
   )),
  0,
  '7 · Las cuatro tablas quedan auditadas'
);

-- Origen excluyente entre TRES. La versión de dos columnas dejaba inconstruible
-- el reembolso del adelanto de una reserva cancelada.
select throws_ok(
  format($$ insert into public.refunds (branch_id, method, amount) values (%L::uuid, 'cash', 10.00) $$,
    (select b1 from fx)),
  '23514', null,
  '8 · Un reembolso sin origen se rechaza'
);

-- ---------------------------------------------------------------------------
-- Anulación (prueba crítica 6)
-- ---------------------------------------------------------------------------
-- Secuencia que distingue el costo CAPTURADO del promedio VIGENTE:
-- recibir 10 @ 10,00 · vender 10 · recibir 10 @ 30,00 · anular.

select public.apply_inventory_movement(v_costo, b1, 'receipt', 10, 10.00,
  'test', null, 'R1', 'fixture', admin_id) from fx;

create temporary table sale_a on commit drop as
select pg_temp.quick_sale((select b1 from fx), (select v_costo from fx), 10) as detail;

select public.apply_inventory_movement(v_costo, b1, 'receipt', 10, 30.00,
  'test', null, 'R2', 'fixture', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2) from public.inventory_valuation
     where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx) $$,
  $$ values (10, 300.00::numeric) $$,
  '9 · Antes de anular: 10 unidades valoradas en 300,00'
);

create temporary table cancellation_a on commit drop as
select public.cancel_sale(
  ((select detail ->> 'id' from sale_a))::uuid,
  'customer_regret'::public.cancellation_reason,
  'La clienta se arrepintió en el mostrador'
) as detail;

select is(
  (select status from public.sales where id = ((select detail ->> 'id' from sale_a))::uuid),
  'cancelled'::public.sale_status,
  '10 · La venta original sobrevive, marcada como anulada'
);

select is(
  (select count(*)::integer from public.sale_lines
   where sale_id = ((select detail ->> 'id' from sale_a))::uuid),
  1,
  '11 · Y conserva sus líneas: la anulación no borra nada'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  20,
  '12 · El stock vuelve completo'
);

-- Al promedio VIGENTE el saldo quedaría en 600,00 —200,00 inventados—; al costo
-- capturado queda en 400,00, que es lo realmente desembolsado.
select results_eq(
  $$ select quantity_valued, round(total_value, 2) from public.inventory_valuation
     where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx) $$,
  $$ values (20, 400.00::numeric) $$,
  '13 · La reposición usa el costo CAPTURADO, no el promedio de hoy'
);

-- cancel_sale devuelve el detalle de la VENTA, así que su `id` es el de la
-- venta y no el de la anulación: el reembolso se busca por la anulación de esa
-- venta, no por el identificador devuelto.
select is(
  (select sum(f.amount)
   from public.refunds f
   join public.sale_cancellations c on c.id = f.sale_cancellation_id
   where c.sale_id = ((select detail ->> 'id' from sale_a))::uuid),
  (select sum(p.amount) from public.sale_payments p
   where p.sale_id = ((select detail ->> 'id' from sale_a))::uuid),
  '14 · El dinero se registra devuelto por el importe exacto que se cobró'
);

select throws_ok(
  format($$ select public.cancel_sale(%L::uuid, 'other'::public.cancellation_reason, 'Segundo intento') $$,
    (select detail ->> 'id' from sale_a)),
  '23514', null,
  '15 · La segunda anulación se rechaza'
);

-- ---------------------------------------------------------------------------
-- Devolución (prueba crítica 7)
-- ---------------------------------------------------------------------------

create temporary table sale_b on commit drop as
select pg_temp.quick_sale((select b1 from fx), (select v_costo from fx), 7) as detail;

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  13,
  '16 · La segunda venta descuenta siete unidades'
);

-- Devolución parcial: 3 vendibles y 2 dañadas.
create temporary table return_b on commit drop as
select public.register_return(
  ((select detail ->> 'id' from sale_b))::uuid,
  jsonb_build_array(
    jsonb_build_object(
      'saleLineId', (select l.id from public.sale_lines l
                     where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1),
      'quantity', 3, 'condition', 'resellable')
  ),
  gen_random_uuid(),
  'Tono equivocado'
) as detail;

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  16,
  '17 · Lo vendible vuelve al stock'
);

create temporary table return_c on commit drop as
select public.register_return(
  ((select detail ->> 'id' from sale_b))::uuid,
  jsonb_build_array(
    jsonb_build_object(
      'saleLineId', (select l.id from public.sale_lines l
                     where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1),
      'quantity', 2, 'condition', 'damaged')
  ),
  gen_random_uuid(),
  'Llegó roto'
) as detail;

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  16,
  '18 · Lo dañado NO vuelve al stock vendible'
);

select is(
  (select count(*)::integer from public.return_lines where restocked and condition <> 'resellable'),
  0,
  '19 · Ninguna línea no vendible queda marcada como repuesta'
);

-- Reparto por diferencia acumulada: las dos devoluciones parciales más la que
-- falta deben sumar exactamente el subtotal cobrado de la línea, al céntimo.
create temporary table return_d on commit drop as
select public.register_return(
  ((select detail ->> 'id' from sale_b))::uuid,
  jsonb_build_array(
    jsonb_build_object(
      'saleLineId', (select l.id from public.sale_lines l
                     where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1),
      'quantity', 2, 'condition', 'resellable')
  ),
  gen_random_uuid(),
  'Resto'
) as detail;

select is(
  (select sum(rl.refund_amount) from public.return_lines rl
   join public.sale_lines l on l.id = rl.sale_line_id
   where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid),
  (select l.subtotal from public.sale_lines l
   where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1),
  '20 · Devolver todo reparte exactamente el subtotal cobrado, sin residuo'
);

select throws_ok(
  format($$ select public.register_return(%L::uuid,
      jsonb_build_array(jsonb_build_object('saleLineId', %L::uuid, 'quantity', 1, 'condition', 'resellable')),
      gen_random_uuid()) $$,
    (select detail ->> 'id' from sale_b),
    (select l.id from public.sale_lines l where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1)),
  '23514', null,
  '21 · No se devuelve más de lo vendido'
);

-- Idempotencia: el mismo identificador de operación devuelve la devolución ya
-- registrada en lugar de reponer dos veces.
select is(
  (select public.register_return(
     ((select detail ->> 'id' from sale_b))::uuid,
     jsonb_build_array(jsonb_build_object(
       'saleLineId', (select l.id from public.sale_lines l
                      where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1),
       'quantity', 1, 'condition', 'resellable')),
     (select r.client_operation_id from public.returns r
      where r.id = ((select detail ->> 'id' from return_b))::uuid)
   ) ->> 'id'),
  (select detail ->> 'id' from return_b),
  '22 · Reintentar una devolución devuelve la ya registrada'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  18,
  '23 · Y no repone ninguna unidad de más'
);

-- ---------------------------------------------------------------------------
-- Las dos direcciones prohibidas
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.cancel_sale(%L::uuid, 'other'::public.cancellation_reason, 'Anular lo ya devuelto') $$,
    (select detail ->> 'id' from sale_b)),
  '23514', null,
  '24 · Una venta con devoluciones no puede anularse'
);

select throws_ok(
  format($$ select public.register_return(%L::uuid,
      jsonb_build_array(jsonb_build_object('saleLineId', %L::uuid, 'quantity', 1, 'condition', 'resellable')),
      gen_random_uuid()) $$,
    (select detail ->> 'id' from sale_a),
    (select l.id from public.sale_lines l where l.sale_id = ((select detail ->> 'id' from sale_a))::uuid limit 1)),
  '23514', null,
  '25 · Y una venta anulada no admite devolución'
);

-- ---------------------------------------------------------------------------
-- Topes del dinero
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.register_return(%L::uuid,
      jsonb_build_array(jsonb_build_object('saleLineId', %L::uuid, 'quantity', 1, 'condition', 'resellable')),
      gen_random_uuid(), 'Reembolso excesivo',
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 9999.00))) $$,
    (select detail ->> 'id' from sale_b),
    (select l.id from public.sale_lines l where l.sale_id = ((select detail ->> 'id' from sale_b))::uuid limit 1)),
  '23514', null,
  '26 · El reembolso declarado no puede superar lo devuelto'
);

-- ---------------------------------------------------------------------------
-- Reserva cancelada: el adelanto no desaparece
-- ---------------------------------------------------------------------------

create temporary table res_a on commit drop as
select public.create_reservation(
  (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v_costo from fx), 'quantity', 2)),
  jsonb_build_object('name', 'Clienta que cancela'),
  now() + interval '3 days',
  gen_random_uuid(),
  -- Desde 0065 un adelanto por Yape lleva su número de operación, igual que un
  -- cobro: es el mismo dinero entrando por el mismo sitio.
  jsonb_build_object('method', 'yape', 'amount', 10.00, 'reference', '00445566')
) as detail;

select is(
  (select reserved from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  2,
  '27 · La reserva compromete dos unidades'
);

select is(
  public.cancel_reservation(((select detail ->> 'id' from res_a))::uuid,
                            'La clienta desistió', 'refund') ->> 'status',
  'cancelled',
  '28 · Cancelar la reserva la deja en estado cancelada'
);

select is(
  (select reserved from public.inventory_stock
   where variant_id = (select v_costo from fx) and branch_id = (select b1 from fx)),
  0,
  '29 · Y devuelve lo comprometido'
);

-- Origen que la versión de dos columnas dejaba inconstruible.
select is(
  (select sum(amount) from public.refunds
   where reservation_id = ((select detail ->> 'id' from res_a))::uuid),
  10.00::numeric,
  '30 · El adelanto se reembolsa con origen propio, ni venta ni devolución'
);

-- ---------------------------------------------------------------------------
-- El margen es información administrativa
-- ---------------------------------------------------------------------------

select is(
  (public.sale_margin(((select detail ->> 'id' from sale_a))::uuid) ->> 'restoredCost')::numeric,
  100.00::numeric,
  '31 · El margen resta el costo repuesto por la anulación, no el promedio de hoy'
);

grant select on fx, sale_a to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e0000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  format($$ select public.sale_margin(%L::uuid) $$, (select detail ->> 'id' from sale_a)),
  '42501', null,
  '32 · La vendedora no puede calcular márgenes'
);

reset role;

select * from finish();

rollback;
