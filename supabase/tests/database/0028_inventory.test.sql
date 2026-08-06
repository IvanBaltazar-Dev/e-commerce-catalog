begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

-- ---------------------------------------------------------------------------
-- Fixtures aislados. Prefijo INV-TEST- para poder limpiarlos aparte de
-- TEST-% y SCALE-%, que usa el script de limpieza.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','a0000000-0000-4000-8000-000000000001','authenticated','authenticated','inv-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','a0000000-0000-4000-8000-000000000002','authenticated','authenticated','inv-seller1@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','a0000000-0000-4000-8000-000000000003','authenticated','authenticated','inv-seller2@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('a0000000-0000-4000-8000-000000000001','admin','Propietaria inventario'),
  ('a0000000-0000-4000-8000-000000000002','seller','Vendedora sede 1'),
  ('a0000000-0000-4000-8000-000000000003','seller','Vendedora sede 2');

-- Dos sedes propias, para probar la agregación y el alcance por sede sin
-- heredar existencias de la principal: las aserciones de valoración declaran
-- importes absolutos y el seed de demostración opera sobre la sede real.
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'INVTEST1', 'Sede de inventario de prueba', 'Lima', false, 899
from public.companies c limit 1;

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'INVTEST2', 'Sede de prueba de inventario', 'Lima', false, 900
from public.companies c limit 1;

-- Variantes que ningún seed toca: la disponibilidad efectiva AGREGA sobre todas
-- las sedes activas, así que una variante con existencia sembrada en la sede
-- principal nunca saldría agotada por más que se vacíe la sede de prueba.
create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-EXT-ALM-S-NAT') as v_seguida,
  (select id from public.product_variants where sku = 'DEMO-TOR-001-UNICA') as v_libre,
  (select id from public.product_variants where sku = 'DEMO-EXT-COF-M-CLR') as v_agotada_editorial,
  (select id from public.branches where code = 'INVTEST1')                as b1,
  (select id from public.branches where code = 'INVTEST2')                as b2,
  'a0000000-0000-4000-8000-000000000001'::uuid                           as admin_id,
  'a0000000-0000-4000-8000-000000000002'::uuid                           as seller1,
  'a0000000-0000-4000-8000-000000000003'::uuid                           as seller2;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller1, b1, true from fx;
insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller2, b2, true from fx;

set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'inventory_stock', '1 · Existe el saldo de existencias');
select has_table('public', 'inventory_movements', '2 · Existe el kardex');
select has_table('public', 'inventory_valuation', '3 · Existe la valoración');
select has_column('public', 'product_variants', 'tracks_inventory', '4 · Existe tracks_inventory');
select has_function('public', 'variant_effective_availability', array['uuid','uuid'], '5 · Existe la disponibilidad efectiva');
select has_function('public', 'apply_inventory_movement',
  array['uuid','uuid','inventory_movement_type','integer','numeric','text','uuid','text','text','uuid'],
  '6 · Existe el punto único de escritura');

-- La disponibilidad efectiva debe ser SECURITY DEFINER o anon leería cero filas
-- de inventory_stock: las tres funciones de catálogo son INVOKER.
select is(
  (select prosecdef from pg_proc where proname = 'variant_effective_availability' and pronamespace = 'public'::regnamespace),
  true,
  '7 · La disponibilidad efectiva es SECURITY DEFINER'
);

-- Una vista sin security_invoker corre como su propietario y publicaría la
-- tabla entera a cualquier authenticated.
select is(
  (select count(*)::integer from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and c.relname in ('inventory_position', 'variant_public_availability')
     and not coalesce(c.reloptions::text like '%security_invoker=true%', false)),
  0,
  '8 · Todas las vistas nuevas declaran security_invoker'
);

-- ---------------------------------------------------------------------------
-- La migración no agota el catálogo existente
-- ---------------------------------------------------------------------------

-- La prueba crítica 14 del modelo —«aplicar 0028 no convierte ninguna variante
-- en agotada»— se sostiene sobre el DEFECTO de la columna, no sobre el recuento
-- del momento: una base ya operada tiene variantes con seguimiento activo
-- porque alguien cargó su existencia inicial, que es justo lo que debe pasar.
-- Contar filas hacía fallar la aserción por haber usado el sistema.
select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'product_variants'
     and column_name = 'tracks_inventory'),
  'false',
  '9 · El seguimiento nace desactivado: aplicar 0028 no agota ninguna variante'
);

