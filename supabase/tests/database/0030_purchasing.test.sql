begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f0000000-0000-4000-8000-000000000001','authenticated','authenticated','buy-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f0000000-0000-4000-8000-000000000002','authenticated','authenticated','buy-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('f0000000-0000-4000-8000-000000000001','admin','Propietaria compras'),
  ('f0000000-0000-4000-8000-000000000002','seller','Vendedora sin compras');

insert into public.suppliers (company_id, code, legal_name, trade_name, default_currency, payment_terms_days)
select c.id, 'BUYTEST1', 'Proveedor de prueba SAC', 'Prueba PEN', 'PEN', 30 from public.companies c limit 1;

insert into public.suppliers (company_id, code, legal_name, trade_name, default_currency, payment_terms_days)
select c.id, 'BUYTEST2', 'Importadora de prueba', 'Prueba USD', 'USD', 0 from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO')  as v1,
  (select id from public.product_variants where sku = 'DEMO-ESM-NUDE')  as v2,
  (select id from public.branches where is_default and is_active)       as b1,
  (select id from public.suppliers where code = 'BUYTEST1')             as s_pen,
  (select id from public.suppliers where code = 'BUYTEST2')             as s_usd,
  'f0000000-0000-4000-8000-000000000001'::uuid                          as admin_id,
  'f0000000-0000-4000-8000-000000000002'::uuid                          as seller_id;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, b1, true from fx;

set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.product_variants set tracks_inventory = true where id in (select v1 from fx);

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'purchase_orders', '1 · Existe la orden de compra');
select has_table('public', 'purchase_order_lines', '2 · Existen sus líneas');
select has_table('public', 'goods_receipts', '3 · Existe la recepción');
select has_table('public', 'goods_receipt_lines', '4 · Existen sus líneas');
select has_table('public', 'supplier_obligations', '5 · Existen las obligaciones');
select has_table('public', 'supplier_payments', '6 · Existen los pagos a proveedor');
select has_table('public', 'supplier_payment_allocations', '7 · Existen las asignaciones');

-- Los tres contratos escriben inventario: desde 0029 el punto único de escritura
-- no es alcanzable por `authenticated`, así que sin DEFINER una recepción aborta
-- con «permission denied for function apply_inventory_movement».
select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('issue_purchase_order', 'register_goods_receipt', 'register_supplier_payment')
     and not prosecdef),
  0,
  '8 · Los contratos de compras son SECURITY DEFINER'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('issue_purchase_order', 'register_goods_receipt', 'register_supplier_payment',
                       'purchase_order_detail', 'goods_receipt_detail', 'supplier_payment_detail')),
  false,
  '9 · Ninguno es alcanzable por anon'
);

select is(
  (select count(*)::integer
   from (values ('purchase_orders'), ('purchase_order_lines'), ('supplier_documents'),
                ('goods_receipts'), ('goods_receipt_lines'), ('supplier_obligations'),
                ('supplier_payments'), ('supplier_payment_allocations')) as required(t)
   where not exists (
     select 1 from pg_trigger tr
     where tr.tgrelid = ('public.' || required.t)::regclass
       and tr.tgname = 'audit_' || required.t and not tr.tgisinternal
   )),
  0,
  '10 · Las ocho tablas quedan auditadas'
);

-- ---------------------------------------------------------------------------
-- La orden de compra no mueve inventario
-- ---------------------------------------------------------------------------

create temporary table po on commit drop as
select public.issue_purchase_order(
  (select s_pen from fx), (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v1 from fx), 'orderedUnits', 100, 'unitCost', 8.00)),
  gen_random_uuid(), 'PEN', 'credit'::public.purchase_terms
) as detail;

select is(
  (select (detail ->> 'total')::numeric from po),
  800.00::numeric,
  '11 · La orden congela el costo declarado y calcula su total'
);

select is(
  coalesce((select on_hand from public.inventory_stock
            where variant_id = (select v1 from fx) and branch_id = (select b1 from fx)), 0),
  0,
  '12 · La orden de compra NO incrementa inventario'
);

select is(
  (select count(*)::integer from public.inventory_movements
   where source_type = 'purchase_order'),
  0,
  '13 · Ni deja asiento en el kardex'
);

