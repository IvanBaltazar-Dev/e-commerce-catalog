begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

-- ---------------------------------------------------------------------------
-- Fixture: una sede con dos vendedoras y una administradora; una venta hecha
-- por humanos (Bloque 2) que servirá de enlace. La IA jamás la creó.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f9000000-0000-4000-8000-000000000001','authenticated','authenticated','ai-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f9000000-0000-4000-8000-000000000002','authenticated','authenticated','ai-seller1@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f9000000-0000-4000-8000-000000000003','authenticated','authenticated','ai-seller2@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('f9000000-0000-4000-8000-000000000001','admin','Admin IA'),
  ('f9000000-0000-4000-8000-000000000002','seller','Vendedora IA Uno'),
  ('f9000000-0000-4000-8000-000000000003','seller','Vendedora IA Dos');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'AITEST', 'Sede de asistencia', 'Lima', false, 907 from public.companies c limit 1;

insert into public.staff_branches (staff_id, branch_id, is_primary)
select 'f9000000-0000-4000-8000-000000000002', id, true from public.branches where code = 'AITEST';

create temporary table fx on commit drop as
select
  'f9000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'f9000000-0000-4000-8000-000000000002'::uuid as seller1,
  'f9000000-0000-4000-8000-000000000003'::uuid as seller2,
  (select id from public.branches where code = 'AITEST') as branch;

grant select on fx to authenticated;

-- La venta humana preexistente.
insert into public.sales (id, branch_id, sale_number, status, source_channel, gross_subtotal, discount_total, total, seller_label, client_operation_id)
select 'f9000000-0000-4000-8000-00000000a001', branch, 'AI-0001', 'confirmed', 'in_store', 50, 0, 50, 'Vendedora IA Uno', gen_random_uuid() from fx;
insert into public.sale_payments (sale_id, method, amount)
values ('f9000000-0000-4000-8000-00000000a001', 'cash', 50);

-- ---------------------------------------------------------------------------
-- Estructura y ACL
-- ---------------------------------------------------------------------------

select has_table('public', 'ai_interactions', '1 · Existe la evidencia de asistencias');
select has_table('public', 'content_proposals', '2 · Existen las propuestas de contenido');

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_ai_interaction', 'resolve_ai_interaction',
                       'create_content_proposal', 'review_content_proposal',
                       'mark_content_published')),
  false,
  '3 · Ningún contrato de IA es alcanzable por anon'
);

select is(
  has_table_privilege('authenticated', 'public.ai_interactions', 'insert')
    or has_table_privilege('authenticated', 'public.ai_interactions', 'update')
    or has_table_privilege('authenticated', 'public.ai_interactions', 'delete'),
  false,
  '4 · La evidencia solo se escribe por contrato, jamás por tabla'
);

-- ---------------------------------------------------------------------------
-- El ciclo de una asistencia: propone la IA, decide el humano
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"f9000000-0000-4000-8000-000000000002","role":"authenticated"}';

create temporary table sales_before as
select count(*) as n from public.sales;

create temporary table rec1 on commit drop as
select public.record_ai_interaction(
  'audio_order',
  'Dictado: dos esmaltes rojos y un kit de gel',
  '{"lineas":[{"sku":"DASH-P1-V1","cantidad":2}],"ambiguedades":[]}'::jsonb,
  'claude-opus-5', 'ok', 812, null,
  (select branch from fx), null
) as id;

select ok((select id from rec1) is not null, '5 · La vendedora registra la asistencia');

select ok((
  select status = 'proposed' and requested_by = (select seller1 from fx)
  from public.ai_interactions where id = (select id from rec1)
), '6 · Nace como propuesta, con la persona que la pidió');

-- La OTRA vendedora no resuelve lo ajeno.
set local request.jwt.claims = '{"sub":"f9000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  format($$ select public.resolve_ai_interaction(%L::uuid, 'confirmed') $$, (select id from rec1)),
  '42501', null,
  '7 · Resolver una asistencia ajena es un error explícito'
);

set local request.jwt.claims = '{"sub":"f9000000-0000-4000-8000-000000000002","role":"authenticated"}';

select lives_ok(
  format($$ select public.resolve_ai_interaction(%L::uuid, 'confirmed',
    'f9000000-0000-4000-8000-00000000a001'::uuid, null, 'Venta hecha a mano por el Bloque 2') $$,
    (select id from rec1)),
  '8 · Quien la pidió la confirma, enlazando la venta que ELLA ejecutó'
);

select is(
  (select count(*) from public.sales),
  (select n from sales_before),
  '9 · REGLA 9: ni registrar ni resolver asistencias creó venta alguna'
);

