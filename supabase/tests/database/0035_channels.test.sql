begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','b3000000-0000-4000-8000-000000000001','authenticated','authenticated','ch-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','b3000000-0000-4000-8000-000000000002','authenticated','authenticated','ch-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('b3000000-0000-4000-8000-000000000001','admin','Propietaria de canales'),
  ('b3000000-0000-4000-8000-000000000002','seller','Vendedora de canales');

create temporary table fx on commit drop as
select
  'b3000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'b3000000-0000-4000-8000-000000000002'::uuid as seller_id,
  (select id from public.channel_accounts where external_account_id = 'web-public') as web_account,
  (select id from public.channels where code = 'whatsapp') as whatsapp_channel;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_id, (select id from public.branches where is_default and is_active), true from fx;

set local request.jwt.claims = '{"sub":"b3000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- Estructura y datos de referencia
-- ---------------------------------------------------------------------------

select has_table('public', 'persons', '1 · Existe la persona');
select has_table('public', 'anonymous_visitors', '2 · Existe el visitante anónimo');
select has_table('public', 'visitor_identity_links', '3 · Existe la historia de vinculación');
select has_table('public', 'channels', '4 · Existen los canales');
select has_table('public', 'channel_accounts', '5 · Existen las cuentas de canal');
select has_table('public', 'channel_contacts', '6 · Existen los contactos de canal');

-- Canal como DATO, no como enum: los siete del plan sembrados y extensibles.
select is(
  (select count(*)::integer from public.channels
   where code in ('web','whatsapp','facebook','instagram','tiktok','store','manual')),
  7,
  '7 · Los siete canales del plan quedan sembrados'
);

-- (sale_source_channel de 0029 sigue existiendo y es legítimo: clasifica la
-- VENTA. Lo que no puede ser enum es la tabla de canales misma.)
select is(
  (select count(*)::integer from information_schema.columns c
   join pg_type t on t.typname = c.udt_name
   where c.table_schema = 'public' and c.table_name = 'channels'
     and t.typtype = 'e'),
  0,
  '8 · Ninguna columna de channels es un enum: un canal nuevo es un INSERT, no una migración'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('link_visitor_to_person', 'ensure_person_for_phone', 'ensure_channel_contact')),
  false,
  '9 · Los contratos de identidad no son alcanzables por anon'
);

select is(
  has_function_privilege('anon', 'public.touch_anonymous_visitor(uuid, text, text)', 'execute'),
  true,
  '10 · La única superficie pública es la identidad anónima'
);

-- ---------------------------------------------------------------------------
-- Normalización de teléfono
-- ---------------------------------------------------------------------------

select is(public.normalize_phone('+51 999 888 777'), '51999888777', '11 · Un +51 con espacios normaliza');
select is(public.normalize_phone('999888777'), '51999888777', '12 · Un móvil de nueve dígitos se prefija con 51');
select is(public.normalize_phone('abc'), null, '13 · Sin dígitos suficientes no se inventa una clave');

-- ---------------------------------------------------------------------------
-- Identidad anónima
-- ---------------------------------------------------------------------------

create temporary table visitor1 on commit drop as
select public.touch_anonymous_visitor(null, '/producto/gel', 'https://instagram.com') as id;

select is(
  (select first_landing_path from public.anonymous_visitors where id = (select id from visitor1)),
  '/producto/gel',
  '14 · La primera visita captura su aterrizaje'
);

select is(
  public.touch_anonymous_visitor((select id from visitor1)),
  (select id from visitor1),
  '15 · La cookie válida conserva la identidad'
);

select is(
  (select visits from public.anonymous_visitors where id = (select id from visitor1)),
  2,
  '16 · Y la visita se acumula'
);

-- Cookie huérfana: base reiniciada. Se emite identidad nueva, no un error.
select isnt(
  public.touch_anonymous_visitor('00000000-0000-4000-8000-00000000dead'::uuid),
  '00000000-0000-4000-8000-00000000dead'::uuid,
  '17 · Una cookie huérfana recibe identidad nueva en lugar de romper la visita'
);

-- ---------------------------------------------------------------------------
-- Persona por teléfono: idempotente y sin fusión por nombre
-- ---------------------------------------------------------------------------

select is(
  public.ensure_person_for_phone('+51 999 888 777', 'María'),
  public.ensure_person_for_phone('999888777', 'MARIA DISTINTA'),
  '18 · El mismo número converge en la misma persona aunque el nombre cambie'
);

select isnt(
  public.ensure_person_for_phone('987654321', 'María'),
  public.ensure_person_for_phone('999888777', 'María'),
  '19 · Y el mismo nombre con otro número NUNCA fusiona: son dos personas'
);

-- ---------------------------------------------------------------------------
-- Contacto de canal: idempotencia por identidad externa
-- ---------------------------------------------------------------------------

create temporary table contact1 on commit drop as
select public.ensure_channel_contact(
  (select web_account from fx), 'visitor-abc', 'Visitante web'
) as id;

select is(
  public.ensure_channel_contact((select web_account from fx), 'visitor-abc', 'Visitante web renombrado'),
  (select id from contact1),
  '20 · El mismo contacto externo converge en la misma fila'
);

select is(
  (select count(*)::integer from public.channel_contacts
   where channel_account_id = (select web_account from fx) and external_contact_id = 'visitor-abc'),
  1,
  '21 · Sin duplicados'
);

-- El teléfono de WhatsApp SÍ vincula persona; y una segunda ingesta no la
-- sobrescribe.
insert into public.channel_accounts (channel_id, display_name, external_account_id)
select whatsapp_channel, 'WhatsApp de prueba', 'wa-test' from fx;

create temporary table wa_contact on commit drop as
select public.ensure_channel_contact(
  (select id from public.channel_accounts where external_account_id = 'wa-test'),
  '51999888777', 'María', '+51 999 888 777'
) as id;

select is(
  (select p.phone_normalized from public.channel_contacts c
   join public.persons p on p.id = c.person_id
   where c.id = (select id from wa_contact)),
  '51999888777',
  '22 · Un contacto de WhatsApp queda vinculado a su persona por el número'
);

-- ---------------------------------------------------------------------------
-- Vinculación de visitante: histórica y con motivo
-- ---------------------------------------------------------------------------

select lives_ok(
  format($$ select public.link_visitor_to_person(%L::uuid, %L::uuid, 'Se identificó al pagar') $$,
    (select id from visitor1),
    (select person_id from public.channel_contacts where id = (select id from wa_contact))),
  '23 · La vinculación con motivo procede'
);

select is(
  (select count(*)::integer from public.visitor_identity_links
   where anonymous_visitor_id = (select id from visitor1)),
  1,
  '24 · Y deja su fila de historia con actor y motivo'
);

select throws_ok(
  format($$ update public.visitor_identity_links set reason = 'reescrito' where anonymous_visitor_id = %L::uuid $$,
    (select id from visitor1)),
  null, null,
  '25 · La historia de vinculación no admite reescritura'
);

-- ---------------------------------------------------------------------------
-- La vendedora no enumera contactos
-- ---------------------------------------------------------------------------

grant select on fx to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b3000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.channel_contacts),
  0,
  '26 · La vendedora obtiene cero contactos en bloque: 0036 la abre por conversación'
);

reset role;

select * from finish();

rollback;
