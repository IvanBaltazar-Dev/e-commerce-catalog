-- ---------------------------------------------------------------------------
-- 0089 · Cierre de privilegios de la capa de conocimiento
-- ---------------------------------------------------------------------------
-- El contrato de grafo todavía es una superficie interna. El catálogo público
-- seguirá consumiendo sus 14 RPC ya auditados hasta que exista un contrato
-- público específico; no se amplía anon de forma implícita.

begin;

revoke select on
  public.graph_product_nodes_v1, public.graph_variant_nodes_v1,
  public.graph_class_nodes_v1, public.graph_system_nodes_v1,
  public.graph_stage_nodes_v1, public.graph_brand_nodes_v1,
  public.graph_variant_edges_v1, public.graph_brand_edges_v1,
  public.graph_stage_system_edges_v1, public.graph_system_role_edges_v1,
  public.graph_class_membership_edges_v1, public.graph_relation_edges_v1,
  public.graph_requires_edges_v1, public.graph_compatible_edges_v1,
  public.graph_incompatible_edges_v1, public.graph_recommended_edges_v1,
  public.graph_projection_manifest_v1
from anon;

revoke execute on function public.validate_catalog_observation() from public, anon, authenticated;
revoke execute on function public.prevent_catalog_observation_mutation() from public, anon, authenticated;
revoke execute on function public.validate_catalog_provenance_observation() from public, anon, authenticated;
revoke execute on function public.protect_decided_provenance_observation() from public, anon, authenticated;
revoke execute on function public.validate_catalog_attribute_provenance_decision() from public, anon, authenticated;
revoke execute on function public.validate_operational_attribute_provenance() from public, anon, authenticated;
revoke execute on function public.validate_catalog_assertion_evidence() from public, anon, authenticated;
revoke execute on function public.validate_product_system_role() from public, anon, authenticated;
revoke execute on function public.validate_catalog_typed_rule() from public, anon, authenticated;
revoke execute on function public.validate_catalog_class_member() from public, anon, authenticated;
revoke execute on function public.validate_product_relation_knowledge() from public, anon, authenticated;

comment on view public.graph_projection_manifest_v1 is
  'Contrato interno v1. No es una nueva superficie pública: authenticated/service_role lo consumen y anon conserva sus RPC auditados.';

commit;