select is(
  (select public.variant_effective_availability(v_seguida) from fx),
  'available'::public.product_availability,
  '10 · Sin seguimiento, la disponibilidad es la editorial aunque no haya existencias'
);

-- ---------------------------------------------------------------------------
-- Precedencia editorial
-- ---------------------------------------------------------------------------

select is(
  (select public.variant_effective_availability(v_agotada_editorial) from fx),
  'sold_out'::public.product_availability,
  '11 · El agotado editorial se conserva'
);

update public.product_variants set availability_status = 'consult', tracks_inventory = true
where id = (select v_libre from fx);
select public.apply_inventory_movement(v_libre, b1, 'initial_load', 50, 8.00, 'test', null, 'fx', 'fixture', admin_id) from fx;

select is(
  (select public.variant_effective_availability(v_libre) from fx),
  'consult'::public.product_availability,
  '12 · Consultar manda aunque haya existencias y seguimiento'
);

update public.product_variants set availability_status = 'sold_out'
where id = (select v_libre from fx);

select is(
  (select public.variant_effective_availability(v_libre) from fx),
  'sold_out'::public.product_availability,
  '13 · El agotado editorial manda aunque haya existencias'
);

update public.product_variants set availability_status = 'available'
where id = (select v_libre from fx);

select is(
  (select public.variant_effective_availability(v_libre) from fx),
  'available'::public.product_availability,
  '14 · Con seguimiento y saldo positivo, disponible'
);

-- ---------------------------------------------------------------------------
-- Agotado automático y alcance por sede
-- ---------------------------------------------------------------------------

select public.apply_inventory_movement(v_libre, b1, 'sale', -50, null, 'test', null, 'fx', 'vaciar', admin_id) from fx;

select is(
  (select public.variant_effective_availability(v_libre) from fx),
  'sold_out'::public.product_availability,
  '15 · Con seguimiento y saldo cero, agotado automático'
);

-- Existencias solo en la segunda sede.
select public.apply_inventory_movement(v_libre, b2, 'receipt', 5, 9.00, 'test', null, 'fx', 'stock sede 2', admin_id) from fx;

select is(
  (select public.variant_effective_availability(v_libre) from fx),
  'available'::public.product_availability,
  '16 · Sin sede, agrega sobre las sedes activas'
);

select is(
  (select public.variant_effective_availability(v_libre, b1) from fx),
  'sold_out'::public.product_availability,
  '17 · Consultada por sede, la sede sin saldo sale agotada'
);

select is(
  (select public.variant_effective_availability(v_libre, b2) from fx),
  'available'::public.product_availability,
  '18 · Consultada por sede, la sede con saldo sale disponible'
);

-- ---------------------------------------------------------------------------
-- Integridad de saldos
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.apply_inventory_movement(%L::uuid, %L::uuid, 'sale', -999, null, null, null, null, 'sobregiro', %L::uuid) $$,
    (select v_libre from fx), (select b2 from fx), (select admin_id from fx)),
  '23514',
  null,
  '19 · No se puede retirar más de lo que hay'
);

select is(
  (select count(*)::integer from public.inventory_stock where on_hand < 0 or reserved < 0 or reserved > on_hand),
  0,
  '20 · Ningún saldo queda negativo ni sobre-reservado'
);

-- El saldo del kardex debe coincidir siempre con inventory_stock.
select is(
  (select count(*)::integer
   from public.inventory_stock s
   join lateral (
     select coalesce(sum(m.quantity), 0) as total
     from public.inventory_movements m
     where m.variant_id = s.variant_id and m.branch_id = s.branch_id
   ) k on true
   where k.total <> s.on_hand),
  0,
  '21 · El saldo del kardex coincide con inventory_stock en toda fila'
);

-- value_after del último asiento debe coincidir con la valoración vigente.
select is(
  (select count(*)::integer
   from public.inventory_valuation v
   join lateral (
     select m.value_after
     from public.inventory_movements m
     where m.variant_id = v.variant_id and m.branch_id = v.branch_id
     order by m.id desc limit 1
   ) last on true
   where round(last.value_after, 6) <> round(v.total_value, 6)),
  0,
  '22 · value_after coincide con inventory_valuation.total_value'
);

-- ---------------------------------------------------------------------------
-- Valoración: secuencia numérica de referencia
-- ---------------------------------------------------------------------------

