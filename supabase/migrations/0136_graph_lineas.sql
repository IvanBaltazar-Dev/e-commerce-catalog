-- 0136 · Las líneas entran al grafo.
--
-- 0134 creó las siete líneas de Masglo y Admiss como dato relacional. En el
-- grafo no existían: contando etiquetas en Neo4j hay Product, Variant, Brand,
-- Category, Shade, Class… y ninguna Line. Las dieciséis Class que sí hay son
-- todas ACRYLIC_* de un fixture de ACRYLOVE.
--
-- Mientras el grafo no sepa lo que sabe la base, preguntarle por líneas da la
-- respuesta de antes. Y ahí estaba el fallo de raíz: emparejar imágenes por
-- nombre de tono, sin saber que «Campeona» son tres productos distintos.
--
-- El grafo aquí es una proyección de vistas SQL, así que alimentarlo no se hace
-- escribiendo Cypher suelto —que se desincronizaría al primer cambio— sino
-- añadiendo una vista contribuyente y volviendo a proyectar. Mismo patrón que
-- 0113 y 0116.

begin;

-- ── Nodos de línea ──────────────────────────────────────────────────────────
create or replace view public.graph_product_line_nodes_v1
with (security_invoker = true) as
select
  'line:' || linea.id::text as node_key,
  'Line' as node_type,
  linea.id as entity_id,
  linea.name as label,
  'canonical'::text as layer,
  jsonb_strip_nulls(jsonb_build_object(
    'slug', linea.slug,
    'brandId', linea.brand_id,
    'description', linea.description,
    'sortOrder', linea.sort_order,
    'isActive', linea.is_active
  )) as properties
from public.product_lines linea;

comment on view public.graph_product_line_nodes_v1 is
  'Las líneas de una marca como nodo. Masglo no vende «esmalte»: vende '
  'Tradicional, Gel Evolution y Gel Polish, y el mismo tono existe en varias.';

-- ── Aristas ─────────────────────────────────────────────────────────────────
--
-- Tres, y cada una responde una pregunta que hoy no se puede hacer:
--
--   Line -[:OF_BRAND]-> Brand    ¿qué líneas tiene Masglo?
--   Product -[:IN_LINE]-> Line   ¿qué hay cargado de Gel Polish?  (hoy: nada)
--   Shade -[:IN_LINE]-> Line     ¿este tono de qué línea es?
--
-- La segunda es la que enseña el hueco: Gel Evolution y Gel Polish existirán
-- como nodo sin un solo producto colgando. Un nodo vacío no es ruido, es la
-- forma que tiene el grafo de decir «esto lo vendemos y no lo tenemos».
create or replace view public.graph_product_line_edges_v1
with (security_invoker = true) as
select
  'line-brand:' || linea.id::text as edge_key,
  'line:' || linea.id::text as source_key,
  'OF_BRAND' as predicate,
  'brand:' || linea.brand_id::text as target_key,
  'canonical'::text as layer,
  '{}'::jsonb as properties
from public.product_lines linea
union all
select
  'product-line:' || producto.id::text,
  'product:' || producto.id::text,
  'IN_LINE',
  'line:' || producto.product_line_id::text,
  'canonical',
  '{}'::jsonb
from public.products producto
where producto.product_line_id is not null
union all
select
  'shade-line:' || tono.id::text,
  'shade:' || tono.id::text,
  'IN_LINE',
  'line:' || tono.product_line_id::text,
  'canonical',
  '{}'::jsonb
from public.color_shades tono
where tono.product_line_id is not null;

comment on view public.graph_product_line_edges_v1 is
  'Marca→línea, producto→línea y tono→línea. Sin esto el grafo no puede '
  'distinguir dos productos que comparten nombre de tono.';

-- ── Enganche a la proyección ────────────────────────────────────────────────
-- Se reescriben enteras porque una UNION no se amplía por partes. El cuerpo es
-- el de 0113 y 0116 con una rama más al final.

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select node.node_key, node.node_type, node.entity_id, node.label, node.layer,
       node.properties,
       md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|'
         || node.label || '|' || node.properties::text) as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all select * from public.graph_identity_case_nodes_v1
  union all select * from public.graph_review_work_nodes_v1
  union all select * from public.graph_semantic_term_nodes_v1
  union all select * from public.graph_semantic_problem_group_nodes_v1
  union all select * from public.graph_universal_semantic_nodes_v1
  union all select * from public.graph_system_class_contract_nodes_v1
  union all select * from public.graph_product_line_nodes_v1
) node;

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select edge.edge_key, edge.source_key, edge.predicate, edge.target_key,
       edge.layer, edge.properties,
       md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|'
         || edge.target_key || '|' || edge.layer || '|' || edge.properties::text)
         as projection_fingerprint
from (
  select base.* from public.graph_edges_v2_base base
  where base.edge_key not like 'reference-match:%'
    and not exists (
      select 1 from public.catalog_class_members membership
      where (membership.metadata ? 'stage4eDecisionId'
          or membership.metadata ? 'stage4eDecisionIds')
        and base.edge_key = 'class-member:' || membership.id::text
    )
    and not exists (
      select 1 from public.catalog_relation_rules rule
      where rule.metadata ? 'stage4eDecisionId'
        and base.edge_key = 'relation-rule:' || rule.id::text
    )
  union all select * from public.graph_stage4e_knowledge_edges_v1
  union all select * from public.graph_identity_case_edges_v1
  union all select * from public.graph_review_work_edges_v1
  union all select * from public.graph_semantic_term_edges_v1
  union all select * from public.graph_semantic_problem_group_edges_v1
  union all select * from public.graph_universal_semantic_edges_v1
  union all select * from public.graph_system_class_contract_edges_v1
  union all select * from public.graph_product_line_edges_v1
) edge;

grant select on public.graph_product_line_nodes_v1 to authenticated, service_role;
grant select on public.graph_product_line_edges_v1 to authenticated, service_role;

commit;
