begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures: una sede con dos vendedoras y una cuenta de WhatsApp.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f7000000-0000-4000-8000-000000000001','authenticated','authenticated','asg-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f7000000-0000-4000-8000-000000000002','authenticated','authenticated','asg-seller1@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f7000000-0000-4000-8000-000000000003','authenticated','authenticated','asg-seller2@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('f7000000-0000-4000-8000-000000000001','admin','Propietaria de asignación'),
  ('f7000000-0000-4000-8000-000000000002','seller','Vendedora Uno'),
  ('f7000000-0000-4000-8000-000000000003','seller','Vendedora Dos');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'ASGTEST', 'Sede de asignación', 'Lima', false, 903 from public.companies c limit 1;

insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select ch.id, b.id, 'WhatsApp asignación', 'wa-asg'
from public.channels ch, public.branches b where ch.code = 'whatsapp' and b.code = 'ASGTEST';

create temporary table fx on commit drop as
select
  'f7000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'f7000000-0000-4000-8000-000000000002'::uuid as seller1,
  'f7000000-0000-4000-8000-000000000003'::uuid as seller2,
  (select id from public.branches where code = 'ASGTEST') as branch,
  (select id from public.channel_accounts where external_account_id = 'wa-asg') as account;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller1, branch, true from fx;
insert into public.staff_branches (staff_id, branch_id, is_primary)
select seller2, branch, true from fx;

set local request.jwt.claims = '{"sub":"f7000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Tres conversaciones de tres clientas distintas.
create temporary table convs on commit drop as
select
  (public.ingest_channel_message((select account from fx), '51900000001', 'inbound', 'Hola 1', 'text', 'asg-m1', 'Clienta Uno') ->> 'conversationId')::uuid as c1,
  (public.ingest_channel_message((select account from fx), '51900000002', 'inbound', 'Hola 2', 'text', 'asg-m2', 'Clienta Dos') ->> 'conversationId')::uuid as c2,
  (public.ingest_channel_message((select account from fx), '51900000003', 'inbound', 'Hola 3', 'text', 'asg-m3', 'Clienta Tres') ->> 'conversationId')::uuid as c3;

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'conversation_assignments', '1 · Existe la historia de asignación');

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('assign_conversation', 'claim_conversation', 'auto_assign_conversation')),
  false,
  '2 · Ningún contrato de asignación es alcanzable por anon'
);

-- ---------------------------------------------------------------------------
-- Round-robin determinista
-- ---------------------------------------------------------------------------

create temporary table auto1 on commit drop as
select public.auto_assign_conversation((select c1 from convs)) as result;

select is(
  (select result ->> 'strategy' from auto1),
  'round_robin',
  '3 · Sin relación previa, la política es round-robin'
);

create temporary table auto2 on commit drop as
select public.auto_assign_conversation((select c2 from convs)) as result;

select isnt(
  (select result ->> 'assignedUserId' from auto2),
  (select result ->> 'assignedUserId' from auto1),
  '4 · La segunda conversación va a la OTRA vendedora'
);

create temporary table auto3 on commit drop as
select public.auto_assign_conversation((select c3 from convs)) as result;

select is(
  (select result ->> 'assignedUserId' from auto3),
  (select result ->> 'assignedUserId' from auto1),
  '5 · Y la tercera vuelve a la primera: la rueda gira en orden total'
);

select is(
  (select count(*)::integer from public.conversation_assignments),
  3,
  '6 · Cada asignación dejó su fila de historia'
);

select is(
  (select result ->> 'strategy' from auto1 limit 1),
  (select 'round_robin'),
  '7 · Con la estrategia registrada como dato'
);

-- Reasignar la ya asignada: no hace nada nuevo.
select is(
  (select public.auto_assign_conversation((select c1 from convs)) ->> 'strategy'),
  'already_assigned',
  '8 · La política automática no pisa una asignación vigente'
);

-- ---------------------------------------------------------------------------
-- Relación previa manda sobre la rueda
-- ---------------------------------------------------------------------------

