begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

select has_table(
  'public', 'catalog_knowledge_gaps',
  '1 · las preguntas no resueltas se conservan como datos estructurados'
);
select has_view(
  'public', 'catalog_acrylic_knowledge_gap_queue_v1',
  '2 · existe la cola accionable del vertical Acrílico'
);
select has_function(
  'public', 'get_catalog_system_coverage_v1', array['text', 'uuid[]'],
  '3 · existe el cálculo de cobertura por sistema'
);
select has_function(
  'public', 'get_catalog_system_recommendations_v1', array['text', 'uuid[]'],
  '4 · existe la recomendación por rol faltante'
);
select has_function(
  'public', 'classify_acrylic_relation_candidates_v1',
  '5 · existe el clasificador reejecutable de candidatas Acrílico'
);

select is(
  (select count(*)::integer
   from public.catalog_stages stage
   join public.catalog_systems system on system.id = stage.system_id
   where system.code = 'ACRYLIC' and stage.is_active),
  7,
  '6 · el flujo Acrílico tiene siete etapas explícitas'
);

select is(
  (select count(*)::integer
   from public.catalog_system_stage_roles expectation
   join public.catalog_systems system on system.id = expectation.system_id
   where system.code = 'ACRYLIC'
     and expectation.decision_status = 'approved'
     and expectation.is_active),
  15,
  '7 · el flujo define quince expectativas de rol aprobadas'
);

select is(
  (select count(*)::integer
   from public.product_system_roles assignment
   join public.catalog_systems system on system.id = assignment.system_id
   where system.code = 'ACRYLIC'
     and assignment.decision_status = 'approved'),
  45,
  '8 · cuarenta y cinco productos ocupan un rol Acrílico demostrado'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code like 'ACRYLIC\_%' escape '\'
     and membership.decision_status = 'approved'),
  46,
  '9 · se materializan cuarenta y seis membresías de clase aprobadas'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code = 'ACRYLIC_POLYMER'
     and membership.decision_status = 'approved'),
  17,
  '10 · diecisiete productos son polímeros identificados'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code = 'ACRYLIC_MONOMER'
     and membership.decision_status = 'approved'),
  4,
  '11 · cuatro productos son monómeros identificados'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code = 'ACRYLIC_KIT'
     and membership.decision_status = 'approved'),
  1,
  '12 · el kit Cherimoya queda separado como kit'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code = 'ACRYLIC_LIQUID_VESSEL'
     and membership.decision_status = 'approved'),
  1,
  '13 · la corona de vidrio queda clasificada como recipiente'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   join public.products product on product.id = membership.product_id
   where class.code = 'ACRYLIC_MONOMER'
     and product.code = 'GEN-SIS-0687B8'
     and membership.decision_status = 'approved'),
  0,
  '14 · el recipiente nunca se trata como monómero'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   join public.products product on product.id = membership.product_id
   where class.code = 'ACRYLIC_POLYMER'
     and product.code = 'CHE-SIS-2D28E7'
     and membership.decision_status = 'approved'),
  0,
  '15 · el kit no se convierte en polímero por su categoría'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   where class.code = 'ACRYLIC_BRUSH'
     and membership.decision_status = 'approved'),
  6,
  '16 · seis pinceles tienen uso Acrílico sustentado'
);

select is(
  (select count(*)::integer
   from public.catalog_classes class
   where class.code in ('ACRYLIC_TIP', 'ACRYLIC_SANITIZER', 'ACRYLIC_DUST_BRUSH')
     and not exists (
       select 1
       from public.catalog_class_members membership
       where membership.class_id = class.id
         and membership.decision_status = 'approved'
     )),
  3,
  '17 · una clase necesaria puede existir sin inventar un producto que la cubra'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_rules rule
   join public.catalog_systems system on system.id = rule.system_id
   where system.code = 'ACRYLIC'
     and rule.decision_status = 'approved'
     and rule.is_active),
  2,
  '18 · el grafo conceptual Acrílico contiene dos reglas aprobadas'
);

