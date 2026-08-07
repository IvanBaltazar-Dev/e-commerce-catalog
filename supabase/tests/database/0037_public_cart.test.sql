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
  ('00000000-0000-0000-0000-000000000000','d5000000-0000-4000-8000-000000000001','authenticated','authenticated','cart-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','d5000000-0000-4000-8000-000000000002','authenticated','authenticated','cart-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('d5000000-0000-4000-8000-000000000001','admin','Propietaria de carritos'),
  ('d5000000-0000-4000-8000-000000000002','seller','Vendedora de carritos');

create temporary table fx on commit drop as
select
  'd5000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'd5000000-0000-4000-8000-000000000002'::uuid as seller_id,
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO') as v1,
  (select id from public.product_variants where sku = 'DEMO-ESM-NUDE') as v2,
  (select id from public.branches where is_default and is_active) as main_branch;

set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Existencias para la conversión: la vendedora convierte contra stock real.
update public.product_variants set tracks_inventory = true, availability_status = 'available'
where id = (select v1 from fx);
select public.apply_inventory_movement(v1, main_branch, 'initial_load', 20, 8.00,
  'test', null, 'fixture', 'existencia', admin_id) from fx;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, main_branch, true from fx;

-- ---------------------------------------------------------------------------
-- Estructura y superficie
-- ---------------------------------------------------------------------------

select has_table('public', 'public_carts', '1 · Existe el carrito persistente');
select has_table('public', 'public_cart_items', '2 · Existen sus líneas');

select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'public_cart_items'
     and column_name in ('unit_price', 'subtotal', 'price')),
  0,
  '3 · El carrito NO guarda precio: cada lectura reevalúa'
);

-- anon no toca las tablas: su superficie completa son las funciones por token.
select is(
  has_table_privilege('anon', 'public.public_carts', 'select')
    or has_table_privilege('anon', 'public.public_cart_items', 'select'),
  false,
  '4 · anon no tiene un solo grant de tabla'
);

select is(
  (select bool_and(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('get_or_create_public_cart', 'public_cart_detail',
                       'set_public_cart_item', 'sync_public_cart')),
  true,
  '5 · Y las cuatro funciones públicas sí le responden'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('convert_cart_to_sale', 'convert_cart_to_reservation',
                       'link_cart_to_conversation', 'expire_public_carts', 'mark_abandoned_carts')),
  false,
  '6 · Convertir, enlazar y expirar NO son públicos'
);

-- ---------------------------------------------------------------------------
-- Creación y token
-- ---------------------------------------------------------------------------

create temporary table visitor1 on commit drop as
select public.touch_anonymous_visitor(null, '/seleccion', null) as id;

create temporary table cart1 on commit drop as
select public.get_or_create_public_cart(null, (select id from visitor1)) as detail;

select is(
  length((select detail ->> 'publicToken' from cart1)),
  64,
  '7 · El token es opaco: 64 hex aleatorios, nada secuencial'
);

select is(
  (select public.get_or_create_public_cart(null, (select id from visitor1)) ->> 'id'),
  (select detail ->> 'id' from cart1),
  '8 · Dos pestañas del mismo visitante convergen en un carrito'
);

-- ---------------------------------------------------------------------------
-- Mutación con versión declarada
-- ---------------------------------------------------------------------------

create temporary table after_item on commit drop as
select public.set_public_cart_item(
  (select detail ->> 'publicToken' from cart1), (select v1 from fx), 3, 1
) as detail;

select is(
  (select (detail ->> 'rowVersion')::integer from after_item),
  2,
  '9 · La mutación avanza la versión'
);

select throws_ok(
  format($$ select public.set_public_cart_item(%L, %L::uuid, 5, 1) $$,
    (select detail ->> 'publicToken' from cart1), (select v1 from fx)),
  'P0409', null,
  '10 · La versión vieja produce conflicto explícito, no last-write-wins'
);

select is(
  (select i.quantity from public.public_cart_items i
   join public.public_carts c on c.id = i.cart_id
   where c.public_token = (select detail ->> 'publicToken' from cart1)),
  3,
  '11 · Y la cantidad del primer escritor sobrevive intacta'
);

-- La evaluación viene del motor comercial, no de columnas del carrito.
select is(
  (select (detail -> 'evaluation' -> 'lines' -> 0 ->> 'unitPrice')::numeric from after_item),
  15.00::numeric,
  '12 · El precio nace de evaluate_cart_v2 en el momento de leer'
);

select is(
  public.set_public_cart_item((select detail ->> 'publicToken' from cart1), (select v1 from fx), 0, 2)
    -> 'evaluation' ->> 'totalUnits',
  '0',
  '13 · Cantidad cero retira la línea'
);

-- ---------------------------------------------------------------------------
-- Sincronización desde localStorage
-- ---------------------------------------------------------------------------

create temporary table synced on commit drop as
select public.sync_public_cart(
  (select detail ->> 'publicToken' from cart1),
  jsonb_build_array(
    jsonb_build_object('variantId', (select v1 from fx), 'quantity', 2),
    jsonb_build_object('variantId', (select v2 from fx), 'quantity', 1),
    jsonb_build_object('variantId', '00000000-0000-4000-8000-00000000dead', 'quantity', 9)
  )
) as detail;

select is(
  (select (detail -> 'evaluation' ->> 'totalUnits')::integer from synced),
  3,
  '14 · La sincronización incorpora lo vigente e ignora la historia muerta'
);

select public.set_public_cart_item(
  (select detail ->> 'publicToken' from cart1), (select v1 from fx), 5,
  (select (detail ->> 'rowVersion')::integer from synced)
) from fx;