-- La clienta Uno cierra su hilo y vuelve a escribir: su nueva conversación
-- debe volver a QUIEN LA ATENDIÓ, no a la siguiente de la rueda.
select public.close_conversation((select c1 from convs), 'Atendida');

create temporary table returning_client on commit drop as
select (public.ingest_channel_message(
  (select account from fx), '51900000001', 'inbound', 'Volví', 'text', 'asg-m4', 'Clienta Uno'
) ->> 'conversationId')::uuid as id;

create temporary table auto4 on commit drop as
select public.auto_assign_conversation((select id from returning_client)) as result;

select is(
  (select result ->> 'strategy' from auto4),
  'previous_relationship',
  '9 · La clienta que vuelve conserva a su vendedora'
);

select is(
  (select result ->> 'assignedUserId' from auto4),
  (select result ->> 'assignedUserId' from auto1),
  '10 · Exactamente la misma'
);

-- ---------------------------------------------------------------------------
-- Tomar es condicional; mover a otra es administración
-- ---------------------------------------------------------------------------

-- Una conversación libre nueva.
create temporary table free_conv on commit drop as
select (public.ingest_channel_message(
  (select account from fx), '51900000005', 'inbound', 'Hola libre', 'text', 'asg-m5', 'Clienta Libre'
) ->> 'conversationId')::uuid as id;

grant select on fx, convs, free_conv to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f7000000-0000-4000-8000-000000000002","role":"authenticated"}';

select lives_ok(
  format($$ select public.claim_conversation(%L::uuid) $$, (select id from free_conv)),
  '11 · La primera vendedora la toma'
);

set local request.jwt.claims = '{"sub":"f7000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  format($$ select public.claim_conversation(%L::uuid) $$, (select id from free_conv)),
  '23514', null,
  '12 · La segunda recibe un error explícito: ya fue tomada'
);

select throws_ok(
  format($$ select public.assign_conversation(%L::uuid, %L::uuid, 'Me la paso yo') $$,
    (select id from free_conv), (select seller2 from fx)),
  '42501', null,
  '13 · Y no puede quitársela: reasignar es administración'
);

reset role;
set local request.jwt.claims = '{"sub":"f7000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select public.assign_conversation(%L::uuid, %L::uuid, 'Redistribución de carga') $$,
    (select id from free_conv), (select seller2 from fx)),
  '14 · Administración reasigna con motivo'
);

select is(
  (select a.previous_user_id from public.conversation_assignments a
   where a.conversation_id = (select id from free_conv)
   order by a.id desc limit 1),
  (select seller1 from fx),
  '15 · La historia registra a quién reemplazó'
);

select throws_ok(
  format($$ select public.assign_conversation(%L::uuid, %L::uuid, '') $$,
    (select id from free_conv), (select seller1 from fx)),
  '22023', null,
  '16 · Sin motivo no hay asignación'
);

select throws_ok(
  $$ update public.conversation_assignments set reason = 'reescrito' where id = (select min(id) from public.conversation_assignments) $$,
  null, null,
  '17 · La historia de asignación no se reescribe'
);

-- Sede sin vendedoras: el resultado es «sin asignar», no un error.
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'ASGEMPTY', 'Sede sin equipo', 'Lima', false, 904 from public.companies c limit 1;

insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select ch.id, b.id, 'WhatsApp sede vacía', 'wa-asg-empty'
from public.channels ch, public.branches b where ch.code = 'whatsapp' and b.code = 'ASGEMPTY';

create temporary table empty_conv on commit drop as
select (public.ingest_channel_message(
  (select id from public.channel_accounts where external_account_id = 'wa-asg-empty'),
  '51900000009', 'inbound', 'Hola', 'text', 'asg-m9', 'Clienta Nueve'
) ->> 'conversationId')::uuid as id;

select is(
  (select public.auto_assign_conversation((select id from empty_conv)) ->> 'strategy'),
  'unassigned',
  '18 · Una sede sin vendedoras deja la conversación sin asignar, sin romper nada'
);

select * from finish();

rollback;
