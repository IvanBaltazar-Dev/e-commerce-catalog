begin;

create extension if not exists pgtap with schema extensions;

select plan(41);

select has_table('public', 'catalog_review_work_items', '1 · existe el trabajo operativo de revisión');
select has_table('public', 'catalog_review_dependencies', '2 · existen dependencias semánticas');
select has_table('public', 'catalog_review_events', '3 · existe la historia inmutable');
select has_table('public', 'catalog_review_batches', '4 · existen previsualizaciones masivas');
select has_table('public', 'catalog_review_batch_items', '5 · el conjunto masivo queda congelado');
select has_view('public', 'catalog_review_queue_v1', '6 · existe el contrato estable de cola');
select has_view('public', 'catalog_review_summary_v1', '7 · existe el resumen operativo');

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'review-admin@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'review-seller@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.admin_profiles(id, role, full_name, is_active)
values
  ('97000000-0000-4000-8000-000000000001', 'admin', 'Administradora de revisión', true),
  ('97000000-0000-4000-8000-000000000002', 'seller', 'Vendedora sin acceso', true);

create temporary table review_fx(
  code text primary key,
  work_item_id uuid not null
) on commit drop;

insert into review_fx(code, work_item_id)
select 'stable_v1', result.id
from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:stable:identity',
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => repeat('a', 32),
  p_question => '¿Es estable esta identidad?',
  p_group_key => 'pgtap:stable'
) result;

select is(
  (select work_key from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'stable_v1')),
  'pgtap:stable:identity:v1',
  '8 · work_key incorpora familia y versión determinista'
);

select is(
  (select result.id
   from public.register_catalog_review_work_item_v1(
     p_work_family_key => 'pgtap:stable:identity',
     p_source_type => 'manual', p_source_id => null,
     p_work_kind => 'decision', p_purpose => 'identity',
     p_subject_type => 'other', p_subject_id => null,
     p_material_fingerprint => repeat('a', 32),
     p_question => '¿Es estable esta identidad?',
     p_group_key => 'pgtap:stable'
   ) result),
  (select work_item_id from review_fx where code = 'stable_v1'),
  '9 · la misma huella devuelve exactamente el mismo trabajo'
);

insert into review_fx(code, work_item_id)
select 'stable_v2', result.id
from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:stable:identity',
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => repeat('b', 32),
  p_question => '¿La evidencia nueva cambia esta identidad?',
  p_group_key => 'pgtap:stable'
) result;

select is(
  (select problem_version from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'stable_v2')),
  2,
  '10 · evidencia material nueva crea la siguiente versión'
);
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'stable_v1')),
  'superseded',
  '11 · la versión anterior conserva historia y queda sustituida'
);

select throws_ok(
  $$ select public.register_catalog_review_work_item_v1(
       p_work_family_key => 'pgtap:automatic:forbidden',
       p_source_type => 'manual', p_source_id => null,
       p_work_kind => 'automatic', p_purpose => 'image',
       p_subject_type => 'other', p_subject_id => null,
       p_material_fingerprint => repeat('c', 32),
       p_question => 'Este trabajo no debe entrar a la cola humana.'
     ) $$,
  '23514', null,
  '12 · automático no es un tipo admitido de trabajo humano'
);

select is(
  (select count(*)::integer
   from public.catalog_review_work_items item
   join public.catalog_enrichment_exceptions exception
     on item.source_type = 'enrichment_exception' and item.source_id = exception.id
   where exception.exception_type = 'image_missing'),
  0,
  '13 · la falta fotográfica normal no se transforma en excepción humana'
);

