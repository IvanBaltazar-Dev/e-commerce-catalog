begin;

select plan(24);

-- Términos que distinguen. Marca, número suelto y palabra corta no distinguen.
select is(
  public.catalog_review_discriminative_tokens_v1('LIQUIDO ACRILICO MASGLO ULTRABOND 7 ML'),
  array['acrilico', 'liquido', 'ultrabond'],
  '01 - la marca, el número y las palabras cortas no cuentan como discriminante');
select is(
  public.catalog_review_discriminative_tokens_v1(null),
  array[]::text[],
  '02 - un texto ausente no inventa términos');
select ok(
  not (public.catalog_review_discriminative_tokens_v1('Broca Bola')
       && public.catalog_review_discriminative_tokens_v1('ACRY LOVE BOLSA BLACK CHICA')),
  '03 - una broca y una bolsa no comparten ningún término');
select ok(
  public.catalog_review_discriminative_tokens_v1('Lima 100/150')
  && public.catalog_review_discriminative_tokens_v1('Lima para Uñas 100/150'),
  '04 - dos limas sí comparten término aunque cambie el resto');

-- Código de tono.
select is(public.catalog_review_tone_code_v1('N.º 26'), '26',
  '05 - el código de tono se lee aunque venga con abreviatura');
select is(public.catalog_review_tone_code_v1('26 Golden Brown'), '26',
  '06 - el mismo código se lee cuando encabeza el nombre oficial');
select is(public.catalog_review_tone_code_v1('Rosa Palo'), null,
  '07 - un tono sin número no finge tener código');

-- Sujetos propios, para que el veredicto no dependa del catálogo cargado.
insert into public.brands(id, name, slug, is_active) values
  ('01220000-0000-4000-8000-0000000000f1', 'GATE MARCA CON PRODUCTOS DEMO', 'gate-marca-con-productos-demo', true),
  ('01220000-0000-4000-8000-0000000000f0', 'GATE MARCA VACIA DEMO', 'gate-marca-vacia-demo', true);

create temp table gate_fixture as
select
  (select id from public.catalog_source_records limit 1) as source_record_id,
  '01220000-0000-4000-8000-0000000000f1'::uuid as brand_id,
  (select id from public.categories limit 1) as category_id,
  (select id from public.attribute_templates limit 1) as template_id;

insert into public.products(
  id, code, slug, brand_id, category_id, name, presentation, product_type,
  unit_price, wholesale_price, template_id
)
select
  ids.id, ids.code, ids.slug, gate_fixture.brand_id, gate_fixture.category_id,
  ids.name, '1 unidad', 'accesorio', 10, 8, gate_fixture.template_id
from gate_fixture, (values
  ('01220000-0000-4000-8000-0000000000a1'::uuid, 'GATE-DEMO-0001', 'gate-demo-broca-bola', 'Gate Demo Broca Bola'),
  ('01220000-0000-4000-8000-0000000000a2'::uuid, 'GATE-DEMO-0002', 'gate-demo-brillo-tapa', 'Gate Demo Brillo Tapa'),
  ('01220000-0000-4000-8000-0000000000a3'::uuid, 'GATE-DEMO-0003', 'gate-demo-brillo-seda', 'Gate Demo Brillo Seda'),
  ('01220000-0000-4000-8000-0000000000a4'::uuid, 'GATE-DEMO-0004', 'gate-demo-lima-cientocincuenta', 'Gate Demo Lima Zurquita 100/150'),
  ('01220000-0000-4000-8000-0000000000a5'::uuid, 'GATE-DEMO-0005', 'gate-demo-tono-bigen', 'Gate Demo Tono Bigen')
) as ids(id, code, slug, name);

-- Caso 1 · pareja sin ningún término en común.
-- Casos 2 y 3 · dos productos internos reclaman el mismo registro oficial.
-- Caso 4 · identidad de tono ya resuelta por el código oficial.
-- Caso 5 · pareja coherente y con ventaja clara: sigue siendo humana.
-- Cada caso apunta a un registro oficial distinto salvo los dos de colisión,
-- que comparten registro justamente porque eso es lo que se está probando.
create temp table gate_records as
select id, row_number() over (order by id) as pos
from public.catalog_source_records
where entity_type = 'product'
limit 4;

insert into public.catalog_reconciliation_cases(
  id, entity_type, product_id, source_record_id, algorithm, score, status, evidence, case_key
)
select caso.id, 'product', caso.product_id,
       (select id from gate_records where pos = caso.record_pos),
       caso.algorithm, caso.score, 'needs_review', caso.evidence, caso.case_key
