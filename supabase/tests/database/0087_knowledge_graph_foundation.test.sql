begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

select has_table('public', 'catalog_observations', '1 · existen observaciones inmutables');
select has_table('public', 'catalog_attribute_provenance', '2 · existe la resolución de procedencia');
select has_table('public', 'catalog_systems', '3 · existen sistemas canónicos');
select has_table('public', 'catalog_classes', '4 · existen clases estructuradas');
select has_table('public', 'catalog_relation_rules', '5 · existen relaciones entre clases');
select has_view('public', 'graph_product_nodes_v1', '6 · existe el contrato de nodos de producto');
select has_view('public', 'graph_relation_edges_v1', '7 · existe el contrato de aristas de conocimiento');
select has_column('public', 'product_attribute_values', 'provenance_id', '8 · el hecho de producto puede explicar su procedencia');
select has_column('public', 'variant_attribute_values', 'provenance_id', '9 · el hecho de variante puede explicar su procedencia');

select is(
  (select count(*)::integer
   from public.catalog_stages stage
   join public.catalog_systems system on system.id = stage.system_id
   where system.code = 'ACRYLIC'),
  8,
  '10 · Acrílico conserva el flujo base y suma extensión, mantenimiento y remoción'
);

select results_eq(
  $$ select decision_status
     from public.catalog_relation_rules
     where code = 'ACRYLIC_POLYMER_REQUIRES_MONOMER' $$,
  $$ values ('approved'::text) $$,
  '11 · la regla de Acrílico queda aprobada después de adjuntar evidencia oficial'
);

create temporary table fx on commit drop as
select
  value.id as attribute_value_id,
  value.product_id,
  value.attribute_definition_id,
  value.option_id,
  value.value_text,
  value.value_number,
  value.value_boolean,
  value.value_date,
  value.value_json,
  (select other.id from public.products other where other.id <> value.product_id order by other.id limit 1) as target_product_id
from public.product_attribute_values value
order by value.id
limit 1;

insert into public.catalog_sources(
  id, source_key, name, authority, adapter, base_url
) values (
  '85000000-0000-4000-8000-000000000001', 'pgtap-knowledge-source',
  'Fuente de prueba de conocimiento', 'internal_document', 'manual_capture',
  'https://example.invalid/bellaroshe-knowledge-test'
);

insert into public.catalog_source_snapshots(
  id, source_id, status, started_at, completed_at, content_hash
) values (
  '85000000-0000-4000-8000-000000000002',
  '85000000-0000-4000-8000-000000000001',
  'succeeded', now(), now(), 'pgtap-knowledge-snapshot'
);

insert into public.catalog_source_records(
  id, snapshot_id, source_id, entity_type, external_id, title, source_url, captured_at
) values (
  '85000000-0000-4000-8000-000000000003',
  '85000000-0000-4000-8000-000000000002',
  '85000000-0000-4000-8000-000000000001',
  'document', 'knowledge-test-record', 'Documento de prueba',
  'https://example.invalid/bellaroshe-knowledge-test/document', now()
);

select lives_ok(
  $$ insert into public.catalog_observations(
       id, observation_key, source_record_id, product_id, attribute_definition_id,
       option_id, value_text, value_number, value_boolean, value_date, value_json,
       observed_at, extraction_method, confidence
     )
     select
       '85000000-0000-4000-8000-000000000004', 'pgtap-observation',
       '85000000-0000-4000-8000-000000000003', product_id, attribute_definition_id,
       option_id, value_text, value_number, value_boolean, value_date, value_json,
       now(), 'internal_document', 1
     from fx $$,
  '12 · una observación tipada puede registrarse sin modificar el hecho'
);

select throws_ok(
  $$ update public.catalog_observations
     set confidence = 0.5
     where id = '85000000-0000-4000-8000-000000000004' $$,
  '55000',
  'Las observaciones son inmutables; registre una nueva observación.',
  '13 · una observación no se reescribe'
);

insert into public.catalog_attribute_provenance(
  id, product_id, attribute_definition_id, resolution_method
)
select
  '85000000-0000-4000-8000-000000000005', product_id,
  attribute_definition_id, 'human_override'
from fx;

insert into public.catalog_provenance_observations(provenance_id, observation_id, stance)
values (
  '85000000-0000-4000-8000-000000000005',
  '85000000-0000-4000-8000-000000000004',
  'supports'
);

select lives_ok(
  $$ update public.catalog_attribute_provenance
     set decision_status = 'approved', decided_at = now(),
         rationale = 'Coincidencia exacta comprobada por pgTAP.'
     where id = '85000000-0000-4000-8000-000000000005' $$,
  '14 · una procedencia con observación de apoyo puede aprobarse'
);

select lives_ok(
  $$ update public.product_attribute_values
     set provenance_id = '85000000-0000-4000-8000-000000000005'
     where id = (select attribute_value_id from fx) $$,
  '15 · el hecho operativo acepta la procedencia cuando el valor coincide exactamente'
);

insert into public.catalog_evidence_sets(
  id, evidence_key, evidence_type, decision_status, confidence,
  rationale, decided_at
) values (
  '85000000-0000-4000-8000-000000000006', 'pgtap-human-evidence',
  'human_review', 'approved', 1, 'Decisión humana aislada de prueba.', now()
);