insert into review_fx(code, work_item_id)
select fixture.code, result.id
from (values
  ('pre_all_a', 'pgtap:dep:all:a', 'pgtap:dependency:all'),
  ('pre_all_b', 'pgtap:dep:all:b', 'pgtap:dependency:all'),
  ('dep_all',   'pgtap:dep:all:dependent', 'pgtap:dependency:all-dependent'),
  ('pre_any_a', 'pgtap:dep:any:a', 'pgtap:dependency:any'),
  ('pre_any_b', 'pgtap:dep:any:b', 'pgtap:dependency:any'),
  ('dep_any',   'pgtap:dep:any:dependent', 'pgtap:dependency:any-dependent'),
  ('pre_invalid', 'pgtap:dep:invalid:source', 'pgtap:dependency:invalid'),
  ('dep_invalid', 'pgtap:dep:invalid:dependent', 'pgtap:dependency:invalid-dependent'),
  ('stale', 'pgtap:concurrency:stale', 'pgtap:concurrency')
) fixture(code, family_key, group_key)
cross join lateral public.register_catalog_review_work_item_v1(
  p_work_family_key => fixture.family_key,
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => md5(fixture.family_key),
  p_question => 'Decisión de prueba ' || fixture.code,
  p_group_key => fixture.group_key
) result;

insert into public.catalog_review_dependencies(
  dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key
)
select dependent.work_item_id, prerequisite.work_item_id, 'requires_all', 'identity'
from review_fx dependent
join review_fx prerequisite on prerequisite.code in ('pre_all_a', 'pre_all_b')
where dependent.code = 'dep_all';

insert into public.catalog_review_dependencies(
  dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key
)
select dependent.work_item_id, prerequisite.work_item_id, 'requires_any', 'identity-proof'
from review_fx dependent
join review_fx prerequisite on prerequisite.code in ('pre_any_a', 'pre_any_b')
where dependent.code = 'dep_any';

insert into public.catalog_review_dependencies(
  dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key, condition
)
select dependent.work_item_id, prerequisite.work_item_id, 'invalidated_by', 'identity-rejection',
       '{"resolution_codes":["reject"]}'::jsonb
from review_fx dependent
join review_fx prerequisite on prerequisite.code = 'pre_invalid'
where dependent.code = 'dep_invalid';

select is(
  (select blocked_by_count from public.catalog_review_queue_v1 where id = (select work_item_id from review_fx where code = 'dep_all')),
  2,
  '14 · requires_all cuenta los dos antecedentes pendientes'
);

set local request.jwt.claims = '{"sub":"97000000-0000-4000-8000-000000000001","role":"authenticated"}';

select public.resolve_catalog_review_item_v1(
  (select work_item_id from review_fx where code = 'pre_all_a'), 1,
  'complete', '{}'::jsonb, '[]'::jsonb, 'pgtap-resolve-pre-all-a', null
);

select is(
  (select blocked_by_count from public.catalog_review_queue_v1 where id = (select work_item_id from review_fx where code = 'dep_all')),
  1,
  '15 · requires_all continúa bloqueado hasta completar todos'
);

select public.resolve_catalog_review_item_v1(
  (select work_item_id from review_fx where code = 'pre_all_b'), 1,
  'complete', '{}'::jsonb, '[]'::jsonb, 'pgtap-resolve-pre-all-b', null
);

select is(
  (select queue_state from public.catalog_review_queue_v1 where id = (select work_item_id from review_fx where code = 'dep_all')),
  'reviewable',
  '16 · requires_all se libera cuando todos están resueltos'
);

select is(
  (select blocked_by_count from public.catalog_review_queue_v1 where id = (select work_item_id from review_fx where code = 'dep_any')),
  1,
  '17 · requires_any bloquea una sola vez por grupo, no por candidato'
);

select public.resolve_catalog_review_item_v1(
  (select work_item_id from review_fx where code = 'pre_any_a'), 1,
  'complete', '{}'::jsonb, '[]'::jsonb, 'pgtap-resolve-pre-any-a', null
);

select is(
  (select queue_state from public.catalog_review_queue_v1 where id = (select work_item_id from review_fx where code = 'dep_any')),
  'reviewable',
  '18 · un antecedente válido satisface requires_any'
);

select throws_ok(
  format(
    $$ insert into public.catalog_review_dependencies(
         dependent_work_item_id, prerequisite_work_item_id, dependency_type
       ) values (%L::uuid, %L::uuid, 'requires_all') $$,
    (select work_item_id from review_fx where code = 'pre_all_a'),
    (select work_item_id from review_fx where code = 'dep_all')
  ),
  '23514', null,
  '19 · un ciclo se rechaza antes de bloquear permanentemente la cola'
);