select results_eq(
  $$ select compatibility_status::text, brand_policy, requirement_level,
            metadata ->> 'generates_cross_brand_edges'
     from public.catalog_relation_rules
     where code = 'ACRYLIC_POLYMER_REQUIRES_MONOMER' $$,
  $$ values ('conditional'::text, 'explicit_evidence'::text, 'required'::text, 'false'::text) $$,
  '19 · polímero→monómero exige evidencia de la pareja y no cruza marcas solo'
);

select results_eq(
  $$ select relation_type::text, compatibility_status::text, requirement_level,
            metadata ->> 'does_not_imply_product_compatibility'
     from public.catalog_relation_rules
     where code = 'ACRYLIC_FORM_ALTERNATIVE_TO_TIP' $$,
  $$ values ('alternative_to'::text, 'conditional'::text, 'optional'::text, 'true'::text) $$,
  '20 · molde y tip son alternativas conceptuales, no compatibilidad de productos'
);

select is(
  (select count(*)::integer
   from public.graph_relation_edges_v1 edge
   where edge.properties ->> 'ruleCode' in (
     'ACRYLIC_POLYMER_REQUIRES_MONOMER',
     'ACRYLIC_FORM_ALTERNATIVE_TO_TIP'
   )),
  2,
  '21 · las dos reglas aprobadas aparecen en la proyección del grafo'
);

select is(
  (select count(*)::integer
   from public.catalog_evidence_sets evidence
   where evidence.evidence_key like 'ACRYLIC\_%' escape '\'
     and evidence.decision_status = 'approved'),
  6,
  '22 · seis conjuntos separan identidad, proceso, productos, herramientas y seguridad'
);

select is(
  (select count(*)::integer
   from public.catalog_evidence_items item
   join public.catalog_evidence_sets evidence on evidence.id = item.evidence_set_id
   where evidence.evidence_key like 'ACRYLIC\_%' escape '\'
     and evidence.decision_status = 'approved'),
  23,
  '23 · veintitrés citas respaldan las decisiones aprobadas'
);

select is(
  (select count(*)::integer from public.catalog_acrylic_knowledge_gap_queue_v1),
  12,
  '24 · quedan doce brechas concretas y visibles'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_knowledge_gap_queue_v1
   where priority = 'critical'),
  3,
  '25 · tres brechas son críticas para compatibilidad o formulación'
);

select is(
  (select count(*)::integer
   from public.product_system_roles assignment
   join public.products product on product.id = assignment.product_id
   join public.catalog_systems system on system.id = assignment.system_id
   where product.code = 'MCN-PRE-D7C129'
     and system.code = 'ACRYLIC'
     and assignment.decision_status = 'approved'),
  0,
  '26 · MC Bliss no recibe un rol por coincidencia de nombre'
);

select is(
  (select count(*)::integer
   from public.product_system_roles assignment
   join public.products product on product.id = assignment.product_id
   join public.catalog_systems system on system.id = assignment.system_id
   where product.code = 'CHE-SIS-2D28E7'
     and system.code = 'ACRYLIC'
     and assignment.decision_status = 'approved'),
  0,
  '27 · el kit no cubre roles hasta conocer su contenido'
);

select is(
  (select coalesce(sum(gate.violations), 0)::integer
   from public.catalog_knowledge_gate_v2 gate
   where gate.severity = 'blocking'),
  0,
  '28 · la compuerta no encuentra afirmaciones aprobadas sin evidencia'
);

create temporary table fx_selected_products on commit drop as
select array_agg(product.id order by product.code)::uuid[] as product_ids
from public.products product
where product.code in ('ACR-SIS-D2A8F8', 'ACR-SIS-2958BA', 'ACR-PIN-22AEF2');

select is(
  (select count(*)::integer
   from public.get_catalog_system_coverage_v1(
     'ACRYLIC', (select product_ids from fx_selected_products)
   ) coverage
   where coverage.necessity = 'required'),
  3,
  '29 · el núcleo constructivo tiene tres roles obligatorios'
);

