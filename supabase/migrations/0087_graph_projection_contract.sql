-- ---------------------------------------------------------------------------
-- 0087 · GRAPH PROJECTION CONTRACT v1
-- ---------------------------------------------------------------------------
-- Estas vistas no son otra fuente de verdad. Son una representación estable,
-- descartable y reconstruible del modelo canónico de PostgreSQL. Neo4j u otro
-- consumidor solo puede importar este contrato; nunca escribir decisiones.

begin;

create or replace view public.graph_product_nodes_v1
with (security_invoker = true) as
select
  'product:' || product.id::text as node_key,
  'Product'::text as node_type,
  product.id as entity_id,
  product.name as label,
  jsonb_strip_nulls(jsonb_build_object(
    'code', product.code,
    'brandId', product.brand_id,
    'categoryId', product.category_id,
    'templateId', product.template_id,
    'lineId', product.product_line_id,
    'editorialStatus', product.editorial_status,
    'isActive', product.is_active
  )) as properties
from public.products product;

create or replace view public.graph_variant_nodes_v1
with (security_invoker = true) as
select
  'variant:' || variant.id::text as node_key,
  'Variant'::text as node_type,
  variant.id as entity_id,
  variant.name as label,
  jsonb_strip_nulls(jsonb_build_object(
    'sku', variant.sku,
    'barcode', variant.barcode,
    'productId', variant.product_id,
    'shadeId', variant.color_shade_id,
    'availability', variant.availability_status,
    'isActive', variant.is_active
  )) as properties
from public.product_variants variant;

create or replace view public.graph_class_nodes_v1
with (security_invoker = true) as
select
  'class:' || class.id::text as node_key,
  'Class'::text as node_type,
  class.id as entity_id,
  class.name as label,
  jsonb_build_object(
    'code', class.code,
    'targetScope', class.target_scope,
    'isActive', class.is_active
  ) as properties
from public.catalog_classes class;

create or replace view public.graph_system_nodes_v1
with (security_invoker = true) as
select
  'system:' || system.id::text as node_key,
  'System'::text as node_type,
  system.id as entity_id,
  system.name as label,
  jsonb_build_object(
    'code', system.code,
    'domain', system.domain,
    'sortOrder', system.sort_order,
    'isActive', system.is_active
  ) as properties
from public.catalog_systems system;

create or replace view public.graph_stage_nodes_v1
with (security_invoker = true) as
select
  'stage:' || stage.id::text as node_key,
  'Stage'::text as node_type,
  stage.id as entity_id,
  stage.name as label,
  jsonb_build_object(
    'code', stage.code,
    'systemId', stage.system_id,
    'position', stage.position,
    'isActive', stage.is_active
  ) as properties
from public.catalog_stages stage;

create or replace view public.graph_brand_nodes_v1
with (security_invoker = true) as
select
  'brand:' || brand.id::text as node_key,
  'Brand'::text as node_type,
  brand.id as entity_id,
  brand.name as label,
  jsonb_build_object(
    'slug', brand.slug,
    'isActive', brand.is_active,
    'isGeneric', brand.is_generic
  ) as properties
from public.brands brand;

create or replace view public.graph_supplier_nodes_v1
with (security_invoker = true) as
select
  'supplier:' || supplier.id::text as node_key,
  'Supplier'::text as node_type,
  supplier.id as entity_id,
  coalesce(supplier.trade_name, supplier.legal_name) as label,
  jsonb_strip_nulls(jsonb_build_object(
    'code', supplier.code,
    'kind', supplier.kind,
    'status', supplier.status,
    'countryCode', supplier.country_code
  )) as properties
from public.suppliers supplier;

create or replace view public.graph_variant_edges_v1
with (security_invoker = true) as
select
  'product-variant:' || variant.id::text as edge_key,
  'product:' || variant.product_id::text as source_key,
  'HAS_VARIANT'::text as predicate,
  'variant:' || variant.id::text as target_key,
  jsonb_build_object('isDefault', variant.is_default, 'sortOrder', variant.sort_order) as properties
from public.product_variants variant;

create or replace view public.graph_brand_edges_v1
with (security_invoker = true) as
select
  'product-brand:' || product.id::text as edge_key,
  'product:' || product.id::text as source_key,
  'MADE_BY'::text as predicate,
  'brand:' || product.brand_id::text as target_key,
  '{}'::jsonb as properties
from public.products product
where product.brand_id is not null;

