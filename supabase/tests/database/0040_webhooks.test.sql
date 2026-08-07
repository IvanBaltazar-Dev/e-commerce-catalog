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
  ('00000000-0000-0000-0000-000000000000','a8000000-0000-4000-8000-000000000001','authenticated','authenticated','wh-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','a8000000-0000-4000-8000-000000000002','authenticated','authenticated','wh-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('a8000000-0000-4000-8000-000000000001','admin','Propietaria de integraciones'),
  ('a8000000-0000-4000-8000-000000000002','seller','Vendedora de integraciones');

set local request.jwt.claims = '{"sub":"a8000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'integration_connections', '1 · Existen las conexiones');
select has_table('public', 'integration_webhook_events', '2 · Existe el registro crudo de webhooks');
select has_table('public', 'integration_delivery_attempts', '3 · Existen los intentos de entrega');

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('ingest_webhook_event', 'claim_webhook_event', 'complete_webhook_event',
                       'fail_webhook_event', 'ignore_webhook_event', 'omnichannel_metrics')),
  false,
  '4 · Nada del ciclo de webhooks es alcanzable por anon'
);

-- ---------------------------------------------------------------------------
-- El mismo webhook cinco veces (prueba 18 del plan)
-- ---------------------------------------------------------------------------

create temporary table ingested on commit drop as
select public.ingest_webhook_event('whatsapp', 'evt-001',
  '{"messages": [{"id": "wamid-x", "text": "hola"}]}'::jsonb) as result
from generate_series(1, 5);

select is(
  (select count(*)::integer from public.integration_webhook_events
   where provider = 'whatsapp' and external_event_id = 'evt-001'),
  1,
  '5 · Cinco entregas del mismo evento: UNA fila'
);

select is(
  (select count(*)::integer from ingested where (result ->> 'duplicate')::boolean = false),
  1,
  '6 · Exactamente una se registró como nueva'
);

select is(
  (select count(distinct result ->> 'eventId')::integer from ingested),
  1,
  '7 · Y las cinco apuntan al mismo evento'
);

-- ---------------------------------------------------------------------------
-- Ciclo de vida: reclamo condicional
-- ---------------------------------------------------------------------------

create temporary table claimed on commit drop as
select public.claim_webhook_event(
  (select (result ->> 'eventId')::bigint from ingested limit 1)
) as result;

select is(
  (select result ->> 'provider' from claimed),
  'whatsapp',
  '8 · El reclamo entrega el payload para procesar'
);

select is(
  public.claim_webhook_event((select (result ->> 'eventId')::bigint from ingested limit 1)),
  null,
  '9 · El segundo procesador no reclama nada: exactamente uno procesa'
);

select is(
  public.complete_webhook_event(
    (select (result ->> 'eventId')::bigint from ingested limit 1),
    '{"messageId": "abc"}'::jsonb),
  true,
  '10 · Completar cierra el evento'
);

select is(
  (select status from public.integration_webhook_events where external_event_id = 'evt-001'),
  'processed'::public.webhook_event_status,
  '11 · processed, con su resultado'
);

select is(
  public.complete_webhook_event((select (result ->> 'eventId')::bigint from ingested limit 1), '{}'::jsonb),
  false,
  '12 · Completar dos veces no reescribe nada'
);

-- ---------------------------------------------------------------------------
-- Fallo y reintento programado
-- ---------------------------------------------------------------------------

select public.ingest_webhook_event('whatsapp', 'evt-002', '{"broken": true}'::jsonb);

create temporary table failing on commit drop as
select (public.claim_webhook_event(
  (select id from public.integration_webhook_events where external_event_id = 'evt-002')
) ->> 'eventId')::bigint as id;

select is(
  public.fail_webhook_event((select id from failing), 'API caída', interval '10 minutes'),
  true,
  '13 · El fallo queda registrado con su error'
);

select is(
  public.claim_webhook_event((select id from failing)),
  null,
  '14 · Y NO se reintenta antes de su próxima ventana'
);

update public.integration_webhook_events
set next_retry_at = now() - interval '1 second' where id = (select id from failing);

select isnt(
  public.claim_webhook_event((select id from failing)),
  null,
  '15 · Vencida la ventana, el reintento reclama de nuevo'
);

select is(
  (select attempts from public.integration_webhook_events where id = (select id from failing)),
  2,
  '16 · Con el intento contado'
);

-- ---------------------------------------------------------------------------
-- La evidencia es inmutable
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.integration_webhook_events set payload = '{"tampered": true}'::jsonb
     where external_event_id = 'evt-001' $$,
  '23514', null,
  '17 · El payload crudo no se reescribe: es la evidencia'
);

-- ---------------------------------------------------------------------------
-- Métricas: administrativas y con dinero del Bloque 2
-- ---------------------------------------------------------------------------

create temporary table metrics on commit drop as
select public.omnichannel_metrics(current_date - 30, current_date) as result;

select is(
  (select jsonb_typeof(result -> 'salesByChannel') from metrics),
  'object',
  '18 · Las métricas devuelven ventas por canal desde sales'
);

select is(
  (select jsonb_typeof(result -> 'carts') from metrics),
  'object',
  '19 · Y el embudo de carritos'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"a8000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  $$ select public.omnichannel_metrics() $$,
  '42501', null,
  '20 · La vendedora no lee métricas omnicanal'
);

reset role;

select * from finish();

rollback;
