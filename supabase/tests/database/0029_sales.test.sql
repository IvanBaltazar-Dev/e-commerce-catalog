begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

-- ---------------------------------------------------------------------------
-- Fixtures. Prefijo SALE-TEST- para poder limpiarlos aparte.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','d0000000-0000-4000-8000-000000000001','authenticated','authenticated','sale-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','d0000000-0000-4000-8000-000000000002','authenticated','authenticated','sale-seller1@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','d0000000-0000-4000-8000-000000000003','authenticated','authenticated','sale-seller2@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name, max_discount_percent) values
  ('d0000000-0000-4000-8000-000000000001','admin','Propietaria de caja', null),
  ('d0000000-0000-4000-8000-000000000002','seller','Vendedora sede 1', 10.00),
  ('d0000000-0000-4000-8000-000000000003','seller','Vendedora sede 2', null);

-- Sede PROPIA, no la principal: las aserciones sobre el correlativo declaran
-- números absolutos («la primera nota de la sede es NV-000001») y sobre la
-- sede compartida dependerían de cuántas ventas dejara antes cualquier otra
-- prueba o el seed de demostración. La numeración es contigua POR SEDE, así
-- que aislarla es la forma correcta de comprobarla.
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'SALETEST1', 'Sede de caja de prueba', 'Lima', false, 939
from public.companies c limit 1;

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'SALETEST2', 'Sede de prueba de ventas', 'Lima', false, 940
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO')  as v_seguida,
  (select id from public.product_variants where sku = 'DEMO-ESM-NUDE')  as v_libre,
  (select id from public.product_variants where sku = 'DEMO-ESM-ROSA')  as v_agotada,
  (select id from public.product_variants where sku = 'DEMO-ACC-001-UNICA') as v_accesorio,
  (select id from public.branches where code = 'SALETEST1')              as b1,
  (select id from public.branches where code = 'SALETEST2')              as b2,
  'd0000000-0000-4000-8000-000000000001'::uuid                           as admin_id,
  'd0000000-0000-4000-8000-000000000002'::uuid                           as seller1,
  'd0000000-0000-4000-8000-000000000003'::uuid                           as seller2;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller1, b1, true from fx;
insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller2, b2, true from fx;

set local request.jwt.claims = '{"sub":"d0000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- La variante seguida arranca con 20 unidades a 10,00 en la sede principal.
update public.product_variants set tracks_inventory = true where id = (select v_seguida from fx);
select public.apply_inventory_movement(v_seguida, b1, 'initial_load', 20, 10.00,
  'test', null, 'fixture', 'existencia inicial', admin_id) from fx;

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'sales', '1 · Existe la venta');
select has_table('public', 'sale_lines', '2 · Existen las líneas de venta');
select has_table('public', 'sale_line_costs', '3 · El costo vive en su propia tabla');
select has_table('public', 'sale_payments', '4 · Existen los pagos');
select has_table('public', 'reservations', '5 · Existen las reservas');
select has_table('public', 'reservation_payments', '6 · Existen los adelantos');
select has_table('public', 'branch_document_counters', '7 · Existe el correlativo por sede');
select has_table('public', 'tax_document_requests', '8 · Existe la solicitud de comprobante');

-- `orders` se retira: dos conceptos de venta conviviendo son la segunda fuente
-- de verdad que las reglas del bloque prohíben.
select hasnt_table('public', 'orders', '9 · La tabla de pedidos quedó retirada');
select hasnt_table('public', 'order_items', '10 · Y sus líneas también');

-- ---------------------------------------------------------------------------
-- Contexto de seguridad
-- ---------------------------------------------------------------------------
-- Comprobado contra la base: con register_sale como INVOKER, una vendedora
-- aborta en la primera sentencia de apply_inventory_movement por la política
-- `admins manage stock`. La frontera de confianza es el RPC, no la tabla.

select is(
  (select prosecdef from pg_proc where proname = 'register_sale' and pronamespace = 'public'::regnamespace),
  true,
  '11 · register_sale es SECURITY DEFINER con revalidación explícita'
);

select is(
  (select prosecdef from pg_proc where proname = 'apply_inventory_movement' and pronamespace = 'public'::regnamespace),
  true,
  '12 · El punto único de escritura de inventario es SECURITY DEFINER'
);