select ok(
  public.catalog_assert_approved_evidence('85000000-0000-4000-8000-000000000006'),
  '16 · una afirmación puede comprobar que su evidencia está aprobada'
);

insert into public.catalog_classes(
  id, code, name, target_scope
) values (
  '85000000-0000-4000-8000-000000000007',
  'PGTAP_MATCHING_CLASS', 'Clase calculada de prueba', 'product'
);

insert into public.catalog_class_rules(
  id, class_id, value_source, attribute_definition_id, operator,
  option_id, value_text, value_number, value_boolean, value_date, value_json,
  decision_status, evidence_set_id
)
select
  '85000000-0000-4000-8000-000000000008',
  '85000000-0000-4000-8000-000000000007', 'product',
  attribute_definition_id, 'equals', option_id, value_text, value_number,
  value_boolean, value_date, value_json, 'approved',
  '85000000-0000-4000-8000-000000000006'
from fx;

select ok(
  public.catalog_class_rule_matches(
    '85000000-0000-4000-8000-000000000008',
    (select product_id from fx), null
  ),
  '17 · la regla tipada reconoce el valor operativo coincidente'
);

select ok(
  public.refresh_catalog_class_members('85000000-0000-4000-8000-000000000007') > 0,
  '18 · la membresía de clase se materializa desde las reglas aprobadas'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   where membership.class_id = '85000000-0000-4000-8000-000000000007'
     and membership.product_id = (select product_id from fx)
     and membership.origin = 'rule'
     and membership.decision_status = 'approved'),
  1,
  '19 · el producto esperado queda como miembro calculado'
);

select is(
  (select count(*)::integer
   from public.graph_class_membership_edges_v1 edge
   where edge.target_key = 'class:85000000-0000-4000-8000-000000000007'
     and edge.source_key = 'product:' || (select product_id::text from fx)),
  1,
  '20 · la membresía aprobada aparece en la proyección'
);

insert into public.product_system_roles(
  id, product_id, system_id, stage_id, role_id,
  decision_status, evidence_set_id
)
select
  '85000000-0000-4000-8000-000000000009', fx.product_id,
  system.id, stage.id, role.id, 'approved',
  '85000000-0000-4000-8000-000000000006'
from fx
join public.catalog_systems system on system.code = 'ACRYLIC'
join public.catalog_stages stage on stage.system_id = system.id and stage.code = 'CONSTRUCTION'
join public.catalog_roles role on role.code = 'POLYMER_COMPONENT';

select is(
  (select count(*)::integer
   from public.product_system_roles
   where id = '85000000-0000-4000-8000-000000000009'),
  1,
  '21 · un producto puede ocupar un rol aprobado dentro de una etapa'
);

select is(
  (select count(*)::integer
   from public.graph_system_role_edges_v1
   where edge_key like 'system-role:85000000-0000-4000-8000-000000000009:%'),
  2,
  '22 · el rol produce aristas separadas hacia sistema y etapa'
);

insert into public.product_relations(
  id, source_product_id, target_product_id, relation_type,
  compatibility_status, knowledge_status, evidence_set_id, decided_at
)
select
  '85000000-0000-4000-8000-000000000010', product_id, target_product_id,
  'requires', 'confirmed', 'approved',
  '85000000-0000-4000-8000-000000000006', now()
from fx;

select is(
  (select count(*)::integer
   from public.graph_requires_edges_v1
   where edge_key = 'product-relation:85000000-0000-4000-8000-000000000010'),
  1,
  '23 · una relación específica aprobada entra al grafo'
);

insert into public.product_relations(
  id, source_product_id, target_product_id, relation_type,
  compatibility_status, knowledge_status
)
select
  '85000000-0000-4000-8000-000000000011', product_id, target_product_id,
  'recommended_with', 'unknown', 'needs_evidence'
from fx;

select is(
  (select count(*)::integer
   from public.graph_relation_edges_v1
   where edge_key = 'product-relation:85000000-0000-4000-8000-000000000011'),
  0,
  '24 · una relación pendiente nunca entra al grafo aprobado'
);

select is(
  public.export_graph_projection_v1() ->> 'contractVersion',
  'v1',
  '25 · la exportación declara una versión estable'
);

select is(
  (select count(*)::integer
   from pg_class view
   where view.relnamespace = 'public'::regnamespace
     and view.relkind = 'v'
     and not coalesce(view.reloptions::text like '%security_invoker=true%', false)),
  0,
  '26 · todas las vistas públicas conservan security_invoker'
);

select is(
  (select coalesce(sum(violations), 0)::integer
   from public.catalog_knowledge_gate_v1
   where severity = 'blocking'),
  0,
  '27 · la compuerta no encuentra afirmaciones aprobadas sin evidencia'
);

select has_column(
  'public', 'catalog_relation_candidates', 'resolution_kind',
  '28 · cada candidata puede clasificarse antes de promoverse'
);

select has_view(
  'public', 'catalog_knowledge_gate_v2',
  '29 · la compuerta incorpora el estado de publicación'
);

select is(
  (select coalesce(sum(violations), 0)::integer
   from public.catalog_knowledge_gate_v2
   where severity = 'blocking'),
  0,
  '30 · ningún producto publicado expone hechos pendientes'
);

select * from finish();

rollback;
