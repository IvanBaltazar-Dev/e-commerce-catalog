-- 0137 · Separar el código del fabricante del correlativo nuestro.
--
-- `product_variants.sku` mezcla hoy dos cosas que no son lo mismo:
--
--   310028, 311428   SKU real del fabricante
--   CHE017, MAS014   correlativo NUESTRO (prefijo de marca + 3 dígitos)
--
-- Y mezclarlos tiene coste medible. La auditoría contra fuentes oficiales solo
-- alcanza al 3,6% del catálogo porque el 96% restante lleva códigos que no
-- significan nada fuera de esta base. Peor: chocan. «CHE017» es «Base Coat»
-- para nosotros y «Polvo Compacto Facial» en el catálogo de Cherimoya, y un
-- detector que empareje por SKU a secas propone mover el uno al sitio del otro.
--
-- La solución no es tirar el correlativo. Las hojas de la dueña, los albaranes
-- y el inventario físico lo usan; borrarlo rompería el puente con el papel. Lo
-- que hace falta es que cada código viva en su columna y se sepa cuál manda.
--
--   sku          el que manda para contrastar con el mundo
--   sku_interno  el correlativo, cuando el de arriba pasó a ser el oficial
--   sku_origen   de dónde salió el de arriba
--
-- No se migra nada aquí: esto solo abre el sitio. La migración de datos la hace
-- scripts/migrar-sku-oficial.mjs, que solo toca lo ya confirmado con
-- corroboración de nombre y guarda de color.

begin;

alter table public.product_variants
  add column if not exists sku_interno text,
  add column if not exists sku_origen text not null default 'INTERNO';

alter table public.product_variants
  drop constraint if exists product_variants_sku_origen_valido;
alter table public.product_variants
  add constraint product_variants_sku_origen_valido
  check (sku_origen in ('INTERNO', 'OFICIAL_MARCA'));

-- Si el SKU es oficial, el correlativo tiene que estar guardado. Sin esta
-- regla, una migración a medias perdería el puente con el papel sin avisar.
alter table public.product_variants
  drop constraint if exists product_variants_correlativo_preservado;
alter table public.product_variants
  add constraint product_variants_correlativo_preservado
  check (sku_origen <> 'OFICIAL_MARCA' or sku_interno is not null);

comment on column public.product_variants.sku is
  'El código que manda. Cuando sku_origen es OFICIAL_MARCA, es el del fabricante '
  'y sirve para contrastar con la fuente oficial.';
comment on column public.product_variants.sku_interno is
  'El correlativo que generamos al importar (prefijo de marca + dígitos). Se '
  'conserva porque las hojas y los albaranes de la dueña lo usan.';
comment on column public.product_variants.sku_origen is
  'INTERNO mientras el sku sea correlativo nuestro; OFICIAL_MARCA cuando se '
  'confirmó contra la ficha del fabricante.';

-- Buscar por el correlativo tiene que seguir funcionando después de migrar: la
-- dueña teclea «MAS014» porque es lo que pone en su hoja, no «310028».
create index if not exists product_variants_sku_interno_idx
  on public.product_variants (lower(sku_interno))
  where sku_interno is not null;

-- ── El correlativo también entra al grafo ───────────────────────────────────
-- Un nodo Variant que solo conoce su código actual no puede reconciliar con lo
-- que llegue rotulado con el viejo.
create or replace view public.graph_variant_identity_edges_v1
with (security_invoker = true) as
select
  'variant-sku-origen:' || variante.id::text as edge_key,
  'variant:' || variante.id::text as source_key,
  'IDENTIFICADA_POR' as predicate,
  'sku_origen:' || lower(variante.sku_origen) as target_key,
  'canonical'::text as layer,
  jsonb_strip_nulls(jsonb_build_object(
    'sku', variante.sku,
    'skuInterno', variante.sku_interno
  )) as properties
from public.product_variants variante
where variante.sku is not null;

create or replace view public.graph_sku_origen_nodes_v1
with (security_invoker = true) as
select
  'sku_origen:' || lower(v.codigo) as node_key,
  'SkuOrigen' as node_type,
  null::uuid as entity_id,
  v.etiqueta as label,
  'canonical'::text as layer,
  jsonb_build_object('codigo', v.codigo, 'descripcion', v.descripcion) as properties
from (values
  ('INTERNO', 'Correlativo interno',
   'Código que generamos al importar. No se puede contrastar con nada de fuera.'),
  ('OFICIAL_MARCA', 'SKU del fabricante',
   'Confirmado contra la ficha oficial de la marca. Sirve para reconciliar.')
) as v(codigo, etiqueta, descripcion);

grant select on public.graph_variant_identity_edges_v1 to authenticated, service_role;
grant select on public.graph_sku_origen_nodes_v1 to authenticated, service_role;

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
  union all select * from public.graph_sku_origen_nodes_v1
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
  union all select * from public.graph_variant_identity_edges_v1
) edge;

commit;
