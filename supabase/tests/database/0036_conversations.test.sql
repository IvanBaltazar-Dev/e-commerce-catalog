begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------------------
-- Fixtures: dos sedes, una vendedora por sede, una cuenta de WhatsApp por sede.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-000000000001','authenticated','authenticated','conv-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-000000000002','authenticated','authenticated','conv-seller1@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','c4000000-0000-4000-8000-000000000003','authenticated','authenticated','conv-seller2@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('c4000000-0000-4000-8000-000000000001','admin','Propietaria de conversaciones'),
  ('c4000000-0000-4000-8000-000000000002','seller','Vendedora sede A'),
  ('c4000000-0000-4000-8000-000000000003','seller','Vendedora sede B');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CONVA', 'Sede conversaciones A', 'Lima', false, 905 from public.companies c limit 1;
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CONVB', 'Sede conversaciones B', 'Lima', false, 906 from public.companies c limit 1;

insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select ch.id, b.id, 'WhatsApp sede A', 'wa-conv-a'
from public.channels ch, public.branches b where ch.code = 'whatsapp' and b.code = 'CONVA';

insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select ch.id, b.id, 'WhatsApp sede B', 'wa-conv-b'
from public.channels ch, public.branches b where ch.code = 'whatsapp' and b.code = 'CONVB';

create temporary table fx on commit drop as
select
  'c4000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'c4000000-0000-4000-8000-000000000002'::uuid as seller_a,
  'c4000000-0000-4000-8000-000000000003'::uuid as seller_b,
  (select id from public.branches where code = 'CONVA') as branch_a,
  (select id from public.branches where code = 'CONVB') as branch_b,
  (select id from public.channel_accounts where external_account_id = 'wa-conv-a') as account_a,
  (select id from public.channel_accounts where external_account_id = 'wa-conv-b') as account_b;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_a, branch_a, true from fx;
insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller_b, branch_b, true from fx;

set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'channel_conversations', '1 · Existe la conversación');
select has_table('public', 'channel_messages', '2 · Existe el mensaje normalizado');
select has_table('public', 'channel_events', '3 · Existe el libro de eventos');

select hasnt_table('public', 'whatsapp_messages', '4 · No existe tabla de mensajes por proveedor');
select hasnt_table('public', 'instagram_messages', '5 · La diferencia vive en adaptadores, no en el modelo');

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('ensure_conversation', 'ingest_channel_message',
                       'mark_message_status', 'close_conversation', 'record_channel_event')),
  false,
  '6 · Ningún contrato de conversación es alcanzable por anon'
);

-- ---------------------------------------------------------------------------
-- Ingesta idempotente
-- ---------------------------------------------------------------------------

create temporary table msg1 on commit drop as
select public.ingest_channel_message(
  (select account_a from fx), '51999888777', 'inbound',
  'Hola, ¿tienen el gel rojo?', 'text', 'wamid-001',
  'María', '+51 999 888 777'
) as result;

select is(
  (select (result ->> 'created')::boolean from msg1),
  true,
  '7 · El primer webhook crea el mensaje'
);

-- El webhook repetido —Meta reenvía ante cualquier timeout— converge.
create temporary table msg1_retry on commit drop as
select public.ingest_channel_message(
  (select account_a from fx), '51999888777', 'inbound',
  'Hola, ¿tienen el gel rojo?', 'text', 'wamid-001',
  'María', '+51 999 888 777'
) as result;

select is(
  (select (result ->> 'created')::boolean from msg1_retry),
  false,
  '8 · El webhook repetido no crea nada'
);

select is(
  (select r1.result ->> 'messageId' from msg1 r1),
  (select r2.result ->> 'messageId' from msg1_retry r2),
  '9 · Y devuelve exactamente el mismo mensaje'
);

select is(
  (select count(*)::integer from public.channel_messages
   where external_message_id = 'wamid-001'),
  1,
  '10 · Un solo mensaje en la base'
);

-- Un segundo mensaje del mismo contacto entra a la MISMA conversación.
create temporary table msg2 on commit drop as
select public.ingest_channel_message(
  (select account_a from fx), '51999888777', 'inbound',
  '¿Y en tono nude?', 'text', 'wamid-002',
  'María', '+51 999 888 777', null, null, 'wamid-001'
) as result;

select is(
  (select r2.result ->> 'conversationId' from msg2 r2),
  (select r1.result ->> 'conversationId' from msg1 r1),
  '11 · El mismo contacto conversa en un solo hilo'
);

select is(
  (select m2.reply_to_message_id from public.channel_messages m2
   where m2.external_message_id = 'wamid-002'),
  (select m1.id from public.channel_messages m1
   where m1.external_message_id = 'wamid-001'),
  '12 · La respuesta enlaza al mensaje citado'
);

