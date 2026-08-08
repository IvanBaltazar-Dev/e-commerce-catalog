begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Una clienta llega por Instagram, arma su carrito en la web y la vendedora se
-- lo convierte en reserva. La pregunta que responde esta prueba es la de la
-- dueña: «¿de dónde llegó esa reserva?».

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f7000000-0000-4000-8000-000000000001','authenticated','authenticated','conv-attr-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('f7000000-0000-4000-8000-000000000001','admin','Propietaria de conversión');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CONVATTR', 'Sede de conversión', 'Lima', false, 947
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  'f7000000-0000-4000-8000-000000000001'::uuid as admin_id,
  (select id from public.product_variants where sku = 'DEMO-ESM-ROJO') as v1,
  (select id from public.branches where code = 'CONVATTR') as branch;

set local request.jwt.claims = '{"sub":"f7000000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.product_variants set tracks_inventory = true, availability_status = 'available'
where id = (select v1 from fx);

select public.apply_inventory_movement(v1, branch, 'initial_load', 20, 8.00,
  'test', null, 'fixture', 'existencia', admin_id) from fx;

-- ---------------------------------------------------------------------------
-- Estructura del enlace
-- ---------------------------------------------------------------------------

select has_function(
  'public', 'link_cart_conversion_attribution', array[]::text[],
  '1 · Existe la función que propaga el origen'
);

select is(
  (select count(*)::int from pg_trigger
   where tgrelid = 'public.public_carts'::regclass
     and tgname = 'public_carts_link_attribution'
     and not tgisinternal),
  1,
  '2 · El trigger está puesto sobre el carrito'
);

select isnt(
  (select tgenabled::text from pg_trigger
   where tgrelid = 'public.public_carts'::regclass and tgname = 'public_carts_link_attribution'),
  'D',
  '3 · El trigger está habilitado'
);