update public.catalog_review_work_items
set question = 'La pantalla quedó antigua.'
where id = (select work_item_id from review_fx where code = 'stale');

select throws_ok(
  format(
    $$ select public.resolve_catalog_review_item_v1(
         %L::uuid, 1, 'complete', '{}'::jsonb, '[]'::jsonb,
         'pgtap-stale-version', null
       ) $$,
    (select work_item_id from review_fx where code = 'stale')
  ),
  '40001', null,
  '20 · expected_version impide sobrescribir una pantalla antigua'
);

insert into public.catalog_sources(
  id, source_key, name, authority, adapter, base_url
) values (
  '97000000-0000-4000-8000-000000000101', 'pgtap-review-source',
  'Fuente de revisión', 'internal_document', 'manual_capture',
  'https://example.invalid/review-source'
);
insert into public.catalog_source_snapshots(
  id, source_id, status, completed_at, content_hash
) values (
  '97000000-0000-4000-8000-000000000102',
  '97000000-0000-4000-8000-000000000101', 'succeeded', now(), 'pgtap-review-snapshot'
);
insert into public.catalog_source_records(
  id, snapshot_id, source_id, entity_type, external_id, title, source_url, captured_at
) values (
  '97000000-0000-4000-8000-000000000103',
  '97000000-0000-4000-8000-000000000102',
  '97000000-0000-4000-8000-000000000101',
  'product', 'pgtap-product', 'Producto oficial de prueba',
  'https://example.invalid/review-source/product', now()
);
insert into public.catalog_reconciliation_cases(
  id, entity_type, product_id, source_record_id, algorithm, score, status, evidence
)
select
  '97000000-0000-4000-8000-000000000104', 'product', product.id,
  '97000000-0000-4000-8000-000000000103', 'pgtap_identity_v1', 1,
  'needs_review', '{"official_title":"Producto oficial de prueba"}'::jsonb
from public.products product order by product.id limit 1;

insert into review_fx(code, work_item_id)
select 'canonical', result.id
from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:canonical:identity',
  p_source_type => 'reconciliation_case',
  p_source_id => '97000000-0000-4000-8000-000000000104',
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'product',
  p_subject_id => (select product_id from public.catalog_reconciliation_cases where id = '97000000-0000-4000-8000-000000000104'),
  p_material_fingerprint => repeat('d', 32),
  p_question => '¿Corresponde al producto oficial?',
  p_group_key => 'pgtap:canonical'
) result;

select lives_ok(
  format(
    $$ select public.resolve_catalog_review_item_v1(
         %L::uuid, 1, 'approve', '{"reason":"Coincidencia comprobada."}'::jsonb,
         '[{"type":"human_review"}]'::jsonb, 'pgtap-canonical-approve', null
       ) $$,
    (select work_item_id from review_fx where code = 'canonical')
  ),
  '21 · el comando aplica catálogo, trabajo y evento en una transacción'
);

select is(
  (select status from public.catalog_reconciliation_cases where id = '97000000-0000-4000-8000-000000000104'),
  'approved',
  '22 · la reconciliación canónica queda aprobada'
);
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'canonical')),
  'resolved',
  '23 · el trabajo queda resuelto junto con la fuente canónica'
);

