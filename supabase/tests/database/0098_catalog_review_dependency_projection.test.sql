begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

select has_column(
  'public', 'catalog_review_dependencies', 'origin',
  '1 · las dependencias distinguen proyección y edición manual'
);
select has_function(
  'public', 'refresh_catalog_review_dependencies_v1', array[]::text[],
  '2 · existe la proyección idempotente de dependencias'
);

create temporary table dependency_fx on commit drop as
select product.id as product_id
from public.products product
where not exists (
  select 1
  from public.catalog_review_work_items item
  where item.subject_type = 'product'
    and item.subject_id = product.id
    and item.purpose = 'identity'
)
order by product.id
limit 1;

alter table dependency_fx
  add column identity_v1 uuid,
  add column identity_v2 uuid,
  add column dependent uuid,
  add column stable_version bigint;

update dependency_fx
set identity_v1 = (
  select result.id
  from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:projection:product-identity',
  p_source_type => 'reconciliation_case',
  p_source_id => '98000000-0000-4000-8000-000000000001',
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'product', p_subject_id => (select product_id from dependency_fx),
  p_material_fingerprint => repeat('1', 32),
  p_question => '¿Cuál es la identidad de este producto?',
  p_group_key => 'pgtap:projection:identity'
  ) result
);

update dependency_fx
set dependent = (
  select result.id
  from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:projection:product-image',
  p_source_type => 'manual', p_source_id => null,
  p_work_kind => 'capture', p_purpose => 'image',
  p_subject_type => 'product', p_subject_id => (select product_id from dependency_fx),
  p_material_fingerprint => repeat('2', 32),
  p_question => 'Fotografiar el producto después de confirmar su identidad.',
  p_group_key => 'pgtap:projection:image'
  ) result
);

select public.refresh_catalog_review_dependencies_v1();

select is(
  (select count(*)::integer
   from public.catalog_review_dependencies dependency, dependency_fx fixture
   where dependency.dependent_work_item_id = fixture.dependent
     and dependency.prerequisite_work_item_id = fixture.identity_v1),
  1,
  '3 · la imagen depende de la identidad del mismo producto'
);
select is(
  (select dependency.origin
   from public.catalog_review_dependencies dependency, dependency_fx fixture
   where dependency.dependent_work_item_id = fixture.dependent
     and dependency.prerequisite_work_item_id = fixture.identity_v1),
  'projection',
  '4 · la dependencia generada conserva su origen'
);
select is(
  (select queue.queue_state
   from public.catalog_review_queue_v1 queue, dependency_fx fixture
   where queue.id = fixture.dependent),
  'blocked',
  '5 · una captura no se ofrece antes de resolver identidad'
);
select is(
  (select item.unlock_count
   from public.catalog_review_work_items item, dependency_fx fixture
   where item.id = fixture.identity_v1),
  (select count(distinct dependency.dependent_work_item_id)::integer
   from public.catalog_review_dependencies dependency, dependency_fx fixture
   where dependency.prerequisite_work_item_id = fixture.identity_v1
     and dependency.origin = 'projection'),
  '6 · la identidad declara el número real de dependientes proyectados que puede desbloquear'
);

update dependency_fx fixture
set stable_version = item.row_version
from public.catalog_review_work_items item
where item.id = fixture.identity_v1;

select public.refresh_catalog_review_dependencies_v1();

select is(
  (select item.row_version
   from public.catalog_review_work_items item, dependency_fx fixture
   where item.id = fixture.identity_v1),
  (select stable_version from dependency_fx),
  '7 · reejecutar sin cambios no invalida expected_version'
);

update public.catalog_review_work_items item
set
  status = 'resolved',
  resolution_code = 'reject',
  resolution_payload = '{"reason":"La propuesta era incorrecta."}'::jsonb,
  resolved_at = now()
from dependency_fx fixture
where item.id = fixture.identity_v1;

select is(
  (select queue.queue_state
   from public.catalog_review_queue_v1 queue, dependency_fx fixture
   where queue.id = fixture.dependent),
  'blocked',
  '8 · rechazar una propuesta no finge que la identidad quedó confirmada'
);

update dependency_fx
set identity_v2 = (
  select result.id
  from public.register_catalog_review_work_item_v1(
  p_work_family_key => 'pgtap:projection:product-identity',
  p_source_type => 'reconciliation_case',
  p_source_id => '98000000-0000-4000-8000-000000000001',
  p_work_kind => 'decision', p_purpose => 'identity',
  p_subject_type => 'product', p_subject_id => (select product_id from dependency_fx),
  p_material_fingerprint => repeat('3', 32),
  p_question => '¿La evidencia nueva confirma la identidad?',
  p_group_key => 'pgtap:projection:identity'
  ) result
);

update public.catalog_review_work_items item
set
  status = 'resolved',
  resolution_code = 'approve',
  resolution_payload = '{"reason":"Nueva evidencia comprobada."}'::jsonb,
  resolved_at = now()
from dependency_fx fixture
where item.id = fixture.identity_v2;

select public.refresh_catalog_review_dependencies_v1();

select is(
  (select count(*)::integer
   from public.catalog_review_dependencies dependency, dependency_fx fixture
   where dependency.dependent_work_item_id = fixture.dependent
     and dependency.dependency_type = 'requires_any'),
  2,
  '9 · las versiones de identidad comparten una alternativa requires_any'
);
select is(
  (select queue.queue_state
   from public.catalog_review_queue_v1 queue, dependency_fx fixture
   where queue.id = fixture.dependent),
  'capture_required',
  '10 · una versión aprobada habilita la captura aunque otra fuera rechazada'
);
select is(
  (select count(distinct dependency.group_key)::integer
   from public.catalog_review_dependencies dependency, dependency_fx fixture
   where dependency.dependent_work_item_id = fixture.dependent
     and dependency.dependency_type = 'requires_any'),
  1,
  '11 · todas las pruebas de identidad pertenecen a la misma compuerta lógica'
);
select is(
  (select price_required
   from public.catalog_review_queue_v1 queue, dependency_fx fixture
   where queue.id = fixture.dependent),
  false,
  '12 · la dependencia técnica tampoco exige precio'
);

select * from finish();

rollback;