-- La persona quedó vinculada por el número: identidad natural de WhatsApp.
select is(
  (select p.phone_normalized
   from public.channel_messages m
   join public.channel_conversations c on c.id = m.conversation_id
   join public.channel_contacts ct on ct.id = c.channel_contact_id
   join public.persons p on p.id = ct.person_id
   where m.external_message_id = 'wamid-001'),
  '51999888777',
  '13 · La conversación llega con su persona resuelta'
);

-- La unicidad de conversación viva es un ÍNDICE, no una convención.
select throws_ok(
  format($$ insert into public.channel_conversations (channel_account_id, channel_contact_id, branch_id)
            select c.channel_account_id, c.channel_contact_id, c.branch_id
            from public.channel_conversations c where c.id = %L::uuid $$,
    (select result ->> 'conversationId' from msg1)),
  '23505', null,
  '14 · Una segunda conversación viva del mismo contacto muere contra el índice'
);

-- ---------------------------------------------------------------------------
-- Ciclo de entrega monotónico
-- ---------------------------------------------------------------------------

select is(
  public.mark_message_status((select account_a from fx), 'wamid-001', 'read'),
  true,
  '15 · El acuse de lectura avanza el estado'
);

select is(
  public.mark_message_status((select account_a from fx), 'wamid-001', 'delivered'),
  false,
  '16 · Un delivered tardío NO degrada un read ya registrado'
);

select is(
  (select status from public.channel_messages where external_message_id = 'wamid-001'),
  'read'::public.message_delivery_status,
  '17 · El estado queda en el máximo alcanzado'
);

-- ---------------------------------------------------------------------------
-- Inmutabilidad
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.channel_messages set body = 'texto reescrito' where external_message_id = 'wamid-001' $$,
  '23514', null,
  '18 · El cuerpo de un mensaje no se reescribe jamás'
);

select throws_ok(
  $$ update public.channel_events set event_type = 'falsificado' where id = (select min(id) from public.channel_events) $$,
  null, null,
  '19 · El libro de eventos no admite reescritura'
);

-- ---------------------------------------------------------------------------
-- Cierre condicional y reapertura por unicidad parcial
-- ---------------------------------------------------------------------------

select lives_ok(
  format($$ select public.close_conversation(%L::uuid, 'Atendida') $$,
    (select result ->> 'conversationId' from msg1)),
  '20 · El cierre con motivo procede'
);

select throws_ok(
  format($$ select public.close_conversation(%L::uuid, 'Segundo cierre') $$,
    (select result ->> 'conversationId' from msg1)),
  '23514', null,
  '21 · El segundo cierre se rechaza: la transición es condicional'
);

-- Cerrada la anterior, el siguiente mensaje abre conversación NUEVA.
create temporary table msg3 on commit drop as
select public.ingest_channel_message(
  (select account_a from fx), '51999888777', 'inbound',
  'Volví, ¿siguen abiertos?', 'text', 'wamid-003',
  'María', '+51 999 888 777'
) as result;

select isnt(
  (select r3.result ->> 'conversationId' from msg3 r3),
  (select r1.result ->> 'conversationId' from msg1 r1),
  '22 · Tras el cierre, el contacto abre un hilo nuevo'
);

-- ---------------------------------------------------------------------------
-- RLS: sede y asignación
-- ---------------------------------------------------------------------------

-- Una conversación en la sede B, asignada a la vendedora B.
select public.ingest_channel_message(
  (select account_b from fx), '51987654321', 'inbound',
  'Consulta desde la sede B', 'text', 'wamid-b-001', 'Rosa', '+51 987 654 321'
) from fx;

update public.channel_conversations
set assigned_user_id = (select seller_b from fx), assigned_user_label = 'Vendedora sede B'
where channel_account_id = (select account_b from fx);

grant select on fx to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.channel_conversations
   where branch_id = (select branch_a from fx)),
  2,
  '23 · La vendedora A ve las conversaciones de su sede'
);

select is(
  (select count(*)::integer from public.channel_conversations
   where branch_id = (select branch_b from fx)),
  0,
  '24 · Y ninguna de la sede ajena'
);

select is(
  (select count(*)::integer from public.channel_contacts),
  1,
  '25 · Ve el contacto de sus conversaciones, no el directorio entero'
);

set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::integer from public.channel_conversations),
  1,
  '26 · La vendedora B ve la suya: asignada a ella'
);

-- Se la reasignan a otra persona: desaparece de su bandeja.
reset role;
update public.channel_conversations
set assigned_user_id = (select admin_id from fx), assigned_user_label = 'Propietaria'
where channel_account_id = (select account_b from fx);

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::integer from public.channel_conversations),
  0,
  '27 · Asignada a otra compañera, deja de ser legible'
);

select is(
  (select count(*)::integer from public.channel_messages),
  0,
  '28 · Y sus mensajes tampoco se leen'
);

reset role;

select * from finish();

rollback;