select ok((
  select status = 'confirmed' and sale_id = 'f9000000-0000-4000-8000-00000000a001'
     and confirmed_by = (select seller1 from fx)
  from public.ai_interactions where id = (select id from rec1)
), '10 · La confirmación quedó con enlace, quién y cuándo');

reset role;
set local request.jwt.claims = '{}';

select throws_ok(
  format($$ update public.ai_interactions set proposal = '{"reescrito":true}'::jsonb where id = %L $$,
    (select id from rec1)),
  '23514', null,
  '11 · La propuesta es evidencia: ni el superusuario la reescribe'
);

select throws_ok(
  format($$ update public.ai_interactions set status = 'discarded' where id = %L $$,
    (select id from rec1)),
  '23514', null,
  '12 · Una interacción resuelta no cambia de estado'
);

select throws_ok(
  format($$ delete from public.ai_interactions where id = %L $$, (select id from rec1)),
  '23514', null,
  '13 · La evidencia no se elimina'
);

-- Regla 10: la caída del proveedor es un RESULTADO registrado, no una excepción.
set local role authenticated;
set local request.jwt.claims = '{"sub":"f9000000-0000-4000-8000-000000000002","role":"authenticated"}';

create temporary table rec2 on commit drop as
select public.record_ai_interaction(
  'photo_recognition', 'Foto de un esmalte', '{}'::jsonb,
  null, 'unavailable', null, 'Sin credencial de IA configurada'
) as id;

select ok((
  select status = 'failed' and provider_status = 'unavailable'
  from public.ai_interactions where id = (select id from rec2)
), '14 · La IA caída queda registrada como fallo con su razón; la tienda sigue');

create temporary table rec3 on commit drop as
select public.record_ai_interaction('advisor', '¿Qué kit le recomiendo a una principiante?') as id;

select throws_ok(
  format($$ select public.resolve_ai_interaction(%L::uuid, 'discarded',
    'f9000000-0000-4000-8000-00000000a001'::uuid) $$, (select id from rec3)),
  '22023', null,
  '15 · Descartar con enlace comercial es contradictorio y explota'
);

select lives_ok(
  format($$ select public.resolve_ai_interaction(%L::uuid, 'discarded', null, null, 'No aplicaba') $$,
    (select id from rec3)),
  '16 · Descartar limpio funciona'
);

-- ---------------------------------------------------------------------------
-- Tendencias: proponer no es publicar
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.create_content_proposal('Tonos rojos en alza', 'Los rojos duplican ventas este mes.') $$,
  '42501', null,
  '17 · La vendedora no crea propuestas de contenido: son administrativas'
);

reset role;
set local request.jwt.claims = '{"sub":"f9000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table prop1 on commit drop as
select public.create_content_proposal(
  'Tonos rojos en alza',
  'Los rojos duplican ventas este mes. Propuesta: reel con los 3 tonos top.',
  '{"topTonos":["Rojo intenso"]}'::jsonb
) as id;

select ok((
  select status = 'draft' from public.content_proposals where id = (select id from prop1)
), '18 · La propuesta nace como borrador');

select throws_ok(
  format($$ select public.mark_content_published(%L::uuid) $$, (select id from prop1)),
  '23514', null,
  '19 · Un borrador NO se publica: falta la aprobación humana'
);

select lives_ok(
  format($$ select public.review_content_proposal(%L::uuid, 'approved', 'Me gusta, va') $$,
    (select id from prop1)),
  '20 · La dueña aprueba con su identidad'
);

select throws_ok(
  format($$ update public.content_proposals set body = 'reescrito' where id = %L $$,
    (select id from prop1)),
  '23514', null,
  '21 · El contenido aprobado no se reescribe'
);

select throws_ok(
  format($$ select public.review_content_proposal(%L::uuid, 'rejected') $$, (select id from prop1)),
  '23514', null,
  '22 · Una propuesta ya revisada no se re-revisa'
);

select lives_ok(
  format($$ select public.mark_content_published(%L::uuid, 'Publicado a mano en Instagram') $$,
    (select id from prop1)),
  '23 · Publicar es un registro de que un humano publicó ÉL MISMO'
);

select ok((
  select published_by = (select admin_id from fx) and status = 'published'
  from public.content_proposals where id = (select id from prop1)
), '24 · Con la identidad de quien publicó');

create temporary table prop2 on commit drop as
select public.create_content_proposal('Idea floja', 'Contenido que no convence.') as id;

select lives_ok(
  format($$ select public.review_content_proposal(%L::uuid, 'rejected', 'No va con la marca') $$,
    (select id from prop2)),
  '25 · Rechazar también es una decisión registrada'
);

select throws_ok(
  format($$ select public.mark_content_published(%L::uuid) $$, (select id from prop2)),
  '23514', null,
  '26 · Lo rechazado jamás se publica'
);

select * from finish();

rollback;