select is(
  (select count(*)::integer
   from public.get_catalog_system_coverage_v1(
     'ACRYLIC', (select product_ids from fx_selected_products)
   ) coverage
   where coverage.necessity = 'required' and coverage.is_satisfied),
  3,
  '30 · polvo, monómero y pincel cubren el núcleo obligatorio'
);

select is(
  (select count(*)::integer
   from public.get_catalog_system_coverage_v1(
     'ACRYLIC', (select product_ids from fx_selected_products)
   ) coverage
   where coverage.necessity = 'optional' and coverage.is_satisfied),
  4,
  '31 · los roles opcionales no bloquean aunque no se seleccionen'
);

update public.products
set unit_price = 0
where code = 'ACR-SIS-2958BA';

update public.variant_prices price
set amount = 0
from public.product_variants variant, public.products product
where price.variant_id = variant.id
  and variant.product_id = product.id
  and product.code = 'ACR-SIS-2958BA';

create temporary table fx_recommendations on commit drop as
select recommendation.*
from public.get_catalog_system_recommendations_v1(
  'ACRYLIC',
  array[(select id from public.products where code = 'ACR-SIS-D2A8F8')]::uuid[]
) recommendation;

select is(
  (select count(*)::integer
   from fx_recommendations
   where product_code = 'ACR-SIS-2958BA' and role_code = 'LIQUID_COMPONENT'),
  1,
  '32 · el motor propone el monómero AcryLove para cubrir el rol faltante'
);

select is(
  (select count(*)::integer
   from fx_recommendations
   where role_code = 'LIQUID_COMPONENT' and compatibility_state <> 'unknown_pair'),
  0,
  '33 · ningún monómero se presenta como compatible sin una pareja aprobada'
);

select is(
  (select count(*)::integer
   from fx_recommendations
   where role_code = 'LIQUID_COMPONENT' and not verification_required),
  0,
  '34 · todos los pares polvo–monómero piden verificación'
);

select is(
  (select count(*)::integer
   from fx_recommendations
   where role_code = 'LIQUID_COMPONENT' and compatibility_state = 'confirmed_pair'),
  0,
  '35 · compartir marca no se convierte en compatibilidad confirmada'
);

select ok(
  (select same_brand
   from fx_recommendations
   where product_code = 'ACR-SIS-2958BA' and role_code = 'LIQUID_COMPONENT'),
  '36 · compartir marca se conserva únicamente como señal de ordenamiento'
);

select results_eq(
  $$ select price_state
     from fx_recommendations
     where product_code = 'ACR-SIS-2958BA' and role_code = 'LIQUID_COMPONENT' $$,
  $$ values ('consult'::text) $$,
  '37 · precio cero se comunica como consultar'
);

select ok(
  (select displayed_price is null
   from fx_recommendations
   where product_code = 'ACR-SIS-2958BA' and role_code = 'LIQUID_COMPONENT'),
  '38 · el prototipo no muestra cero como si fuera un precio comercial'
);

select ok(
  exists (
    select 1 from fx_recommendations
    where product_code = 'ACR-SIS-2958BA' and price_state = 'consult'
  ),
  '39 · carecer de precio nunca elimina una recomendación'
);

delete from public.catalog_relation_candidates
where rule_code in ('acrylic_powder->monomer', 'acrylic_powder->primer');

insert into public.catalog_relation_candidates(
  id, source_product_id, target_product_id, relation_type, confidence,
  status, rule_code, rationale, evidence
)
select
  fixture.id,
  source.id,
  target.id,
  fixture.relation_type::public.product_relation_type,
  fixture.confidence,
  'proposed',
  fixture.rule_code,
  'Fixture aislado para comprobar la clasificación.',
  '{}'::jsonb