from (values
  ('01220000-0000-4000-8000-000000000001'::uuid, '01220000-0000-4000-8000-0000000000a1'::uuid, 1,
   'official_product_name_and_code_v1', 0.51900::numeric,
   '{"internal_name":"Broca Bola","official_title":"ACRY LOVE BOLSA BLACK CHICA","candidate_2_score":0.4667}'::jsonb,
   'gate-necesidad-sin-discriminante'),
  ('01220000-0000-4000-8000-000000000002'::uuid, '01220000-0000-4000-8000-0000000000a2'::uuid, 2,
   'official_product_name_and_code_v1', 0.69000,
   '{"internal_name":"Brillo Gel Tapa","official_title":"BRILLO GEL EVOLUTION","candidate_2_score":0.60}',
   'gate-necesidad-colision-a'),
  ('01220000-0000-4000-8000-000000000003'::uuid, '01220000-0000-4000-8000-0000000000a3'::uuid, 2,
   'official_product_name_and_code_v1', 0.68000,
   '{"internal_name":"Brillo Seda","official_title":"BRILLO GEL EVOLUTION","candidate_2_score":0.59}',
   'gate-necesidad-colision-b'),
  ('01220000-0000-4000-8000-000000000004'::uuid, '01220000-0000-4000-8000-0000000000a5'::uuid, 3,
   'exact_normalized_tone_or_official_code_v1', 1,
   '{"internal_tone":"N.º 26","official_tone":"26 Golden Brown","official_url":"https://www.bigen-usa.com/products/permanent-powder"}',
   'gate-necesidad-tono-codigo'),
  ('01220000-0000-4000-8000-000000000005'::uuid, '01220000-0000-4000-8000-0000000000a4'::uuid, 4,
   'official_product_name_and_code_v1', 0.82000,
   '{"internal_name":"Lima 100/150","official_title":"Lima para Uñas 100/150","candidate_2_score":0.55}',
   'gate-necesidad-decision-real')
) as caso(id, product_id, record_pos, algorithm, score, evidence, case_key);

select public.register_catalog_review_work_item_v1(
  'gate-necesidad-sin-discriminante', 'reconciliation_case',
  '01220000-0000-4000-8000-000000000001', 'decision', 'identity', 'product', null,
  'gate-necesidad-fingerprint-0001', '¿Este registro oficial corresponde al producto interno?');
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-colision-a', 'reconciliation_case',
  '01220000-0000-4000-8000-000000000002', 'decision', 'identity', 'product', null,
  'gate-necesidad-fingerprint-0002', '¿Este registro oficial corresponde al producto interno?');
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-colision-b', 'reconciliation_case',
  '01220000-0000-4000-8000-000000000003', 'decision', 'identity', 'product', null,
  'gate-necesidad-fingerprint-0003', '¿Este registro oficial corresponde al producto interno?');
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-tono-codigo', 'reconciliation_case',
  '01220000-0000-4000-8000-000000000004', 'decision', 'tone', 'product', null,
  'gate-necesidad-fingerprint-0004', '¿El tono interno y el oficial son el mismo color?');
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-decision-real', 'reconciliation_case',
  '01220000-0000-4000-8000-000000000005', 'decision', 'identity', 'product', null,
  'gate-necesidad-fingerprint-0005', '¿Este registro oficial corresponde al producto interno?');

-- Caso 6 y 7 · filas fuente: una irrecuperable y otra con destino claro.
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-fila-colgada', 'enrichment_exception',
  '01220000-0000-4000-8000-0000000000e1', 'decision', 'identity', 'other', null,
  'gate-necesidad-fingerprint-0006',
  'SOURCE_ROW: ARTEFACTO QUE NO EXISTE EN NINGUN CATALOGO ZZZQ',
  null, null, 'normal', 'normal', false, 0, 0, 1::smallint,
  '{"details":{"source_scope":"SOURCE_ROW","required_action":"REVISAR_Y_APROBAR_MANUALMENTE"}}');
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-fila-con-destino', 'enrichment_exception',
  '01220000-0000-4000-8000-0000000000e2', 'decision', 'identity', 'other', null,
  'gate-necesidad-fingerprint-0007',
  'SOURCE_ROW: GATE DEMO LIMA ZURQUITA 100/150',
  null, null, 'normal', 'normal', false, 0, 0, 1::smallint,
  '{"details":{"source_scope":"SOURCE_ROW","required_action":"REVISAR_Y_APROBAR_MANUALMENTE"}}');

-- Caso 8 · encargo de investigación sobre una marca real del catálogo.
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-investigacion-marca', 'enrichment_exception',
  '01220000-0000-4000-8000-0000000000e3', 'decision', 'identity', 'brand',
  (select brand_id from gate_fixture),
  'gate-necesidad-fingerprint-0008', 'BRAND: MARCA CON PRODUCTOS',
  null, null, 'normal', 'normal', false, 0, 0, 1::smallint,
  '{"details":{"source_scope":"BRAND","required_action":"BUSCAR_FABRICANTE_DISTRIBUIDOR_Y_CONTRASTAR_ENVASE"}}');

