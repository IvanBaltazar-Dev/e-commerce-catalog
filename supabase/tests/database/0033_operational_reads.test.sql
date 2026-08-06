begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','a2000000-0000-4000-8000-000000000001','authenticated','authenticated','read-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','a2000000-0000-4000-8000-000000000002','authenticated','authenticated','read-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('a2000000-0000-4000-8000-000000000001','admin','Propietaria de lecturas'),
  ('a2000000-0000-4000-8000-000000000002','seller','Vendedora de lecturas');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'READTEST', 'Sede de lecturas operativas', 'Lima', false, 920
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO') as v1,
  (select id from public.branches where code = 'READTEST')             as b1,
  'a2000000-0000-4000-8000-000000000001'::uuid                         as admin_id,
  'a2000000-0000-4000-8000-000000000002'::uuid                         as seller_id;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, b1, true from fx;

set local request.jwt.claims = '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.product_variants set tracks_inventory = true where id = (select v1 from fx);
select public.apply_inventory_movement(v1, b1, 'initial_load', 30, 9.00,
  'test', null, 'fixture', 'existencia', admin_id) from fx;

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_function('public', 'daily_cash_summary', array['uuid', 'date'],
  '1 · Existe el arqueo diario que §7 declaraba');
select has_function('public', 'inventory_ledger',
  array['uuid', 'uuid', 'timestamptz', 'timestamptz', 'integer'],
  '2 · Existe el kardex consultable que §7 declaraba');

select is(
  (select prosecdef from pg_proc
   where proname = 'inventory_ledger' and pronamespace = 'public'::regnamespace),
  true,
  '3 · El kardex es DEFINER: las columnas monetarias ya no salen de la tabla'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('daily_cash_summary', 'inventory_ledger')),
  false,
  '4 · Ninguna de las dos es alcanzable por anon'
);

-- ---------------------------------------------------------------------------
-- El costo del kardex deja de ser legible desde la tabla
-- ---------------------------------------------------------------------------
-- La RLS no recorta columnas, y un GRANT por columna no distingue a la
-- administradora de la vendedora: las dos son `authenticated`. Por eso las
-- columnas monetarias se cierran a la tabla y se sirven por el objeto DEFINER.

select is(
  has_column_privilege('authenticated', 'public.inventory_movements', 'unit_cost', 'select'),
  false,
  '5 · authenticated no puede leer unit_cost desde inventory_movements'
);

select is(
  (select bool_or(has_column_privilege('authenticated', 'public.inventory_movements', c, 'select'))
   from unnest(array['value_delta', 'value_after']) as c),
  false,
  '6 · Ni value_delta ni value_after'
);

select is(
  (select bool_and(has_column_privilege('authenticated', 'public.inventory_movements', c, 'select'))
   from unnest(array['quantity', 'balance_after', 'movement_type', 'occurred_at']) as c),
  true,
  '7 · Pero sí las columnas de cantidad, que el personal necesita'
);

-- ---------------------------------------------------------------------------
-- Arqueo diario
-- ---------------------------------------------------------------------------
-- Una reserva con adelanto de ayer, convertida hoy: el adelanto pertenece al
-- arqueo de AYER y hoy solo se lista como conciliación. Sin ese filtro, la
-- misma plata cuadra la caja dos veces.

create temporary table res1 on commit drop as
select public.create_reservation(
  (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v1 from fx), 'quantity', 2)),
  jsonb_build_object('name', 'Clienta del arqueo'),
  now() + interval '2 days',
  gen_random_uuid(),
  jsonb_build_object('method', 'cash', 'amount', 10.00,
                     'receivedAt', (now() - interval '1 day')::text)
) as detail;

create temporary table sale1 on commit drop as
select public.register_sale(
  (select b1 from fx), null,
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00)),
  gen_random_uuid(),
  'in_store'::public.sale_source_channel, 'in_store'::public.fulfillment_method,
  null, 0, null, ((select detail ->> 'id' from res1))::uuid
) as detail;

select is(
  (public.daily_cash_summary((select b1 from fx), current_date) ->> 'cashIncome')::numeric,
  20.00::numeric,
  '8 · El arqueo de hoy cuenta el saldo cobrado hoy, no el adelanto de ayer'
);

select is(
  (public.daily_cash_summary((select b1 from fx), current_date) -> 'appliedAdvances' ->> 'amount')::numeric,
  10.00::numeric,
  '9 · Y lista el adelanto trasladado aparte, como conciliación'
);

select is(
  (public.daily_cash_summary((select b1 from fx), (current_date - 1)) ->> 'cashIncome')::numeric,
  10.00::numeric,
  '10 · El adelanto sí cuadra el arqueo del día en que entró'
);

-- ---------------------------------------------------------------------------
-- El kardex por rol
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer
   from jsonb_array_elements(
     public.inventory_ledger((select v1 from fx), (select b1 from fx)) -> 'entries') e
   where e -> 'cost' is not null and jsonb_typeof(e -> 'cost') <> 'null'),
  2,
  '11 · Administración ve el kardex valorizado: carga inicial y venta'
);

grant select on fx to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer
   from jsonb_array_elements(
     public.inventory_ledger((select v1 from fx), (select b1 from fx)) -> 'entries') e
   where e -> 'cost' is not null and jsonb_typeof(e -> 'cost') <> 'null'),
  0,
  '12 · La vendedora ve los mismos asientos sin una sola cifra de costo'
);

reset role;

select * from finish();

rollback;
