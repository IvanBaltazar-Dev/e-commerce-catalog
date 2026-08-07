begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','e6000000-0000-4000-8000-000000000001','authenticated','authenticated','attr-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','e6000000-0000-4000-8000-000000000002','authenticated','authenticated','attr-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('e6000000-0000-4000-8000-000000000001','admin','Propietaria de atribución'),
  ('e6000000-0000-4000-8000-000000000002','seller','Vendedora de atribución');

set local request.jwt.claims = '{"sub":"e6000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into public.marketing_campaigns (source_id, channel_id, name, code)
select s.id, c.id, 'Vitrina de agosto', 'vitrina-agosto'
from public.marketing_sources s, public.channels c
where s.code = 'instagram' and c.code = 'instagram';

create temporary table fx on commit drop as
select
  'e6000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'e6000000-0000-4000-8000-000000000002'::uuid as seller_id,
  public.touch_anonymous_visitor(null, '/', 'https://l.instagram.com/') as visitor_id,
  (select id from public.marketing_campaigns where code = 'vitrina-agosto') as campaign_id;

-- ---------------------------------------------------------------------------
-- Estructura y referencia
-- ---------------------------------------------------------------------------

select has_table('public', 'marketing_sources', '1 · Existen las fuentes');
select has_table('public', 'marketing_campaigns', '2 · Existen las campañas');
select has_table('public', 'channel_attributions', '3 · Existe la cadena de atribución');

select is(
  (select count(*)::integer from public.marketing_sources
   where code in ('organic','direct','whatsapp','instagram','facebook','tiktok','referral','qr','paid','unknown')),
  10,
  '4 · Las diez fuentes del plan quedan sembradas'
);

select is(
  has_function_privilege('anon', 'public.record_attribution_touch(uuid, text, text, jsonb, text, text)', 'execute'),
  true,
  '5 · El toque de atribución es la superficie pública'
);

select is(
  has_function_privilege('anon', 'public.attach_attribution(uuid, uuid, uuid, uuid, uuid, uuid, text)', 'execute'),
  false,
  '6 · Enlazar la cadena NO es público'
);

-- ---------------------------------------------------------------------------
-- Primer toque: campaña de Instagram (y el QR usa el MISMO pipeline)
-- ---------------------------------------------------------------------------

create temporary table touch1 on commit drop as
select public.record_attribution_touch(
  (select visitor_id from fx), 'instagram', 'vitrina-agosto',
  '{"utm_medium": "social", "utm_content": "reel-01"}'::jsonb,
  'https://l.instagram.com/', '/producto/gel-rojo'
) as id;

select is(
  (select s.code from public.channel_attributions a
   join public.marketing_sources s on s.id = a.first_source_id
   where a.id = (select id from touch1)),
  'instagram',
  '7 · El primer toque congela la fuente'
);

select is(
  (select a.first_campaign_id from public.channel_attributions a where a.id = (select id from touch1)),
  (select campaign_id from fx),
  '8 · Y la campaña resuelta por su código'
);

-- ---------------------------------------------------------------------------
-- Multicanal: Facebook primero, WhatsApp después (prueba 40 del plan)
-- ---------------------------------------------------------------------------

create temporary table journey on commit drop as
select
  public.touch_anonymous_visitor(null, '/', 'https://facebook.com/') as visitor_id;

select public.record_attribution_touch(
  (select visitor_id from journey), 'facebook', null, '{}'::jsonb, 'https://facebook.com/', '/'
) from journey;

create temporary table touch2 on commit drop as
select public.record_attribution_touch(
  (select visitor_id from journey), 'whatsapp', null, '{}'::jsonb, null, '/seleccion'
) as id;

select results_eq(
  format($$ select fs.code, ls.code
     from public.channel_attributions a
     join public.marketing_sources fs on fs.id = a.first_source_id
     join public.marketing_sources ls on ls.id = a.last_source_id
     where a.id = %L::uuid $$, (select id from touch2)),
  $$ values ('facebook', 'whatsapp') $$,
  '9 · first_touch = Facebook, last_touch = WhatsApp: nada se sobrescribe'
);

select is(
  (select count(*)::integer from public.channel_attributions
   where anonymous_visitor_id = (select visitor_id from journey)),
  1,
  '10 · Dos toques, UNA cadena abierta'
);

-- La inmutabilidad del primer toque la impone la base, no la convención.
select throws_ok(
  format($$ update public.channel_attributions
            set first_source_id = (select id from public.marketing_sources where code = 'whatsapp')
            where id = %L::uuid $$, (select id from touch2)),
  '23514', null,
  '11 · Reescribir el primer toque muere con error explícito'
);

