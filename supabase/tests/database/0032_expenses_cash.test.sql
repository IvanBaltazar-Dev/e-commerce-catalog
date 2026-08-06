begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','a1000000-0000-4000-8000-000000000001','authenticated','authenticated','cash-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','a1000000-0000-4000-8000-000000000002','authenticated','authenticated','cash-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('a1000000-0000-4000-8000-000000000001','admin','Propietaria de caja diaria'),
  ('a1000000-0000-4000-8000-000000000002','seller','Vendedora de caja diaria');

-- Dos sedes propias: el traslado necesita origen y destino, y las aserciones
-- declaran existencias absolutas que sobre la sede principal dependerían del
-- seed de demostración.
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CASHTEST1', 'Sede origen de traslados', 'Lima', false, 929
from public.companies c limit 1;

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CASHTEST2', 'Sede destino de traslados', 'Lima', false, 930
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO') as v1,
  (select id from public.product_variants where sku = 'DEMO-ESM-NUDE') as v2,
  (select id from public.branches where code = 'CASHTEST1')            as b1,
  (select id from public.branches where code = 'CASHTEST2')            as b2,
  'a1000000-0000-4000-8000-000000000001'::uuid                         as admin_id,
  'a1000000-0000-4000-8000-000000000002'::uuid                         as seller_id;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, b1, true from fx;

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Precondición DECLARADA: la carga inicial solo acepta variantes sin
-- seguimiento —esa invariante es su guarda de idempotencia—, así que el estado
-- que dejara el seed de demostración no puede decidir si esta prueba corre.
update public.product_variants set tracks_inventory = false where id = (select v1 from fx);

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'expense_categories', '1 · Existen las categorías de gasto');
select has_table('public', 'expenses', '2 · Existen los gastos');
select has_table('public', 'expense_allocations', '3 · Existe la imputación');
select has_table('public', 'cash_sessions', '4 · Existe la sesión de caja');
select has_table('public', 'cash_movements', '5 · Existe el movimiento de caja');
select has_table('public', 'inventory_transfers', '6 · Existe el traslado entre sedes');
select has_table('public', 'initial_load_batches', '7 · Existe el lote de carga inicial');

select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('open_cash_session', 'close_cash_session', 'record_cash_movement',
                     'register_expense', 'void_expense', 'register_transfer',
                     'commit_initial_load_batch', 'revert_initial_load_batch')
     and not prosecdef),
  0,
  '8 · Los ocho contratos de caja, gasto y traslado son SECURITY DEFINER'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('open_cash_session', 'close_cash_session', 'record_cash_movement',
                       'register_expense', 'void_expense', 'register_transfer',
                       'commit_initial_load_batch', 'revert_initial_load_batch')),
  false,
  '9 · Ninguno es alcanzable por anon'
);

select is(
  (select count(*)::integer
   from (values ('expenses'), ('expense_allocations'), ('cash_sessions'),
                ('inventory_transfers'), ('initial_load_batches')) as required(t)
   where not exists (
     select 1 from pg_trigger tr
     where tr.tgrelid = ('public.' || required.t)::regclass
       and tr.tgname = 'audit_' || required.t and not tr.tgisinternal
   )),
  0,
  '10 · Las tablas de dinero y decisión quedan auditadas'
);

-- Una vista sin security_invoker corre como su propietario: la de márgenes
-- publicaría el costo entero a cualquier authenticated.
select is(
  (select count(*)::integer from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and not coalesce(c.reloptions::text like '%security_invoker=true%', false)),
  0,
  '11 · Toda vista de public sigue declarando security_invoker'
);

-- ---------------------------------------------------------------------------
-- Carga inicial por lote
-- ---------------------------------------------------------------------------

create temporary table batch1 on commit drop as
select public.commit_initial_load_batch(
  (select b1 from fx),
  jsonb_build_array(
    jsonb_build_object('sku', 'DEMO-ESM-ROJO', 'branchCode', 'CASHTEST1', 'quantity', 40, 'unitCost', 9.00)
  ),
  gen_random_uuid(),
  current_date,
  'Toma física de prueba'
) as detail;

select is(
  (select tracks_inventory from public.product_variants where id = (select v1 from fx)),
  true,
  '12 · La carga inicial activa el seguimiento solo de lo cargado'
);

select results_eq(
  $$ select on_hand from public.inventory_stock
     where variant_id = (select v1 from fx) and branch_id = (select b1 from fx) $$,
  $$ values (40) $$,
  '13 · Y deja la existencia contada'
);

select is(
  (select movement_type from public.inventory_movements
   where variant_id = (select v1 from fx) order by id desc limit 1),
  'initial_load'::public.inventory_movement_type,
  '14 · Con asiento de toma física, no simulando una recepción'
);

-- Idempotencia: el mismo identificador de operación devuelve el lote existente.
select is(
  (select public.commit_initial_load_batch(
     (select b1 from fx),
     jsonb_build_array(jsonb_build_object('sku', 'DEMO-ESM-ROJO', 'branchCode', 'CASHTEST1', 'quantity', 40)),
     (select client_operation_id from public.initial_load_batches
      where id = ((select detail ->> 'id' from batch1))::uuid)
   ) ->> 'id'),
  (select detail ->> 'id' from batch1),
  '15 · Reintentar el lote devuelve el ya confirmado'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v1 from fx) and branch_id = (select b1 from fx)),
  40,
  '16 · Y no duplica las existencias contadas'
);