select public.apply_inventory_movement(v_seguida, b1, 'receipt', 100, 10.00, 'test', null, 'R1', 'ref 1', admin_id) from fx;
select public.apply_inventory_movement(v_seguida, b1, 'receipt', 50, 13.00, 'test', null, 'R2', 'ref 2', admin_id) from fx;
select public.apply_inventory_movement(v_seguida, b1, 'receipt', 80, 12.00, 'test', null, 'R3', 'ref 3', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 4)
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (230, 2610.00::numeric, 11.3478::numeric) $$,
  '23 · Tres recepciones dan 230 unidades, 2610.00 y promedio 11.3478'
);

select public.apply_inventory_movement(v_seguida, b1, 'sale', -10, null, 'test', null, 'V1', 'venta', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 4)
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (220, 2496.52::numeric, 11.3478::numeric) $$,
  '24 · Vender no mueve el promedio'
);

select public.apply_inventory_movement(v_seguida, b1, 'receipt', 100, 15.00, 'test', null, 'R4', 'ref 4', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 4)
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (320, 3996.52::numeric, 12.4891::numeric) $$,
  '25 · Una recepción más cara sube el promedio'
);

-- La última salida valorada debe dejar cantidad y valor exactamente en cero.
select public.apply_inventory_movement(v_seguida, b1, 'sale', -320, null, 'test', null, 'V2', 'vaciar', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, total_value
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (0, 0::numeric) $$,
  '26 · La última salida valorada deja cantidad y valor en cero exacto'
);

-- ---------------------------------------------------------------------------
-- Unidades sin valorar: regla de consumo y base del costo
-- ---------------------------------------------------------------------------
-- Carga inicial sin costo: la existencia sube pero nada se valora. No se
-- inventa un promedio ni se finge que costaron cero.

select public.apply_inventory_movement(v_seguida, b2, 'initial_load', 100, null, 'test', null, 'CI', 'sin costo', admin_id) from fx;

-- El coalesce va FUERA: la ausencia de fila es precisamente el idioma que
-- representa «nada valorado», igual que en tax_document_requests.
select is(
  coalesce((select quantity_valued from public.inventory_valuation
            where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx)), 0),
  0,
  '27 · Una carga inicial sin costo no valora ninguna unidad'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx)),
  100,
  '28 · Pero sí incorpora la existencia física'
);

select is(
  (select cost_basis from public.inventory_movements
   where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx)
   order by id desc limit 1),
  'unknown'::public.inventory_cost_basis,
  '29 · Y queda registrada como costo desconocido, no como costo cero'
);

-- Ahora entran 50 con costo. Quedan 100 sin valorar y 50 valoradas a 20.
select public.apply_inventory_movement(v_seguida, b2, 'receipt', 50, 20.00, 'test', null, 'R5', 'con costo', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2), round(average_unit_cost, 6)
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx) $$,
  $$ values (50, 1000.00::numeric, 20.000000::numeric) $$,
  '30 · Las unidades sin costo no diluyen el promedio de las valoradas'
);

-- REGLA DEL BLOQUE: las salidas consumen primero las unidades SIN VALORAR.
select public.apply_inventory_movement(v_seguida, b2, 'sale', -60, null, 'test', null, 'V3', 'salida', admin_id) from fx;

select results_eq(
  $$ select quantity_valued, round(total_value, 2)
     from public.inventory_valuation
     where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx) $$,
  $$ values (50, 1000.00::numeric) $$,
  '31 · Una salida consume primero lo no valorado y no toca el fondo valorado'
);

select is(
  (select cost_basis from public.inventory_movements
   where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx)
   order by id desc limit 1),
  'unknown'::public.inventory_cost_basis,
  '32 · Esa salida no produce un margen ficticio: su base es desconocida'
);

-- Quedan 40 sin valorar y 50 valoradas. Una salida de 60 cruza los dos fondos.
select public.apply_inventory_movement(v_seguida, b2, 'sale', -60, null, 'test', null, 'V4', 'mixta', admin_id) from fx;

select is(
  (select cost_basis from public.inventory_movements
   where variant_id = (select v_seguida from fx) and branch_id = (select b2 from fx)
   order by id desc limit 1),
  'mixed'::public.inventory_cost_basis,
  '33 · Una salida que cruza ambos fondos se marca como mixta'
);

-- ---------------------------------------------------------------------------
-- Historia
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ delete from public.product_variants where id = %L::uuid $$, (select v_seguida from fx)),
  '23503',
  null,
  '34 · Una variante con movimientos no puede borrarse físicamente'
);

select * from finish();

rollback;