-- El ACL por defecto de Supabase concede EXECUTE a anon sobre toda función
-- nueva: sin revoke explícito, un visitante del catálogo movería existencias.
select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('apply_inventory_movement', 'adjust_inventory', 'load_initial_inventory',
                       'register_sale', 'create_reservation', 'release_reservation',
                       'next_document_number', 'sale_detail', 'prorate_discount')),
  false,
  '13 · Ningún RPC de caja ni de inventario es alcanzable por anon'
);

-- Y tampoco directamente por una vendedora: solo se llega por los RPC.
select is(
  has_function_privilege('authenticated',
    'public.apply_inventory_movement(uuid,uuid,public.inventory_movement_type,integer,numeric,text,uuid,text,text,uuid)',
    'execute'),
  false,
  '14 · authenticated no puede llamar al punto de escritura por su nombre'
);

-- ---------------------------------------------------------------------------
-- Cobertura de auditoría y de vistas
-- ---------------------------------------------------------------------------
-- Olvidar colgar un trigger deja de ser silencioso: la lista se declara aquí.

select is(
  (select count(*)::integer
   from (values
     ('sales'), ('sale_lines'), ('sale_line_costs'), ('sale_payments'),
     ('reservations'), ('reservation_lines'), ('reservation_payments'),
     ('tax_document_requests'), ('branch_document_counters'),
     ('inventory_valuation'), ('exchange_rates'),
     ('suppliers'), ('supplier_cost_agreements'), ('supplier_cost_tiers'),
     ('products'), ('product_variants'), ('variant_prices'),
     ('companies'), ('branches'), ('staff_branches'), ('admin_profiles')
   ) as required(table_name)
   where not exists (
     select 1 from pg_trigger t
     where t.tgrelid = ('public.' || required.table_name)::regclass
       and t.tgname = 'audit_' || required.table_name
       and not t.tgisinternal
   )),
  0,
  '15 · Toda tabla de dinero, existencias o decisión tiene su trigger de auditoría'
);

-- Una vista sin security_invoker corre como su propietario y publica la tabla
-- entera a cualquier authenticated.
select is(
  (select count(*)::integer from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and not coalesce(c.reloptions::text like '%security_invoker=true%', false)),
  0,
  '16 · Toda vista de public declara security_invoker'
);

-- ---------------------------------------------------------------------------
-- Venta simple
-- ---------------------------------------------------------------------------

create temporary table sale1 on commit drop as
select public.register_sale(
  (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v_seguida from fx), 'quantity', 2)),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30.00, 'tenderedAmount', 50.00)),
  '10000000-0000-4000-8000-000000000001'::uuid
) as detail;

select is(
  (select (detail ->> 'total')::numeric from sale1),
  30.00::numeric,
  '17 · La venta cobra el precio resuelto en PostgreSQL, no el que envía el cliente'
);

select is(
  (select detail ->> 'saleNumber' from sale1),
  'NV-000001',
  '18 · La nota de venta toma el primer correlativo de su sede'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx)),
  18,
  '19 · La venta descuenta la existencia física'
);

-- El costo se captura AHORA. Reconstruirlo después con el promedio vigente
-- valoraría la mercadería de hace meses con la cotización de hoy.
select results_eq(
  $$ select c.unit_cost, c.total_cost, c.cost_basis
     from public.sale_line_costs c
     join public.sale_lines l on l.id = c.sale_line_id
     where l.sale_id = ((select detail ->> 'id' from sale1))::uuid $$,
  $$ values (10.000000::numeric, 20.000000::numeric, 'weighted_average'::public.inventory_cost_basis) $$,
  '20 · El costo de la línea se captura del asiento, no del promedio posterior'
);

select is(
  (select (detail -> 'payments' -> 0 ->> 'change')::numeric from sale1),
  20.00::numeric,
  '21 · El vuelto se deriva de lo entregado y no se guarda como pago negativo'
);

-- ---------------------------------------------------------------------------
-- Idempotencia (prueba crítica 1)
-- ---------------------------------------------------------------------------