select is(
  (public.resolve_catalog_review_item_v1(
    (select work_item_id from review_fx where code = 'canonical'), 1,
    'approve', '{"reason":"Coincidencia comprobada."}'::jsonb,
    '[{"type":"human_review"}]'::jsonb, 'pgtap-canonical-approve', null
  ) ->> 'idempotentReplay')::boolean,
  true,
  '24 · repetir la misma clave devuelve el resultado sin decidir dos veces'
);
select is(
  (select count(*)::integer from public.catalog_review_events
   where idempotency_key = 'pgtap-canonical-approve'),
  1,
  '25 · una operación idempotente conserva un solo evento'
);
select throws_ok(
  format(
    $$ select public.resolve_catalog_review_item_v1(
         %L::uuid, 1, 'approve', '{"reason":"Contenido distinto."}'::jsonb,
         '[{"type":"human_review"}]'::jsonb, 'pgtap-canonical-approve', null
       ) $$,
    (select work_item_id from review_fx where code = 'canonical')
  ),
  '23505', null,
  '26 · una clave no puede reutilizarse con contenido diferente'
);
select throws_ok(
  $$ update public.catalog_review_events
     set actor_label = 'Historia reescrita'
     where idempotency_key = 'pgtap-canonical-approve' $$,
  '55000', null,
  '27 · el evento no se puede reescribir'
);

select public.resolve_catalog_review_item_v1(
  (select work_item_id from review_fx where code = 'pre_invalid'), 1,
  'reject', '{}'::jsonb, '[]'::jsonb, 'pgtap-resolve-invalidator', null
);
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'dep_invalid')),
  'superseded',
  '28 · invalidated_by sustituye el trabajo cuando coincide la resolución'
);

insert into review_fx(code, work_item_id)
select fixture.code, result.id
from (values
  ('moving_a', 'pgtap:batch:moving:a', 'pgtap:batch:moving'),
  ('moving_b', 'pgtap:batch:moving:b', 'pgtap:batch:moving'),
  ('stable_a', 'pgtap:batch:apply:a', 'pgtap:batch:apply'),
  ('stable_b', 'pgtap:batch:apply:b', 'pgtap:batch:apply'),
  ('outside',  'pgtap:batch:outside', 'pgtap:batch:outside')
) fixture(code, family_key, group_key)
cross join lateral public.register_catalog_review_work_item_v1(
  p_work_family_key => fixture.family_key,
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => md5(fixture.family_key),
  p_question => 'Decisión masiva ' || fixture.code,
  p_group_key => fixture.group_key
) result;

create temporary table batch_fx(
  code text primary key,
  batch_id uuid not null,
  fingerprint text not null
) on commit drop;

insert into batch_fx(code, batch_id, fingerprint)
select 'moving', (preview ->> 'batchId')::uuid, preview ->> 'snapshotFingerprint'
from (
  select public.preview_catalog_review_batch_v1(
    'pgtap:batch:moving', 'complete', '{}'::jsonb,
    'pgtap-preview-moving', null
  ) as preview
) result;

select is(
  (select snapshot_count from public.catalog_review_batches where id = (select batch_id from batch_fx where code = 'moving')),
  2,
  '29 · la previsualización congela exactamente los dos casos revisados'
);

insert into review_fx(code, work_item_id)
select 'moving_c', result.id
from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:batch:moving:c',
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'other', p_subject_id => null,
  p_material_fingerprint => md5('pgtap:batch:moving:c'),
  p_question => 'Caso que llegó después de revisar.',
  p_group_key => 'pgtap:batch:moving'
) result;

select throws_ok(
  format(
    $$ select public.apply_catalog_review_batch_v1(
         %L::uuid, %L, 'pgtap-apply-moving', null
       ) $$,
    (select batch_id from batch_fx where code = 'moving'),
    (select fingerprint from batch_fx where code = 'moving')
  ),
  '40001', null,
  '30 · un lote se rechaza si el conjunto cambió desde la revisión'
);
select is(
  (select count(*)::integer from public.catalog_review_work_items
   where id in (select work_item_id from review_fx where code in ('moving_a', 'moving_b'))
     and status = 'resolved'),
  0,
  '31 · el lote móvil no aplica decisiones parciales'
);

insert into batch_fx(code, batch_id, fingerprint)
select 'apply', (preview ->> 'batchId')::uuid, preview ->> 'snapshotFingerprint'
from (
  select public.preview_catalog_review_batch_v1(
    'pgtap:batch:apply', 'complete', '{}'::jsonb,
    'pgtap-preview-apply', null
  ) as preview
) result;