create or replace view public.graph_stage_system_edges_v1
with (security_invoker = true) as
select
  'stage-system:' || stage.id::text as edge_key,
  'stage:' || stage.id::text as source_key,
  'PART_OF'::text as predicate,
  'system:' || stage.system_id::text as target_key,
  jsonb_build_object('position', stage.position) as properties
from public.catalog_stages stage;

create or replace view public.graph_system_role_edges_v1
with (security_invoker = true) as
select
  'system-role:' || assignment.id::text || ':system' as edge_key,
  assignment.target_ref as source_key,
  'BELONGS_TO'::text as predicate,
  'system:' || assignment.system_id::text as target_key,
  jsonb_build_object(
    'roleId', assignment.role_id,
    'isPrimary', assignment.is_primary,
    'isRequired', assignment.is_required
  ) as properties
from public.product_system_roles assignment
where assignment.decision_status = 'approved'
union all
select
  'system-role:' || assignment.id::text || ':stage' as edge_key,
  assignment.target_ref as source_key,
  'USED_IN'::text as predicate,
  'stage:' || assignment.stage_id::text as target_key,
  jsonb_build_object(
    'systemId', assignment.system_id,
    'roleId', assignment.role_id,
    'isPrimary', assignment.is_primary,
    'isRequired', assignment.is_required
  ) as properties
from public.product_system_roles assignment
where assignment.decision_status = 'approved';

create or replace view public.graph_class_membership_edges_v1
with (security_invoker = true) as
select
  'class-member:' || membership.id::text as edge_key,
  membership.target_ref as source_key,
  'MEMBER_OF'::text as predicate,
  'class:' || membership.class_id::text as target_key,
  jsonb_build_object(
    'origin', membership.origin,
    'ruleGroup', membership.source_rule_group
  ) as properties
from public.catalog_class_members membership
where membership.decision_status = 'approved';

create or replace view public.graph_relation_edges_v1
with (security_invoker = true) as
select
  'product-relation:' || relation.id::text as edge_key,
  relation.source_ref as source_key,
  case
    when relation.relation_type = 'compatible_with'
      and relation.compatibility_status = 'not_compatible' then 'INCOMPATIBLE_WITH'
    else upper(relation.relation_type::text)
  end as predicate,
  relation.target_ref as target_key,
  jsonb_strip_nulls(jsonb_build_object(
    'assertionKind', 'specific_fact',
    'compatibilityStatus', relation.compatibility_status,
    'sortOrder', relation.sort_order
  )) as properties
from public.product_relations relation
where relation.is_active and relation.knowledge_status = 'approved'
union all
select
  'relation-rule:' || rule.id::text as edge_key,
  'class:' || rule.source_class_id::text as source_key,
  case
    when rule.relation_type = 'compatible_with'
      and rule.compatibility_status = 'not_compatible' then 'INCOMPATIBLE_WITH'
    else upper(rule.relation_type::text)
  end as predicate,
  'class:' || rule.target_class_id::text as target_key,
  jsonb_strip_nulls(jsonb_build_object(
    'assertionKind', 'class_rule',
    'ruleCode', rule.code,
    'compatibilityStatus', rule.compatibility_status,
    'systemId', rule.system_id,
    'stageId', rule.stage_id,
    'requirementLevel', rule.requirement_level,
    'brandPolicy', rule.brand_policy
  )) as properties
from public.catalog_relation_rules rule
where rule.is_active and rule.decision_status = 'approved';

create or replace view public.graph_requires_edges_v1
with (security_invoker = true) as
select * from public.graph_relation_edges_v1 where predicate = 'REQUIRES';

create or replace view public.graph_compatible_edges_v1
with (security_invoker = true) as
select * from public.graph_relation_edges_v1 where predicate = 'COMPATIBLE_WITH';

create or replace view public.graph_incompatible_edges_v1
with (security_invoker = true) as
select * from public.graph_relation_edges_v1 where predicate = 'INCOMPATIBLE_WITH';

create or replace view public.graph_recommended_edges_v1
with (security_invoker = true) as
select * from public.graph_relation_edges_v1 where predicate = 'RECOMMENDED_WITH';