create temporary table sale1_retry on commit drop as
select public.register_sale(
  (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v_seguida from fx), 'quantity', 2)),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30.00)),
  '10000000-0000-4000-8000-000000000001'::uuid
) as detail;

select is(
  (select r.detail ->> 'id' from sale1_retry r),
  (select s.detail ->> 'id' from sale1 s),
  '22 · Un botón pulsado dos veces devuelve la venta ya creada'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx)),
  18,
  '23 · Y no descuenta la existencia por segunda vez'
);

-- ---------------------------------------------------------------------------
-- El dinero tiene que cuadrar exacto (prueba crítica 3 y 4)
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.register_sale(%L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'quantity', 1)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select v_seguida from fx)),
  '23514',
  null,
  '24 · Un pago incompleto no confirma la venta'
);

-- «Cubrir» el total admitiría sobrecobro invisible: S/ 100 por una venta de
-- S/ 90 deja S/ 10 que no son vuelto, ni adelanto, ni saldo a favor.
select throws_ok(
  format($$ select public.register_sale(%L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'quantity', 1)),
      jsonb_build_array(jsonb_build_object('method', 'yape', 'amount', 20.00)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select v_seguida from fx)),
  '23514',
  null,
  '25 · Un sobrecobro tampoco: los pagos suman EXACTAMENTE el total'
);

-- ---------------------------------------------------------------------------
-- Fallo a mitad de camino (prueba crítica 5)
-- ---------------------------------------------------------------------------

select is(
  (select next_number from public.branch_document_counters
   where branch_id = (select b1 from fx) and document_kind = 'sale_note'),
  2::bigint,
  '26 · Las dos ventas fallidas no consumieron correlativo'
);

select is(
  (select count(*)::integer from public.inventory_movements
   where source_type = 'sale' and branch_id = (select b1 from fx)),
  1,
  '27 · Ni dejaron asiento en el kardex'
);

-- ---------------------------------------------------------------------------
-- Pago mixto y prorrateo del descuento (prueba crítica 15)
-- ---------------------------------------------------------------------------

create temporary table sale2 on commit drop as
select public.register_sale(
  (select b1 from fx),
  jsonb_build_array(
    jsonb_build_object('variantId', (select v_seguida from fx), 'quantity', 2),
    jsonb_build_object('variantId', (select v_libre from fx), 'quantity', 1)
  ),
  jsonb_build_array(
    jsonb_build_object('method', 'yape', 'amount', 20.00),
    jsonb_build_object('method', 'cash', 'amount', 20.00, 'tenderedAmount', 20.00)
  ),
  '10000000-0000-4000-8000-000000000002'::uuid,
  'whatsapp'::public.sale_source_channel,
  'delivery'::public.fulfillment_method,
  jsonb_build_object('name', 'Clienta de prueba'),
  5.00
) as detail;

select is(
  (select (detail ->> 'total')::numeric from sale2),
  40.00::numeric,
  '28 · Pago mixto: 45,00 brutos menos 5,00 de descuento dan 40,00'
);

select is(
  (select sum(l.discount_amount) from public.sale_lines l
   where l.sale_id = ((select detail ->> 'id' from sale2))::uuid),
  5.00::numeric,
  '29 · El descuento sobre el total se prorratea al céntimo exacto'
);

select is(
  (select s.discount_total from public.sales s where s.id = ((select detail ->> 'id' from sale2))::uuid),
  (select sum(l.discount_amount) from public.sale_lines l
   where l.sale_id = ((select detail ->> 'id' from sale2))::uuid),
  '30 · discount_total es la suma de las líneas, no un dato independiente'
);

-- El residuo de redondeo va a la línea de mayor subtotal y, a igualdad, a la
-- primera del arreglo ordenado por variante: reproducible ejecución tras
-- ejecución.
select is(
  (select sum((value ->> 'discount')::numeric)
   from jsonb_array_elements(public.prorate_discount(
     '[{"subtotal":10},{"subtotal":10},{"subtotal":10}]'::jsonb, 10.00))),
  10.00::numeric,
  '31 · Tres líneas iguales y un descuento de 10,00: el residuo no se pierde'
);