-- Candado de 0045: toda función DEFINER fija su search_path.
select ok(
  (select p.prosecdef and exists (
     select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'link_cart_conversion_attribution'),
  '4 · Es DEFINER con search_path fijado'
);

-- ---------------------------------------------------------------------------
-- El origen viaja del carrito a la reserva
-- ---------------------------------------------------------------------------

-- La visitante llega desde Instagram. Se replica lo que hace la app: al
-- aterrizar, /api/catalog/session registra el toque y ahí nace la cadena con
-- su first-touch. Ese es el origen que debe sobrevivir a todo lo demás.
create temporary table visitante on commit drop as
select public.touch_anonymous_visitor(null, '/?utm_source=instagram', 'https://l.instagram.com/') as id;

select public.record_attribution_touch(
  (select id from visitante), 'instagram', null,
  jsonb_build_object('utm_source', 'instagram'),
  'https://l.instagram.com/', '/?utm_source=instagram'
);

create temporary table carrito on commit drop as
select public.get_or_create_public_cart(null, (select id from visitante)) as detail;

update public.public_carts
set branch_id = (select branch from fx)
where public_token = (select detail ->> 'publicToken' from carrito);

select public.set_public_cart_item(
  (select detail ->> 'publicToken' from carrito), (select v1 from fx), 2, 1
);

select is(
  (select count(*)::int from public.channel_attributions
   where reservation_id = (select (detail ->> 'id')::uuid from carrito)),
  0,
  '5 · Antes de convertir no hay reserva atribuida'
);

-- La vendedora convierte el carrito en reserva.
create temporary table reserva on commit drop as
select public.convert_cart_to_reservation(
  (select detail ->> 'publicToken' from carrito),
  jsonb_build_object('name', 'Rosa Quispe', 'phone', '961223887'),
  now() + interval '3 days',
  gen_random_uuid(),
  null,
  null
) as detail;

select isnt(
  (select detail ->> 'id' from reserva),
  null,
  '6 · La reserva se creó desde el carrito'
);

select is(
  (select count(*)::int from public.channel_attributions
   where reservation_id = (select (detail ->> 'id')::uuid from reserva)),
  1,
  '7 · La reserva quedó atribuida al convertir'
);

-- Lo que de verdad importa: el canal de origen sobrevivió al traspaso.
select is(
  (select c.code
   from public.channel_attributions a
   join public.channels c on c.id = a.first_channel_id
   where a.reservation_id = (select (detail ->> 'id')::uuid from reserva)),
  'instagram',
  '8 · El origen real (Instagram) sobrevive a la conversión'
);

select is(
  (select a.cart_id
   from public.channel_attributions a
   where a.reservation_id = (select (detail ->> 'id')::uuid from reserva)),
  (select (detail ->> 'id')::uuid from carrito),
  '9 · La cadena conserva el carrito que la originó'
);

select is(
  (select a.anonymous_visitor_id
   from public.channel_attributions a
   where a.reservation_id = (select (detail ->> 'id')::uuid from reserva)),
  (select id from visitante),
  '10 · Y conserva a la visitante que empezó el recorrido'
);

-- ---------------------------------------------------------------------------
-- Un carrito de mostrador no inventa origen
-- ---------------------------------------------------------------------------
-- Sin visitante ni conversación no hay cadena: la ausencia de atribución ES la
-- respuesta («vino de la tienda»), y convertir no debe fallar por ello.

create temporary table carrito_mostrador on commit drop as
select public.get_or_create_public_cart(null, null) as detail;

update public.public_carts
set branch_id = (select branch from fx), anonymous_visitor_id = null
where public_token = (select detail ->> 'publicToken' from carrito_mostrador);

select public.set_public_cart_item(
  (select detail ->> 'publicToken' from carrito_mostrador), (select v1 from fx), 1, 1
);

create temporary table reserva_mostrador on commit drop as
select public.convert_cart_to_reservation(
  (select detail ->> 'publicToken' from carrito_mostrador),
  jsonb_build_object('name', 'Clienta de mostrador', 'phone', '999000111'),
  now() + interval '3 days',
  gen_random_uuid(),
  null,
  null
) as detail;

select isnt(
  (select detail ->> 'id' from reserva_mostrador),
  null,
  '11 · El carrito sin origen también se convierte, sin fallar'
);

select is(
  (select count(*)::int from public.channel_attributions
   where reservation_id = (select (detail ->> 'id')::uuid from reserva_mostrador)),
  0,
  '12 · Y no se le inventa un origen que no tuvo'
);

-- ---------------------------------------------------------------------------
-- Visitante sin toque previo: la cadena se abre con el canal REAL del carrito
-- ---------------------------------------------------------------------------
-- Antes caía en «manual», que no dice nada. Si el recorrido nace al convertir,
-- al menos debe registrar por dónde entró.

create temporary table visitante_directa on commit drop as
select public.touch_anonymous_visitor(null, '/seleccion', null) as id;

create temporary table carrito_web on commit drop as
select public.get_or_create_public_cart(null, (select id from visitante_directa)) as detail;

update public.public_carts
set branch_id = (select branch from fx)
where public_token = (select detail ->> 'publicToken' from carrito_web);

select public.set_public_cart_item(
  (select detail ->> 'publicToken' from carrito_web), (select v1 from fx), 1, 1
);

create temporary table reserva_web on commit drop as
select public.convert_cart_to_reservation(
  (select detail ->> 'publicToken' from carrito_web),
  jsonb_build_object('name', 'Clienta directa', 'phone', '988777666'),
  now() + interval '3 days',
  gen_random_uuid(),
  null,
  null
) as detail;

select is(
  (select c.code
   from public.channel_attributions a
   join public.channels c on c.id = a.first_channel_id
   where a.reservation_id = (select (detail ->> 'id')::uuid from reserva_web)),
  (select c.code
   from public.public_carts pc
   join public.channels c on c.id = pc.channel_id
   where pc.public_token = (select detail ->> 'publicToken' from carrito_web)),
  '13 · Sin toque previo, la cadena nace con el canal real del carrito'
);

select * from finish();
rollback;