create or replace view public.graph_supplier_edges_v1
with (security_invoker = true) as
select
  'catalog-supplier:' || offer.id::text as edge_key,
  case
    when offer.product_id is not null then 'product:' || offer.product_id::text
    else 'variant:' || offer.variant_id::text
  end as source_key,
  'OFFERED_BY'::text as predicate,
  'supplier:' || offer.supplier_id::text as target_key,
  jsonb_strip_nulls(jsonb_build_object(
    'scopeType', offer.scope_type,
    'supplierSku', offer.supplier_sku,
    'isPreferred', offer.is_preferred,
    'priority', offer.priority
  )) as properties
from public.product_suppliers offer
where offer.is_active;

create or replace view public.graph_projection_manifest_v1
with (security_invoker = true) as
select *
from (values
  ('v1', 'node', 'Product', 'graph_product_nodes_v1', 'Producto editorial'),
  ('v1', 'node', 'Variant', 'graph_variant_nodes_v1', 'Unidad vendible'),
  ('v1', 'node', 'Class', 'graph_class_nodes_v1', 'Clase estructurada'),
  ('v1', 'node', 'System', 'graph_system_nodes_v1', 'Sistema o técnica'),
  ('v1', 'node', 'Stage', 'graph_stage_nodes_v1', 'Etapa ordenada'),
  ('v1', 'node', 'Brand', 'graph_brand_nodes_v1', 'Marca'),
  ('v1', 'node', 'Supplier', 'graph_supplier_nodes_v1', 'Proveedor interno'),
  ('v1', 'edge', 'HAS_VARIANT', 'graph_variant_edges_v1', 'Producto contiene variante'),
  ('v1', 'edge', 'MADE_BY', 'graph_brand_edges_v1', 'Producto fabricado por marca'),
  ('v1', 'edge', 'PART_OF', 'graph_stage_system_edges_v1', 'Etapa pertenece a sistema'),
  ('v1', 'edge', 'SYSTEM_ROLE', 'graph_system_role_edges_v1', 'Producto o variante participa en sistema y etapa'),
  ('v1', 'edge', 'MEMBER_OF', 'graph_class_membership_edges_v1', 'Producto o variante pertenece a clase'),
  ('v1', 'edge', 'RELATION', 'graph_relation_edges_v1', 'Hecho específico o regla de clase'),
  ('v1', 'edge', 'OFFERED_BY', 'graph_supplier_edges_v1', 'Oferta de proveedor')
) contract(version, record_kind, graph_type, view_name, description);

create or replace function public.export_graph_projection_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with nodes as (
    select * from public.graph_product_nodes_v1
    union all select * from public.graph_variant_nodes_v1
    union all select * from public.graph_class_nodes_v1
    union all select * from public.graph_system_nodes_v1
    union all select * from public.graph_stage_nodes_v1
    union all select * from public.graph_brand_nodes_v1
    union all select * from public.graph_supplier_nodes_v1
  ), edges as (
    select * from public.graph_variant_edges_v1
    union all select * from public.graph_brand_edges_v1
    union all select * from public.graph_stage_system_edges_v1
    union all select * from public.graph_system_role_edges_v1
    union all select * from public.graph_class_membership_edges_v1
    union all select * from public.graph_relation_edges_v1
    union all select * from public.graph_supplier_edges_v1
  )
  select jsonb_build_object(
    'contractVersion', 'v1',
    'generatedAt', statement_timestamp(),
    'nodes', coalesce((select jsonb_agg(to_jsonb(node) order by node.node_key) from nodes node), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(to_jsonb(edge) order by edge.edge_key) from edges edge), '[]'::jsonb)
  );
$function$;

revoke execute on function public.export_graph_projection_v1() from public, anon;
grant execute on function public.export_graph_projection_v1() to authenticated, service_role;

-- La compuerta no exige que todo esté investigado; exige que nada aprobado
-- carezca de evidencia y hace visibles las deudas que todavía son candidatas.
create or replace view public.catalog_knowledge_gate_v1
with (security_invoker = true) as
select
  'operational_provenance_invalid'::text as check_code,
  'blocking'::text as severity,
  count(*) = 0 as passed,
  count(*)::bigint as violations,
  'Valores operativos que apuntan a una procedencia inexistente, no aprobada o de otro hecho.'::text as description