select is(
  (public.apply_catalog_review_batch_v1(
    (select batch_id from batch_fx where code = 'apply'),
    (select fingerprint from batch_fx where code = 'apply'),
    'pgtap-apply-stable', null
  ) ->> 'appliedCount')::integer,
  2,
  '32 · el lote estable aplica exactamente el snapshot aprobado'
);
select is(
  (select status from public.catalog_review_work_items where id = (select work_item_id from review_fx where code = 'outside')),
  'open',
  '33 · una decisión masiva nunca toca entidades fuera del snapshot'
);
select is(
  (public.apply_catalog_review_batch_v1(
    (select batch_id from batch_fx where code = 'apply'),
    (select fingerprint from batch_fx where code = 'apply'),
    'pgtap-apply-stable', null
  ) ->> 'idempotentReplay')::boolean,
  true,
  '34 · aplicar otra vez la misma operación es idempotente'
);
select throws_ok(
  format(
    $$ update public.catalog_review_batch_items
       set expected_version = expected_version + 1
       where batch_id = %L::uuid $$,
    (select batch_id from batch_fx where code = 'apply')
  ),
  '55000', null,
  '35 · los miembros previsualizados no pueden mutar'
);

select is(
  (select count(*)::integer from public.catalog_review_queue_v1 where price_required),
  0,
  '36 · la revisión del catálogo no exige precio'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_catalog_review_item_v1(uuid,bigint,text,jsonb,jsonb,text,uuid)',
    'execute'
  ) and not has_function_privilege(
    'anon',
    'public.resolve_catalog_review_item_v1(uuid,bigint,text,jsonb,jsonb,text,uuid)',
    'execute'
  ),
  '37 · el comando es administrativo autenticado y nunca anónimo'
);

reset request.jwt.claims;
set local role authenticated;
set local request.jwt.claims = '{"sub":"97000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.catalog_review_queue_v1),
  0,
  '38 · una vendedora no puede leer la Mesa de revisión'
);

reset role;
reset request.jwt.claims;

insert into public.catalog_enrichment_exceptions(
  id, exception_key, product_id, exception_type, severity, status, title, details
)
select
  '97000000-0000-4000-8000-000000000201',
  'pgtap-review-exception-disappearance',
  product.id,
  'identity_ambiguous',
  'high',
  'open',
  'Identidad pendiente de prueba',
  '{"occurrence_version":1,"required_action":"Confirmar identidad."}'::jsonb
from public.products product
order by product.id
limit 1;

select public.sync_catalog_review_work_items_v1();

select is(
  (select status from public.catalog_review_work_items
   where source_type = 'enrichment_exception'
     and source_id = '97000000-0000-4000-8000-000000000201'
   order by problem_version desc limit 1),
  'open',
  '39 · una excepción observada genera trabajo abierto exactamente una vez'
);

update public.catalog_enrichment_exceptions
set status = 'superseded', resolved_at = now(),
    resolution_notes = 'El pipeline dejó de observar esta excepción.'
where id = '97000000-0000-4000-8000-000000000201';

select public.sync_catalog_review_work_items_v1();

select is(
  (select status from public.catalog_review_work_items
   where source_type = 'enrichment_exception'
     and source_id = '97000000-0000-4000-8000-000000000201'
   order by problem_version desc limit 1),
  'superseded',
  '40 · una excepción desaparecida sustituye el trabajo sin fingir decisión humana'
);

update public.catalog_enrichment_exceptions
set status = 'open', resolved_at = null, resolution_notes = null,
    details = '{"occurrence_version":2,"required_action":"Confirmar identidad."}'::jsonb
where id = '97000000-0000-4000-8000-000000000201';

select public.sync_catalog_review_work_items_v1();

select is(
  (select count(*)::integer
   from public.catalog_review_work_items
   where source_type = 'enrichment_exception'
     and source_id = '97000000-0000-4000-8000-000000000201'
     and problem_version in (1, 2)),
  2,
  '41 · la misma excepción solo reaparece como v2 ante evidencia material nueva'
);

select * from finish();

rollback;