from (values
  (
    '91000000-0000-4000-8000-000000000001'::uuid,
    'ACR-SIS-D2A8F8', 'ACR-SIS-2958BA', 'requires',
    'same_brand_rule', 'acrylic_powder->monomer'
  ),
  (
    '91000000-0000-4000-8000-000000000002'::uuid,
    'MAS-SIS-47C01E', 'GEN-SIS-0687B8', 'requires',
    'category_rule', 'acrylic_powder->monomer'
  ),
  (
    '91000000-0000-4000-8000-000000000003'::uuid,
    'ACR-SIS-D2A8F8', 'ACR-PRE-1C3A18', 'recommended_with',
    'same_brand_rule', 'acrylic_powder->primer'
  ),
  (
    '91000000-0000-4000-8000-000000000004'::uuid,
    'MCN-SIS-55882A', 'MCN-PRE-D7C129', 'recommended_with',
    'same_brand_rule', 'acrylic_powder->primer'
  )
) as fixture(
  id, source_code, target_code, relation_type, confidence, rule_code
)
join public.products source on source.code = fixture.source_code
join public.products target on target.code = fixture.target_code;

create temporary table fx_classifier_result on commit drop as
select public.classify_acrylic_relation_candidates_v1() as result;

select is(
  (select (result ->> 'total')::integer from fx_classifier_result),
  4,
  '40 · el clasificador resuelve las cuatro clases de caso del fixture'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_candidates
   where id between '91000000-0000-4000-8000-000000000001'::uuid
                and '91000000-0000-4000-8000-000000000004'::uuid
     and resolution_kind = 'class_rule'),
  1,
  '41 · una pareja válida se normaliza como regla de clases'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_candidates
   where id between '91000000-0000-4000-8000-000000000001'::uuid
                and '91000000-0000-4000-8000-000000000004'::uuid
     and resolution_kind = 'incorrect'),
  1,
  '42 · la corona de vidrio se rechaza como destino incorrecto'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_candidates
   where id between '91000000-0000-4000-8000-000000000001'::uuid
                and '91000000-0000-4000-8000-000000000004'::uuid
     and resolution_kind = 'system_role'),
  1,
  '43 · un preparador demostrado se normaliza como rol del sistema'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_candidates
   where id between '91000000-0000-4000-8000-000000000001'::uuid
                and '91000000-0000-4000-8000-000000000004'::uuid
     and resolution_kind = 'insufficient_evidence'),
  1,
  '44 · la coincidencia MC Bliss queda rechazada por evidencia insuficiente'
);

select ok(
  (select promoted_relation_rule_id is not null
   from public.catalog_relation_candidates
   where id = '91000000-0000-4000-8000-000000000001'),
  '45 · la candidata de clase enlaza la regla canónica que la resolvió'
);

select ok(
  (select promoted_system_role_id is not null
   from public.catalog_relation_candidates
   where id = '91000000-0000-4000-8000-000000000003'),
  '46 · la candidata funcional enlaza el rol canónico que la resolvió'
);

select ok(
  (select evidence ? 'decision_reason'
   from public.catalog_relation_candidates
   where id = '91000000-0000-4000-8000-000000000002'),
  '47 · cada rechazo conserva una explicación auditable'
);

select is(
  (select count(*)::integer
   from public.catalog_relation_candidates
   where id between '91000000-0000-4000-8000-000000000001'::uuid
                and '91000000-0000-4000-8000-000000000004'::uuid
     and status in ('proposed', 'needs_evidence')),
  0,
  '48 · el bloque no deja decisiones del fixture a medio resolver'
);

select is(
  (select count(*)::integer
   from public.product_system_roles assignment
   join public.products product on product.id = assignment.product_id
   join public.catalog_systems system on system.id = assignment.system_id
   where product.code = 'MAS-PRE-C83A0D'
     and system.code = 'ACRYLIC'
     and assignment.decision_status = 'approved'),
  0,
  '49 · Masglo Ultrabond no ocupa un rol mientras su función exacta sea ambigua'
);

select is(
  (select count(*)::integer
   from public.catalog_class_members membership
   join public.catalog_classes class on class.id = membership.class_id
   join public.products product on product.id = membership.product_id
   where class.code = 'ACRYLIC_BRUSH'
     and product.code in ('ACR-PIN-5C586F', 'ACR-PIN-D16329')
     and membership.decision_status = 'approved'),
  0,
  '50 · Beautiful #8 y #10 no se clasifican solo por material, marca o categoría'
);

select * from finish();

rollback;