from (
  select value.id
  from public.product_attribute_values value
  left join public.catalog_attribute_provenance provenance on provenance.id = value.provenance_id
  where value.provenance_id is not null
    and (
      provenance.id is null
      or provenance.decision_status <> 'approved'
      or provenance.target_ref <> 'product:' || value.product_id::text
      or provenance.attribute_definition_id <> value.attribute_definition_id
    )
  union all
  select value.id
  from public.variant_attribute_values value
  left join public.catalog_attribute_provenance provenance on provenance.id = value.provenance_id
  where value.provenance_id is not null
    and (
      provenance.id is null
      or provenance.decision_status <> 'approved'
      or provenance.target_ref <> 'variant:' || value.variant_id::text
      or provenance.attribute_definition_id <> value.attribute_definition_id
    )
) invalid
union all
select
  'approved_evidence_without_items', 'blocking', count(*) = 0, count(*)::bigint,
  'Conjuntos de evidencia aprobados sin observación o registro fuente; human_review es la única excepción.'
from public.catalog_evidence_sets evidence
where evidence.decision_status = 'approved'
  and evidence.evidence_type <> 'human_review'
  and not exists (
    select 1 from public.catalog_evidence_items item
    where item.evidence_set_id = evidence.id and item.stance = 'supports'
  )
union all
select
  'approved_system_roles_without_evidence', 'blocking', count(*) = 0, count(*)::bigint,
  'Roles de producto aprobados sin evidencia aprobada.'
from public.product_system_roles assignment
where assignment.decision_status = 'approved'
  and not public.catalog_assert_approved_evidence(assignment.evidence_set_id)
union all
select
  'approved_manual_members_without_evidence', 'blocking', count(*) = 0, count(*)::bigint,
  'Membresías manuales aprobadas sin evidencia aprobada.'
from public.catalog_class_members membership
where membership.origin = 'manual' and membership.decision_status = 'approved'
  and not public.catalog_assert_approved_evidence(membership.evidence_set_id)
union all
select
  'approved_class_rules_without_evidence', 'blocking', count(*) = 0, count(*)::bigint,
  'Reglas de clase aprobadas sin evidencia aprobada.'
from public.catalog_class_rules rule
where rule.decision_status = 'approved'
  and not public.catalog_assert_approved_evidence(rule.evidence_set_id)
union all
select
  'approved_relation_rules_without_evidence', 'blocking', count(*) = 0, count(*)::bigint,
  'Reglas de relación aprobadas sin evidencia aprobada.'
from public.catalog_relation_rules rule
where rule.decision_status = 'approved'
  and not public.catalog_assert_approved_evidence(rule.evidence_set_id)
union all
select
  'approved_specific_relations_without_evidence', 'blocking', count(*) = 0, count(*)::bigint,
  'Relaciones específicas aprobadas sin evidencia aprobada.'
from public.product_relations relation
where relation.knowledge_status = 'approved'
  and not public.catalog_assert_approved_evidence(relation.evidence_set_id)
union all
select
  'legacy_unverified_relations', 'warning', count(*) = 0, count(*)::bigint,
  'Relaciones heredadas que se conservan pero no entran al grafo aprobado.'
from public.product_relations relation
where relation.knowledge_status = 'legacy_unverified'
union all
select
  'pending_relation_candidates', 'info', count(*) = 0, count(*)::bigint,
  'Candidatas pendientes de clasificar como hecho, regla, rol, membresía o descarte.'
from public.catalog_relation_candidates candidate
where candidate.status in ('proposed', 'needs_evidence', 'approved');

grant select on
  public.graph_product_nodes_v1, public.graph_variant_nodes_v1,
  public.graph_class_nodes_v1, public.graph_system_nodes_v1,
  public.graph_stage_nodes_v1, public.graph_brand_nodes_v1,
  public.graph_variant_edges_v1, public.graph_brand_edges_v1,
  public.graph_stage_system_edges_v1, public.graph_system_role_edges_v1,
  public.graph_class_membership_edges_v1, public.graph_relation_edges_v1,
  public.graph_requires_edges_v1, public.graph_compatible_edges_v1,
  public.graph_incompatible_edges_v1, public.graph_recommended_edges_v1,
  public.graph_projection_manifest_v1
to anon, authenticated, service_role;

grant select on public.graph_supplier_nodes_v1, public.graph_supplier_edges_v1
to authenticated, service_role;
grant select on public.catalog_knowledge_gate_v1 to authenticated, service_role;

comment on function public.export_graph_projection_v1() is
  'Exportación reconstruible del Knowledge Graph. Nunca acepta escrituras y no contiene precio, stock ni decisiones propias.';
comment on view public.catalog_knowledge_gate_v1 is
  'Compuerta de integridad del conocimiento: separa bloqueos de advertencias y trabajo pendiente.';

commit;
