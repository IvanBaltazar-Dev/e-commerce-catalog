begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

select has_column('public', 'catalog_review_work_items', 'deferred_until', '1 · el trabajo admite aplazamiento real');
select has_column('public', 'catalog_review_work_items', 'assigned_to', '2 · el trabajo admite responsable de sesión');
select has_view('public', 'catalog_review_operational_queue_v1', '3 · existe la cola operativa estable');
select has_view('public', 'catalog_review_activity_summary_v1', '4 · existe el progreso diario sin medir velocidad');
select has_function('public', 'next_catalog_review_item_v1', array['uuid[]','text','text','text'], '5 · Continuar revisión vive en PostgreSQL');
select has_function('public', 'list_catalog_review_items_v1', array['text','text','text','timestamp with time zone','uuid','integer'], '6 · existe listado con cursor estable');
select has_function('public', 'transition_catalog_review_item_v1', array['uuid','bigint','text','text','text','integer','uuid'], '7 · existe comando transaccional de sesión');

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '99000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'review-app-admin@example.invalid', '', now(),
  '{}', '{}', now(), now(), '', '', '', ''
);

insert into public.admin_profiles(id, role, full_name, is_active)
values ('99000000-0000-4000-8000-000000000001', 'admin', 'Administradora Fase 1', true);

create temporary table application_fx(code text primary key, id uuid not null) on commit drop;

insert into application_fx(code, id)
select fixture.code, registered.id
from (values
  ('high', 'pgtap:app:high', 'high', false, 1),
  ('normal_contradiction', 'pgtap:app:normal', 'normal', true, 999),
  ('dependent', 'pgtap:app:dependent', 'low', false, 0)
) fixture(code, family_key, risk_level, contradiction, unlock_count)
cross join lateral public.register_catalog_review_work_item_v1(
  p_work_family_key => fixture.family_key,
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'other',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => md5(fixture.family_key),
  p_question => 'Caso de aplicación ' || fixture.code,
  p_group_key => 'pgtap:application-contracts',
  p_risk_level => fixture.risk_level,
  p_has_contradiction => fixture.contradiction,
  p_unlock_count => fixture.unlock_count
) registered;

insert into public.catalog_review_dependencies(
  dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key
)
select dependent.id, prerequisite.id, 'requires_all', 'app-unlock'
from application_fx dependent, application_fx prerequisite
where dependent.code = 'dependent' and prerequisite.code = 'high';

select is(
  (select id from public.next_catalog_review_item_v1(
    p_group_key => 'pgtap:application-contracts'
  )),
  (select id from application_fx where code = 'high'),
  '8 · riesgo precede a contradicción y desbloqueo en el orden congelado'
);

select is(
  (select id from public.next_catalog_review_item_v1(
    p_exclude_ids => array[(select id from application_fx where code = 'high')],
    p_group_key => 'pgtap:application-contracts'
  )),
  (select id from application_fx where code = 'normal_contradiction'),
  '9 · omitir en la sesión muestra otro caso sin modificar el primero'
);

set local request.jwt.claims = '{"sub":"99000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $$ select public.transition_catalog_review_item_v1(
      %L::uuid, 1, 'start', null, 'pgtap-app-start', 1440, null
    ) $$,
    (select id from application_fx where code = 'high')
  ),
  '10 · iniciar usa un comando, no una actualización desde React'
);

select is(
  (select status from public.catalog_review_work_items where id = (select id from application_fx where code = 'high')),
  'in_progress',
  '11 · iniciar materializa el estado actual'
);

select is(
  (select event_type from public.catalog_review_events where idempotency_key = 'pgtap-app-start'),
  'work_started',
  '12 · iniciar conserva historia inmutable'
);

select is(
  (public.transition_catalog_review_item_v1(
    (select id from application_fx where code = 'high'),
    1, 'start', null, 'pgtap-app-start', 1440, null
  ) ->> 'idempotentReplay')::boolean,
  true,
  '13 · repetir la transición devuelve el mismo resultado'
);

select throws_ok(
  format(
    $$ select public.transition_catalog_review_item_v1(
      %L::uuid, 1, 'start', null, 'pgtap-app-start-stale', 1440, null
    ) $$,
    (select id from application_fx where code = 'high')
  ),
  '40001', null,
  '14 · expected_version protege también las transiciones de sesión'
);

select lives_ok(
  format(
    $$ select public.transition_catalog_review_item_v1(
      %L::uuid, 2, 'defer', 'Falta fotografiar la base del envase.',
      'pgtap-app-defer', 60, null
    ) $$,
    (select id from application_fx where code = 'high')
  ),
  '15 · evidencia insuficiente permite aplazar sin inventar respuesta'
);

select is(
  (select status from public.catalog_review_work_items where id = (select id from application_fx where code = 'high')),
  'open',
  '16 · aplazar no convierte el caso en resuelto'
);

select ok(
  (select deferred_until > now() from public.catalog_review_work_items where id = (select id from application_fx where code = 'high')),
  '17 · el aplazamiento tiene una fecha explícita'
);

select is(
  (select count(*)::integer from public.catalog_review_events
   where work_item_id = (select id from application_fx where code = 'high')
     and event_type = 'decision_taken'),
  0,
  '18 · falta de evidencia no se registra como decisión'
);

select is(
  (select id from public.next_catalog_review_item_v1(
    p_group_key => 'pgtap:application-contracts'
  )),
  (select id from application_fx where code = 'normal_contradiction'),
  '19 · Continuar revisión oculta temporalmente el caso aplazado'
);

select public.transition_catalog_review_item_v1(
  (select id from application_fx where code = 'high'),
  3, 'resume', null, 'pgtap-app-resume', 1440, null
);

select ok(
  (select deferred_until is null from public.catalog_review_work_items where id = (select id from application_fx where code = 'high')),
  '20 · reanudar devuelve el caso a la selección inmediata'
);

select public.resolve_catalog_review_item_v1(
  (select id from application_fx where code = 'high'),
  4, 'complete', '{"reason":"Decisión manual comprobada."}'::jsonb,
  '[]'::jsonb, 'pgtap-app-resolve', null
);

select is(
  (select (payload -> '_impact' ->> 'unlockedCount')::integer
   from public.catalog_review_events where idempotency_key = 'pgtap-app-resolve'),
  1,
  '21 · el evento conserva el impacto calculado por el servidor'
);

select is(
  (select queue_state from public.catalog_review_operational_queue_v1
   where id = (select id from application_fx where code = 'dependent')),
  'reviewable',
  '22 · resolver habilita realmente el trabajo dependiente'
);

select throws_ok(
  $$ select * from public.list_catalog_review_items_v1(
    p_cursor_created_at => now(), p_cursor_id => null, p_limit => 25
  ) $$,
  '22023', null,
  '23 · el listado rechaza cursores parciales'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.transition_catalog_review_item_v1(uuid,bigint,text,text,text,integer,uuid)',
    'execute'
  ) and not has_function_privilege(
    'anon',
    'public.transition_catalog_review_item_v1(uuid,bigint,text,text,text,integer,uuid)',
    'execute'
  ),
  '24 · la transición es administrativa y nunca anónima'
);

select * from finish();
rollback;