-- ---------------------------------------------------------------------------
-- Recepción parcial (prueba crítica 10)
-- ---------------------------------------------------------------------------

create temporary table rec1 on commit drop as
select public.register_goods_receipt(
  (select s_pen from fx), (select b1 from fx),
  jsonb_build_array(jsonb_build_object(
    'variantId', (select v1 from fx),
    'purchaseOrderLineId', (select l.id from public.purchase_order_lines l
                            where l.purchase_order_id = ((select detail ->> 'id' from po))::uuid limit 1),
    'expectedUnits', 100, 'receivedUnits', 60, 'unitCost', 8.00)),
  gen_random_uuid(),
  ((select detail ->> 'id' from po))::uuid,
  'PEN', null, null, 'credit'::public.purchase_terms
) as detail;

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v1 from fx) and branch_id = (select b1 from fx)),
  60,
  '14 · La recepción aumenta solo lo efectivamente recibido'
);

select is(
  (select status from public.purchase_orders where id = ((select detail ->> 'id' from po))::uuid),
  'partially_received'::public.purchase_order_status,
  '15 · Y deja la orden parcialmente recibida'
);

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 4)
     from public.inventory_valuation
     where variant_id = (select v1 from fx) and branch_id = (select b1 from fx) $$,
  $$ values (60, 480.00::numeric, 8.0000::numeric) $$,
  '16 · El promedio ponderado se recalcula con el costo real recibido'
);

-- Idempotencia: una recepción reintentada duplicaría stock, promedio y deuda.
select is(
  (select public.register_goods_receipt(
     (select s_pen from fx), (select b1 from fx),
     jsonb_build_array(jsonb_build_object('variantId', (select v1 from fx), 'receivedUnits', 60, 'unitCost', 8.00)),
     (select r.client_operation_id from public.goods_receipts r
      where r.id = ((select detail ->> 'id' from rec1))::uuid),
     null, 'PEN', null, null, 'credit'::public.purchase_terms
   ) ->> 'id'),
  (select detail ->> 'id' from rec1),
  '17 · Reintentar una recepción devuelve la ya registrada'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v1 from fx) and branch_id = (select b1 from fx)),
  60,
  '18 · Y no duplica las existencias'
);

-- ---------------------------------------------------------------------------
-- Bonificación del mismo artículo
-- ---------------------------------------------------------------------------
-- 80 pagadas a 10,00 más 20 de regalo son 100 unidades a 800,00: el regalo baja
-- el costo efectivo en lugar de entrar a costo cero, que fabricaría un promedio
-- falso e indistinguible de «costo desconocido».

select public.register_goods_receipt(
  (select s_pen from fx), (select b1 from fx),
  jsonb_build_array(jsonb_build_object(
    'variantId', (select v2 from fx),
    'receivedUnits', 80, 'bonusUnits', 20, 'unitCost', 10.00,
    'bonusValuation', 'same_variant')),
  gen_random_uuid(), null, 'PEN', null, null, 'cash'::public.purchase_terms
) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 4)
     from public.inventory_valuation
     where variant_id = (select v2 from fx) and branch_id = (select b1 from fx) $$,
  $$ values (100, 800.00::numeric, 8.0000::numeric) $$,
  '19 · La bonificación del mismo artículo baja el costo efectivo por unidad'
);

-- ---------------------------------------------------------------------------
-- Moneda funcional (corrección 1 de §12/0031)
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.register_goods_receipt(%L::uuid, %L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'receivedUnits', 5, 'unitCost', 3.00)),
      gen_random_uuid(), null, 'USD', null, null, 'cash'::public.purchase_terms) $$,
    (select s_usd from fx), (select b1 from fx), (select v1 from fx)),
  '22023', null,
  '20 · Una recepción en moneda extranjera exige su tipo de cambio'
);

select is(
  (select public.register_goods_receipt(
     (select s_usd from fx), (select b1 from fx),
     jsonb_build_array(jsonb_build_object('variantId', (select v1 from fx), 'receivedUnits', 10, 'unitCost', 3.00)),
     gen_random_uuid(), null, 'USD', 3.80, null, 'credit'::public.purchase_terms
   ) is not null),
  true,
  '21 · Con tipo de cambio declarado, la recepción entra'
);