create temporary table resynced on commit drop as
select public.sync_public_cart(
  (select detail ->> 'publicToken' from cart1),
  jsonb_build_array(jsonb_build_object('variantId', (select v1 from fx), 'quantity', 2))
) as detail;

select is(
  (select i.quantity from public.public_cart_items i
   join public.public_carts c on c.id = i.cart_id
   where c.public_token = (select detail ->> 'publicToken' from cart1)
     and i.variant_id = (select v1 from fx)),
  5,
  '15 · La fusión es determinista: gana la cantidad mayor, nunca el precio local'
);

-- ---------------------------------------------------------------------------
-- Recuperación entre dispositivos
-- ---------------------------------------------------------------------------

create temporary table visitor2 on commit drop as
select public.touch_anonymous_visitor(null, '/seleccion', null) as id;

create temporary table recovered on commit drop as
select public.get_or_create_public_cart(
  (select detail ->> 'publicToken' from cart1),
  (select id from visitor2)
) as detail;

select is(
  (select detail ->> 'id' from recovered),
  (select detail ->> 'id' from cart1),
  '16 · El token recupera el MISMO carrito en otro dispositivo'
);

select is(
  (select (detail -> 'evaluation' ->> 'totalUnits')::integer from recovered),
  6,
  '17 · Con sus líneas y cantidades'
);

-- ---------------------------------------------------------------------------
-- Conversión: envuelve al Bloque 2
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000002","role":"authenticated"}';

-- Se deja solo la variante con stock para una conversión limpia.
select public.set_public_cart_item((select detail ->> 'publicToken' from cart1), (select v2 from fx), 0) from fx;

create temporary table conversion on commit drop as
select public.convert_cart_to_sale(
  (select detail ->> 'publicToken' from cart1),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 75.00)),
  'e7000000-0000-4000-8000-000000000001'::uuid,
  'pickup'::public.fulfillment_method,
  jsonb_build_object('name', 'Clienta del carrito')
) as sale;

select is(
  (select (sale ->> 'total')::numeric from conversion),
  75.00::numeric,
  '18 · La conversión cobra el precio que resolvió PostgreSQL: 5 × 15,00'
);

select is(
  (select sale ->> 'sourceChannel' from conversion),
  'web',
  '19 · La venta conserva el canal de origen del carrito'
);

select is(
  (select on_hand from public.inventory_stock
   where variant_id = (select v1 from fx) and branch_id = (select main_branch from fx)),
  15,
  '20 · Y el inventario bajó por el motor del Bloque 2, no por el carrito'
);

select is(
  (select c.status from public.public_carts c
   where c.public_token = (select detail ->> 'publicToken' from cart1)),
  'converted'::public.cart_status,
  '21 · El carrito queda convertido y apuntando a su venta'
);

-- El doble clic: mismo token, misma operación → la MISMA venta.
select is(
  (select public.convert_cart_to_sale(
     (select detail ->> 'publicToken' from cart1),
     jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 75.00)),
     'e7000000-0000-4000-8000-000000000002'::uuid
   ) ->> 'id'),
  (select sale ->> 'id' from conversion),
  '22 · Reintentar la conversión devuelve la misma venta, nunca dos'
);

select is(
  (select count(*)::integer from public.sales
   where branch_id = (select main_branch from fx)
     and source_reference = 'cart:' || (select detail ->> 'publicToken' from cart1)),
  1,
  '23 · Una sola venta en la base'
);

-- Un carrito convertido no admite más cambios.
select throws_ok(
  format($$ select public.set_public_cart_item(%L, %L::uuid, 1) $$,
    (select detail ->> 'publicToken' from cart1), (select v1 from fx)),
  '23514', null,
  '24 · Un carrito convertido es de solo lectura'
);

-- ---------------------------------------------------------------------------
-- Abandono y expiración
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table cart2 on commit drop as
select public.get_or_create_public_cart(null, null) as detail;

select public.set_public_cart_item((select detail ->> 'publicToken' from cart2), (select v1 from fx), 1) from fx;

update public.public_carts
set last_activity_at = now() - interval '4 days'
where public_token = (select detail ->> 'publicToken' from cart2);

select is(public.mark_abandoned_carts(interval '72 hours'), 1,
  '25 · La inactividad marca abandono, no borra nada');

select is(
  (select public.get_or_create_public_cart((select detail ->> 'publicToken' from cart2)) ->> 'status'),
  'active',
  '26 · Y la clienta que vuelve revive su carrito'
);

update public.public_carts
set expires_at = now() - interval '1 hour'
where public_token = (select detail ->> 'publicToken' from cart2);

select is(public.expire_public_carts(), 1, '27 · El vencimiento expira el carrito');

select isnt(
  (select public.get_or_create_public_cart((select detail ->> 'publicToken' from cart2)) ->> 'id'),
  (select detail ->> 'id' from cart2),
  '28 · Un token vencido recibe carrito nuevo: el viejo queda para métricas'
);

-- ---------------------------------------------------------------------------
-- RLS del personal
-- ---------------------------------------------------------------------------

grant select on fx, cart1 to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer > 0 from public.public_carts
   where branch_id = (select main_branch from fx)),
  true,
  '29 · La vendedora ve los carritos de su sede para la bandeja'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000ff","role":"authenticated"}';

select is(
  (select count(*)::integer from public.public_carts),
  0,
  '30 · Un perfil sin sedes no ve ninguno'
);

reset role;

select * from finish();

rollback;
