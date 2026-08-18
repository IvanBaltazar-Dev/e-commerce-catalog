-- 0138 · El código de barras como identidad, y el proveedor como agrupador.
--
-- Dos hallazgos del 2026-08-18 que cambian cómo se carga el catálogo:
--
-- 1. El checklist de captura física YA pedía «Código de barras» en sus 423
--    fichas. Volvieron CERO de 1.570 variantes. No falló la petición: faltaba
--    dónde aterrizara y quién lo leyera de vuelta. Pedir un dato sin camino de
--    retorno es no pedirlo.
--
-- 2. Las «156 marcas sin identidad» no son 156. El prefijo del código de
--    proveedor las agrupa:
--
--      SHEY  →  73 códigos repartidos en 14 «marcas» nuestras
--               (AIFER, STRONGER, SUN, GLOBAL NAIL, NEW SHOW, ZOLA, LRIS…)
--      SS    →  49 códigos en 5
--      R     →  26 códigos en 5
--      DY    →  23 códigos en 6
--
--    No son marcas: son etiquetas leídas del envase del surtido de un mismo
--    proveedor. Investigar un proveedor devuelve su catálogo entero de una vez;
--    investigar catorce marcas fantasma no devuelve nada. Está comprobado:
--    «Candy Secret» y «ROSE&LIN» no existen al buscarlas, y «SUN» resultó no
--    ser SUNUV — cero de once modelos coincidían.
--
-- Esta migración abre el sitio y lo proyecta al grafo. No inventa datos.

begin;

-- ── El código de barras es una identidad más, no una nota suelta ────────────
alter table public.product_variants
  drop constraint if exists product_variants_sku_origen_valido;
alter table public.product_variants
  add constraint product_variants_sku_origen_valido
  check (sku_origen in ('INTERNO', 'OFICIAL_MARCA', 'CODIGO_DE_BARRAS'));

alter table public.product_variants
  add column if not exists barcode_capturado_en timestamptz,
  add column if not exists barcode_origen text;

alter table public.product_variants
  drop constraint if exists product_variants_barcode_origen_valido;
alter table public.product_variants
  add constraint product_variants_barcode_origen_valido
  check (barcode_origen is null or barcode_origen in ('CAPTURA_FISICA', 'FICHA_OFICIAL', 'PROVEEDOR'));

comment on column public.product_variants.barcode is
  'EAN/UPC del envase. Es el único identificador que sirve para reconocer un '
  'producto sin saber su marca, y el que hace posible cargar por escaneo.';
comment on column public.product_variants.barcode_origen is
  'De dónde salió el código: del envase en mano, de la ficha del fabricante o '
  'del proveedor. Un código sin procedencia no se puede auditar.';

-- ── El prefijo de proveedor, como agrupador real ────────────────────────────
-- Se deriva, no se escribe: si mañana cambia un código, el agrupador cambia con
-- él. Guardarlo como columna sería una tercera copia que envejece.
create or replace view public.catalog_supplier_prefix_v1
with (security_invoker = true) as
select
  upper(substring(enlace.supplier_sku from '^[A-Za-z]+')) as prefijo,
  enlace.supplier_id,
  coalesce(enlace.product_id, variante.product_id) as product_id,
  enlace.supplier_sku
from public.product_suppliers enlace
left join public.product_variants variante on variante.id = enlace.variant_id
where enlace.supplier_sku is not null
  and coalesce(enlace.product_id, variante.product_id) is not null
  and substring(enlace.supplier_sku from '^[A-Za-z]+') is not null;

comment on view public.catalog_supplier_prefix_v1 is
  'El prefijo del código de proveedor agrupa productos por origen real, cruzando '
  'las etiquetas de marca que el catálogo les puso. 14 «marcas» distintas son un '
  'solo surtido SHEY.';

grant select on public.catalog_supplier_prefix_v1 to authenticated, service_role;

-- ── Al grafo ────────────────────────────────────────────────────────────────
create or replace view public.graph_supplier_prefix_nodes_v1
with (security_invoker = true) as
select distinct
  'supplier_prefix:' || lower(prefijo) as node_key,
  'SupplierPrefix' as node_type,
  null::uuid as entity_id,
  prefijo as label,
  'canonical'::text as layer,
  jsonb_build_object('prefijo', prefijo) as properties
from public.catalog_supplier_prefix_v1
where prefijo <> '';

create or replace view public.graph_supplier_prefix_edges_v1
with (security_invoker = true) as
select distinct
  'product-supplier-prefix:' || product_id::text || ':' || lower(prefijo) as edge_key,
  'product:' || product_id::text as source_key,
  'AGRUPADO_POR' as predicate,
  'supplier_prefix:' || lower(prefijo) as target_key,
  'canonical'::text as layer,
  '{}'::jsonb as properties
from public.catalog_supplier_prefix_v1
where prefijo <> '';

grant select on public.graph_supplier_prefix_nodes_v1 to authenticated, service_role;
grant select on public.graph_supplier_prefix_edges_v1 to authenticated, service_role;

-- El nodo de identidad por código de barras se declara aunque hoy tenga cero
-- variantes colgando. Un nodo vacío en el grafo es la forma honesta de enseñar
-- lo que falta; esconderlo hasta tener datos deja el hueco invisible, que es
-- justo como se llegó a cero códigos de barras sin que nadie lo notara.
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
   'Confirmado contra la ficha oficial de la marca. Sirve para reconciliar.'),
  ('CODIGO_DE_BARRAS', 'Código de barras',
   'EAN/UPC del envase. Identifica sin saber la marca y permite cargar escaneando.')
) as v(codigo, etiqueta, descripcion);

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
  union all select * from public.graph_supplier_prefix_nodes_v1
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
  union all select * from public.graph_supplier_prefix_edges_v1
) edge;

commit;