-- 60 a 8,00 = 480,00 más 10 a 3,00 USD × 3,80 = 114,00 → 70 unidades, 594,00.
select results_eq(
  $$ select quantity_valued, round(total_value, 2)
     from public.inventory_valuation
     where variant_id = (select v1 from fx) and branch_id = (select b1 from fx) $$,
  $$ values (70, 594.00::numeric) $$,
  '22 · El costo en moneda extranjera se incorpora convertido a soles'
);

-- ---------------------------------------------------------------------------
-- Cuentas por pagar (prueba crítica 11)
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from public.supplier_obligations where supplier_id = (select s_pen from fx)),
  1,
  '23 · La recepción a crédito genera su obligación'
);

select is(
  (select round(amount_due, 2) from public.supplier_obligations where supplier_id = (select s_pen from fx)),
  480.00::numeric,
  '24 · Por el importe realmente recibido, no por el pedido'
);

create temporary table pay1 on commit drop as
select public.register_supplier_payment(
  (select s_pen from fx), (select b1 from fx), 'transfer'::public.payment_method, 200.00,
  gen_random_uuid(), 'PEN',
  jsonb_build_array(jsonb_build_object(
    'obligationId', (select id from public.supplier_obligations where supplier_id = (select s_pen from fx) limit 1),
    'amount', 200.00))
) as detail;

-- El estado es DERIVADO, no una columna que alguien pueda contradecir: una
-- vista «recibido menos pagado» sí sobrevive cuando las asignaciones existen.
select is(
  (select round(balance, 2) from public.supplier_balances
   where supplier_id = (select s_pen from fx) and currency = 'PEN'),
  280.00::numeric,
  '25 · Un pago parcial reduce la deuda por la diferencia exacta'
);

-- Un pago sin asignar es anticipo o crédito a favor del negocio.
select public.register_supplier_payment(
  (select s_pen from fx), (select b1 from fx), 'cash'::public.payment_method, 50.00,
  gen_random_uuid(), 'PEN', '[]'::jsonb
) from fx;

select is(
  (select round(sum(unallocated), 2) from public.supplier_unallocated_payments
   where supplier_id = (select s_pen from fx)),
  50.00::numeric,
  '26 · Un pago sin asignar queda como anticipo'
);

-- Sin tope se asignarían 1.600 habiendo desembolsado 1.000.
select throws_ok(
  format($$ select public.register_supplier_payment(%L::uuid, %L::uuid, 'cash'::public.payment_method, 10.00,
      gen_random_uuid(), 'PEN',
      jsonb_build_array(jsonb_build_object('obligationId', %L::uuid, 'amount', 500.00))) $$,
    (select s_pen from fx), (select b1 from fx),
    (select id from public.supplier_obligations where supplier_id = (select s_pen from fx) limit 1)),
  '23514', null,
  '27 · No se asigna más de lo desembolsado'
);

-- La deuda se calcula POR MONEDA: sumar PEN y USD sin conversión explícita es
-- exactamente lo que el modelo prohíbe.
select is(
  (select count(distinct currency)::integer from public.supplier_balances
   where supplier_id in (select s_pen from fx) or supplier_id in (select s_usd from fx)),
  2,
  '28 · La deuda se reporta por moneda, sin sumar PEN y USD'
);

-- ---------------------------------------------------------------------------
-- La vendedora no ve el abastecimiento
-- ---------------------------------------------------------------------------

grant select on fx to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.purchase_orders)
    + (select count(*)::integer from public.goods_receipts)
    + (select count(*)::integer from public.supplier_obligations)
    + (select count(*)::integer from public.supplier_payments),
  0,
  '29 · La vendedora obtiene cero filas de compras, recepciones y pagos'
);

select throws_ok(
  format($$ select public.issue_purchase_order(%L::uuid, %L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'orderedUnits', 1, 'unitCost', 1.00)),
      gen_random_uuid()) $$,
    (select s_pen from fx), (select b1 from fx), (select v1 from fx)),
  '42501', null,
  '30 · Y no puede emitir una orden de compra'
);

reset role;

select * from finish();

rollback;