select is(
  (public.prorate_discount('[{"subtotal":10},{"subtotal":10},{"subtotal":10}]'::jsonb, 10.00) -> 0 ->> 'discount')::numeric,
  3.34::numeric,
  '32 · Y va siempre a la misma línea'
);

-- ---------------------------------------------------------------------------
-- Lo que no se sigue, no se mueve
-- ---------------------------------------------------------------------------
-- Sin esta regla ninguna venta sería registrable hasta terminar la carga
-- inicial, que el modelo declara gradual por diseño.

select is(
  (select count(*)::integer from public.inventory_movements
   where variant_id = (select v_libre from fx)),
  0,
  '33 · Una variante sin seguimiento no genera asiento de kardex al venderse'
);

select is(
  (select c.cost_basis
   from public.sale_line_costs c
   join public.sale_lines l on l.id = c.sale_line_id
   where l.sale_id = ((select detail ->> 'id' from sale2))::uuid
     and l.variant_id = (select v_libre from fx)),
  'unknown'::public.inventory_cost_basis,
  '34 · Pero sí deja fila de costo declarado desconocido, que es consultable'
);

select is(
  (select count(*)::integer
   from public.sale_lines l
   left join public.sale_line_costs c on c.sale_line_id = l.id
   where c.sale_line_id is null),
  0,
  '35 · Ninguna línea de venta se queda sin su fila de costo'
);

-- ---------------------------------------------------------------------------
-- Disponibilidad y numeración
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$ select public.register_sale(%L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'quantity', 1)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 15.00)),
      gen_random_uuid()) $$,
    (select b1 from fx), (select v_agotada from fx)),
  '23514',
  null,
  '36 · No se vende una presentación agotada'
);

-- Numeración CONTIGUA por sede: sin huecos y sin duplicados.
select is(
  (select count(*)::integer from public.sales where branch_id = (select b1 from fx)),
  (select max(substring(sale_number from 4))::integer from public.sales where branch_id = (select b1 from fx)),
  '37 · La numeración de la sede es contigua: tantas ventas como el último número'
);

-- ---------------------------------------------------------------------------
-- Reservas (pruebas críticas 8 y 9)
-- ---------------------------------------------------------------------------

create temporary table res1 on commit drop as
select public.create_reservation(
  (select b1 from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select v_seguida from fx), 'quantity', 3)),
  jsonb_build_object('name', 'Clienta que reserva', 'phone', '999888777'),
  now() + interval '2 days',
  '20000000-0000-4000-8000-000000000001'::uuid,
  jsonb_build_object('method', 'yape', 'amount', 20.00, 'receivedAt', (now() - interval '30 days')::text)
) as detail;

select results_eq(
  $$ select on_hand, reserved, available_quantity from public.inventory_stock
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (16, 3, 13) $$,
  '38 · Una reserva mueve reserved y nunca on_hand'
);

select throws_ok(
  format($$ select public.create_reservation(%L::uuid,
      jsonb_build_array(jsonb_build_object('variantId', %L::uuid, 'quantity', 99)),
      jsonb_build_object('name', 'Clienta imposible'),
      now() + interval '1 day', gen_random_uuid()) $$,
    (select b1 from fx), (select v_seguida from fx)),
  '23514',
  null,
  '39 · No se reserva más de lo disponible'
);

-- Conversión: sin doble descuento de stock y sin doble conteo del adelanto.
create temporary table sale3 on commit drop as
select public.register_sale(
  (select b1 from fx),
  null,
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 25.00)),
  '10000000-0000-4000-8000-000000000003'::uuid,
  'in_store'::public.sale_source_channel,
  'pickup'::public.fulfillment_method,
  null, 0, null,
  ((select detail ->> 'id' from res1))::uuid
) as detail;

select results_eq(
  $$ select on_hand, reserved from public.inventory_stock
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (13, 0) $$,
  '40 · Convertir libera lo comprometido y descuenta la existencia una sola vez'
);

-- El adelanto conserva su received_at ORIGINAL: el arqueo cuenta el dinero el
-- día que entró, no el día de la conversión.
select is(
  (select date_trunc('day', p.received_at) = date_trunc('day', now() - interval '30 days')
   from public.sale_payments p
   where p.sale_id = ((select detail ->> 'id' from sale3))::uuid
     and p.method = 'reservation_advance'),
  true,
  '41 · El adelanto trasladado conserva la fecha en que entró el dinero'
);