-- ---------------------------------------------------------------------------
-- Traslado entre sedes
-- ---------------------------------------------------------------------------
-- Es la única operación que toca DOS filas con el mismo variant_id, y por eso
-- el orden de candados es (variant_id, branch_id) y no solo la variante.

select public.register_transfer(
  b1, b2,
  jsonb_build_array(jsonb_build_object('variantId', v1, 'units', 15)),
  gen_random_uuid(), 'Reposición de la segunda sede'
) from fx;

select results_eq(
  $$ select
       (select on_hand from public.inventory_stock
        where variant_id = (select v1 from fx) and branch_id = (select b1 from fx)),
       (select on_hand from public.inventory_stock
        where variant_id = (select v1 from fx) and branch_id = (select b2 from fx)) $$,
  $$ values (25, 15) $$,
  '17 · El traslado mueve unidades entre sedes sin crear ni destruir ninguna'
);

-- Un traslado no crea ni destruye valor: 40 × 9,00 = 360,00 repartidos.
select is(
  (select round(sum(total_value), 2) from public.inventory_valuation
   where variant_id = (select v1 from fx)
     and branch_id in (select b1 from fx union all select b2 from fx)),
  360.00::numeric,
  '18 · Y conserva el valor total, entrando al destino al mismo costo'
);

select throws_ok(
  format($$ select public.register_transfer(%L::uuid, %L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'units', 1)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select b1 from fx), (select v1 from fx)),
  '22023', null,
  '19 · No se traslada mercadería a la misma sede'
);

select throws_ok(
  format($$ select public.register_transfer(%L::uuid, %L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'units', 9999)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select b2 from fx), (select v1 from fx)),
  '23514', null,
  '20 · Ni más unidades de las que hay en el origen'
);

-- ---------------------------------------------------------------------------
-- Caja diaria
-- ---------------------------------------------------------------------------

create temporary table session1 on commit drop as
select public.open_cash_session((select b1 from fx), 100.00, 'Apertura de prueba') as detail;

select is(
  (select round(sum(amount), 2) from public.cash_movements
   where cash_session_id = ((select detail ->> 'id' from session1))::uuid),
  100.00::numeric,
  '21 · Abrir caja registra el fondo de apertura como movimiento'
);

select throws_ok(
  format($$ select public.open_cash_session(%L::uuid, 0) $$, (select b1 from fx)),
  '23514', null,
  '22 · No se abren dos cajas a la vez en la misma sede'
);

-- ---------------------------------------------------------------------------
-- Gastos
-- ---------------------------------------------------------------------------

insert into public.expense_categories (code, name)
values ('TEST_FLETE', 'Flete de prueba')
on conflict (code) do nothing;

create temporary table exp1 on commit drop as
select public.register_expense(
  (select b1 from fx),
  (select id from public.expense_categories where code = 'TEST_FLETE'),
  'cash'::public.payment_method,
  60.00,
  'Flete del lote de prueba',
  gen_random_uuid()
) as detail;

-- El gasto en efectivo SALE del cajón: sin este movimiento el arqueo no cuadra
-- y el descuadre acaba atribuido a quien atendió.
select is(
  (select round(sum(amount), 2) from public.cash_movements
   where cash_session_id = ((select detail ->> 'id' from session1))::uuid),
  40.00::numeric,
  '23 · Un gasto en efectivo sale del cajón y el arqueo lo refleja'
);

select throws_ok(
  format($$ select public.register_expense(%L::uuid, %L::uuid, 'cash'::public.payment_method,
      10.00, 'Imputación excesiva', gen_random_uuid(), null, null, null, null, null,
      'one_off'::public.expense_recurrence,
      jsonb_build_array(jsonb_build_object('saleId', null, 'goodsReceiptId', null,
                                           'purchaseOrderId', null, 'amount', 999.00))) $$,
    (select b1 from fx), (select id from public.expense_categories where code = 'TEST_FLETE')),
  null, null,
  '24 · Una imputación sin alcance o por encima del gasto se rechaza'
);

-- La corrección de un gasto es una reversión registrada, nunca un UPDATE.
select is(
  public.void_expense(((select detail ->> 'id' from exp1))::uuid, 'Se registró dos veces') is not null,
  true,
  '25 · Un gasto se corrige anulándolo, con motivo'
);

select is(
  (select round(sum(amount), 2) from public.cash_movements
   where cash_session_id = ((select detail ->> 'id' from session1))::uuid),
  100.00::numeric,
  '26 · Y la anulación devuelve el efectivo al arqueo'
);

-- ---------------------------------------------------------------------------
-- La vendedora no ve el frente económico
-- ---------------------------------------------------------------------------

grant select on fx to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.expenses)
    + (select count(*)::integer from public.inventory_transfers)
    + (select count(*)::integer from public.initial_load_batches),
  0,
  '27 · La vendedora obtiene cero filas de gastos, traslados y cargas iniciales'
);

select throws_ok(
  format($$ select public.register_transfer(%L::uuid, %L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'units', 1)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select b2 from fx), (select v1 from fx)),
  '42501', null,
  '28 · Y no puede trasladar mercadería entre sedes'
);

reset role;

select * from finish();

rollback;