-- Caso 9 · marca sin ningún producto en el catálogo.
select public.register_catalog_review_work_item_v1(
  'gate-necesidad-marca-vacia', 'enrichment_exception',
  '01220000-0000-4000-8000-0000000000e4', 'decision', 'identity', 'brand',
  '01220000-0000-4000-8000-0000000000f0',
  'gate-necesidad-fingerprint-0009', 'BRAND: GATE MARCA VACIA DEMO',
  null, null, 'normal', 'normal', false, 0, 0, 1::smallint,
  '{"details":{"source_scope":"BRAND","required_action":"REVISAR_Y_APROBAR_MANUALMENTE"}}');

create temp table gate_verdicts as
select item.work_family_key, necessity.verdict, item.business_relevance
from public.catalog_review_work_items item
left join public.catalog_review_necessity_v1 necessity on necessity.work_item_id = item.id
where item.work_family_key like 'gate-necesidad-%';

select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-sin-discriminante'),
  'matcher_without_discriminator',
  '08 - una pareja sin término común no llega a la propietaria');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-colision-a'),
  'matcher_collides_many_to_one',
  '09 - dos reclamantes del mismo registro oficial se retiran juntos');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-colision-b'),
  'matcher_collides_many_to_one',
  '10 - el segundo reclamante recibe el mismo trato que el primero');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-decision-real'),
  'human_decision',
  '11 - una pareja coherente y con ventaja clara sigue siendo decisión humana');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-fila-colgada'),
  'source_row_reference_unresolvable',
  '12 - una fila fuente sin ningún producto parecido no es una pregunta');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-fila-con-destino'),
  'human_decision',
  '13 - una fila fuente con destino interno claro sí se pregunta');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-investigacion-marca'),
  'action_is_research_not_decision',
  '14 - buscar fabricante es investigación, no decisión comercial');
select is((select verdict from gate_verdicts where work_family_key='gate-necesidad-marca-vacia'),
  'subject_without_commercial_footprint',
  '15 - una marca sin productos no desbloquea nada');

-- Relevancia comercial: cuántos productos del catálogo quedan afectados.
select is(
  (select business_relevance from gate_verdicts where work_family_key='gate-necesidad-investigacion-marca'),
  least(100, (select count(*) from public.products
              where brand_id=(select brand_id from gate_fixture) and is_active))::numeric,
  '16 - la relevancia de una marca es su número de productos activos');
select is(
  (select business_relevance from gate_verdicts where work_family_key='gate-necesidad-marca-vacia'),
  0::numeric,
  '17 - una marca sin productos vale cero');

-- El plan degrada, nunca borra ni resuelve por su cuenta.
create temp table gate_plan as
select item.work_family_key, plan.planned_action, plan.rule_code,
       plan.target_status, plan.target_handling_class
from public.catalog_review_reprocess_plan_v1 plan
join public.catalog_review_work_items item on item.id = plan.work_item_id
where item.work_family_key like 'gate-necesidad-%';

select is((select planned_action from gate_plan where work_family_key='gate-necesidad-sin-discriminante'),
  'reclassify', '18 - el ruido se reclasifica, no se cierra');
select is((select target_handling_class from gate_plan where work_family_key='gate-necesidad-sin-discriminante'),
  'automatic_debt', '19 - el destino del ruido es deuda automática');
select is((select target_status from gate_plan where work_family_key='gate-necesidad-sin-discriminante'),
  'open', '20 - el trabajo sigue abierto: el sistema lo sigue debiendo');
select is((select planned_action from gate_plan where work_family_key='gate-necesidad-decision-real'),
  'keep', '21 - una decisión real no se toca');
select is((select rule_code from gate_plan where work_family_key='gate-necesidad-tono-codigo'),
  'objective_tone_code_identity',
  '22 - la identidad de tono con código idéntico se reconoce sola');
select is((select planned_action from gate_plan where work_family_key='gate-necesidad-tono-codigo'),
  'auto_resolve', '23 - y se resuelve sin pasar por la propietaria');

select is(
  (select count(*) from gate_plan
   where rule_code in (
     'matcher_without_discriminator', 'matcher_collides_many_to_one',
     'matcher_candidates_indistinguishable', 'source_row_reference_unresolvable',
     'source_row_resemblance_too_weak', 'subject_without_commercial_footprint',
     'action_is_research_not_decision')
     and (target_status <> 'open' or target_handling_class <> 'automatic_debt')),
  0::bigint,
  '24 - ninguna regla de la compuerta cierra trabajo ni cambia nada comercial');

select * from finish();
rollback;