-- Fuente inexistente: unknown, jamás inventada. La llamada va en sentencia
-- APARTE: dentro del mismo SELECT, el UPDATE de la función no es visible para
-- el snapshot que lo lee.
create temporary table touch_unknown on commit drop as
select public.record_attribution_touch((select visitor_id from journey), 'red-inventada') as id;

select is(
  (select s.code from public.channel_attributions a
   join public.marketing_sources s on s.id = a.last_source_id
   where a.id = (select id from touch_unknown)),
  'unknown',
  '12 · Una fuente desconocida cae a unknown'
);

-- ---------------------------------------------------------------------------
-- La cadena se enlaza y se cierra con su venta
-- ---------------------------------------------------------------------------

create temporary table cart1 on commit drop as
select public.get_or_create_public_cart(null, (select visitor_id from journey)) as detail;

select public.attach_attribution(
  p_visitor_id => (select visitor_id from journey),
  p_cart_id => ((select detail ->> 'id' from cart1))::uuid
) from journey;

select is(
  (select a.cart_id from public.channel_attributions a
   where a.anonymous_visitor_id = (select visitor_id from journey) and a.sale_id is null),
  ((select detail ->> 'id' from cart1))::uuid,
  '13 · El carrito queda enlazado a la cadena'
);

-- Enlazar el mismo carrito otra vez es idempotente; otro carrito, rechazado.
select lives_ok(
  format($$ select public.attach_attribution(p_visitor_id => %L::uuid, p_cart_id => %L::uuid) $$,
    (select visitor_id from journey), (select detail ->> 'id' from cart1)),
  '14 · Reenlazar el mismo eslabón es idempotente'
);

-- Venta real mínima para cerrar la cadena.
update public.product_variants set tracks_inventory = false
where sku = 'DEMO-ESM-NUDE';

create temporary table sale1 on commit drop as
select public.register_sale(
  (select id from public.branches where is_default and is_active),
  jsonb_build_array(jsonb_build_object(
    'variantId', (select id from public.product_variants where sku = 'DEMO-ESM-NUDE'),
    'quantity', 1)),
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 15.00)),
  gen_random_uuid()
) as detail;

select public.attach_attribution(
  p_visitor_id => (select visitor_id from journey),
  p_sale_id => ((select detail ->> 'id' from sale1))::uuid
) from journey;

select is(
  (select a.sale_id from public.channel_attributions a
   where a.anonymous_visitor_id = (select visitor_id from journey)
   order by a.created_at desc limit 1),
  ((select detail ->> 'id' from sale1))::uuid,
  '15 · La venta cierra el recorrido'
);

select throws_ok(
  format($$ update public.channel_attributions set sale_id = null
            where sale_id = %L::uuid $$, (select detail ->> 'id' from sale1)),
  '23514', null,
  '16 · Una atribución ligada a una venta no se reasigna'
);

-- Cerrada la cadena, el siguiente toque abre OTRA: la segunda compra no hereda
-- la campaña de la primera.
create temporary table touch3 on commit drop as
select public.record_attribution_touch(
  (select visitor_id from journey), 'tiktok', null
) as id;

select isnt(
  (select id from touch3),
  (select id from touch2),
  '17 · El recorrido siguiente es una cadena nueva'
);

select is(
  (select s.code from public.channel_attributions a
   join public.marketing_sources s on s.id = a.first_source_id
   where a.id = (select id from touch3)),
  'tiktok',
  '18 · Con su propio primer toque'
);

-- Recorrido que nace fuera de la web: WhatsApp directo, sin visita previa.
insert into public.channel_accounts (channel_id, display_name, external_account_id)
select id, 'WhatsApp atribución', 'wa-attr' from public.channels where code = 'whatsapp';

create temporary table wa_contact on commit drop as
select public.ensure_channel_contact(
  (select id from public.channel_accounts where external_account_id = 'wa-attr'),
  '51911222333', 'Clienta directa', '+51 911 222 333'
) as id;

create temporary table wa_attr on commit drop as
select public.attach_attribution(
  p_contact_id => (select id from wa_contact),
  p_source_code => 'whatsapp'
) as id;

select is(
  (select s.code from public.channel_attributions a
   join public.marketing_sources s on s.id = a.first_source_id
   where a.id = (select id from wa_attr)),
  'whatsapp',
  '19 · Un recorrido que nace en WhatsApp abre su cadena con esa fuente'
);

-- ---------------------------------------------------------------------------
-- La vendedora no lee inteligencia comercial
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"e6000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.channel_attributions),
  0,
  '20 · La atribución es administrativa: la vendedora obtiene cero filas'
);

reset role;

select * from finish();

rollback;