select is(
  (select sum(p.amount) from public.sale_payments p
   where p.sale_id = ((select detail ->> 'id' from sale3))::uuid),
  45.00::numeric,
  '42 · Adelanto más saldo cubren el total exacto de la venta'
);

-- Cinturón y tirantes: el mismo adelanto no puede aplicarse a dos ventas.
select throws_ok(
  format($$ insert into public.sale_payments (sale_id, method, amount, applied_from_reservation_payment_id)
            select %L::uuid, 'reservation_advance', 1.00, rp.id
            from public.reservation_payments rp
            where rp.reservation_id = %L::uuid limit 1 $$,
    (select detail ->> 'id' from sale1), (select detail ->> 'id' from res1)),
  '23505',
  null,
  '43 · Un mismo adelanto no puede aplicarse a dos ventas'
);

select throws_ok(
  format($$ select public.register_sale(%L::uuid, null,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 45.00)),
      gen_random_uuid(), 'in_store'::public.sale_source_channel,
      'in_store'::public.fulfillment_method, null, 0, null, %L::uuid) $$,
    (select b1 from fx), (select detail ->> 'id' from res1)),
  '23514',
  null,
  '44 · Una reserva ya convertida no se convierte una segunda vez'
);

-- Vencimiento: libera reserved y no toca on_hand.
select public.create_reservation(
  b1,
  jsonb_build_array(jsonb_build_object('variantId', v_seguida, 'quantity', 2)),
  jsonb_build_object('name', 'Clienta que no vuelve'),
  now() + interval '1 second',
  '20000000-0000-4000-8000-000000000002'::uuid
) from fx;

update public.reservations set expires_at = now() - interval '1 hour'
where client_operation_id = '20000000-0000-4000-8000-000000000002';

select is(public.release_expired_reservations(), 1, '45 · El vencimiento masivo libera la reserva caduca');

select results_eq(
  $$ select on_hand, reserved from public.inventory_stock
     where variant_id = (select v_seguida from fx) and branch_id = (select b1 from fx) $$,
  $$ values (13, 0) $$,
  '46 · Vencer devuelve lo comprometido sin tocar la existencia física'
);

-- ---------------------------------------------------------------------------
-- La vendedora no ve costos ni márgenes
-- ---------------------------------------------------------------------------

-- Las tablas temporales del fixture pertenecen a postgres: para consultarlas
-- bajo el rol de la vendedora hay que abrirlas explícitamente.
grant select on fx, sale1 to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"d0000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.sale_line_costs),
  0,
  '47 · La vendedora obtiene cero filas de costos'
);

-- Y tampoco por el retorno del RPC, que corre como definer y no evalúa
-- políticas: el recorte por rol está escrito además en la lectura.
select is(
  (select count(*)::integer
   from jsonb_array_elements(public.sale_detail(((select detail ->> 'id' from sale1))::uuid) -> 'lines') l
   where l -> 'cost' is not null and jsonb_typeof(l -> 'cost') <> 'null'),
  0,
  '48 · El detalle que recibe la vendedora no trae el bloque de costo'
);

reset role;

-- ---------------------------------------------------------------------------
-- Los triggers diferidos, forzados
-- ---------------------------------------------------------------------------
-- Sin `set constraints all immediate` estas aserciones no probarían nada: los
-- triggers DEFERRABLE INITIALLY DEFERRED disparan al COMMIT, y este archivo
-- termina en ROLLBACK. Un defecto en ellos sería invisible para toda la
-- suite —lo fue, hasta que la prueba de concurrencia lo descubrió con sesiones
-- reales—.

select lives_ok(
  'set constraints all immediate',
  '49 · Las ventas registradas sobreviven a la validación diferida del cierre'
);

select throws_ok(
  format($$ insert into public.sale_payments (sale_id, method, amount)
            values (%L::uuid, 'yape', 1.00) $$,
    (select detail ->> 'id' from sale1)),
  '23514',
  null,
  '50 · Un pago de más rompe la igualdad exacta entre cobranza y total'
);

select * from finish();

rollback;
