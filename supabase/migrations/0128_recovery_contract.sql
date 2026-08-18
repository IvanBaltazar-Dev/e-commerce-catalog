-- 0128 · Qué es patrimonio recuperable, declarado y no supuesto.
--
-- El ciclo destructivo dejó una lección que va más allá de las imágenes: el
-- checkpoint restauraba veintiséis tablas nombradas a mano dentro de un guion.
-- Nadie sabía que esa lista existía hasta que faltó algo, y lo que faltó no fue
-- un dato comercial sino los juicios: las decisiones terminales de una campaña,
-- sus causas y su evidencia.
--
-- La regla que hace falta es esta:
--
--   Todo estado que no pueda reconstruirse determinísticamente a partir de otra
--   fuente debe formar parte del patrimonio recuperable.
--
-- Y con ella, una separación que hasta ahora estaba implícita:
--
--   REGENERABLE       derivados de imagen, índices, proyecciones, y el
--                     resultado del carril A, que se ha demostrado idéntico
--                     al repetirlo desde el mismo corte.
--   NO REGENERABLE    la decisión humana, la causa de un retiro, la evidencia
--                     evaluada, la acción terminal, la anulación autorizada y
--                     la historia de una campaña. Nada de eso se «vuelve a
--                     calcular»: se respalda o se pierde.
--
-- Lo primero puede reconstruirse. Lo segundo debe respaldarse.
--
-- Desde aquí la lista deja de vivir escondida en un guion y pasa a ser un
-- contrato consultable, con su motivo escrito. Y sobre todo: si mañana alguien
-- añade una tabla que guarda decisiones y no la declara, el gate lo dice. No
-- hará falta descubrirlo seis migraciones después, cuando una reconstrucción se
-- lleve por delante trabajo que nadie puede rehacer.

begin;

create table public.catalog_recovery_contract (
  entity text primary key,
  recovery_class text not null check (recovery_class in ('REGENERABLE', 'NOT_REGENERABLE')),
  in_checkpoint boolean not null default true,
  rationale text not null,
  declared_at timestamptz not null default now()
);

comment on table public.catalog_recovery_contract is
  'Qué entidades forman el patrimonio recuperable y por qué. Lo que no se puede recalcular, se respalda.';

-- El corte comercial que el checkpoint ya restauraba. Se declara tal cual, sin
-- cambiar nada: es la base histórica del 10 de agosto y sigue siendo válida.
insert into public.catalog_recovery_contract (entity, recovery_class, rationale) values
  ('attribute_definitions', 'NOT_REGENERABLE', 'Definición del modelo de atributos del catálogo.'),
  ('attribute_options', 'NOT_REGENERABLE', 'Valores admitidos de cada atributo.'),
  ('attribute_templates', 'NOT_REGENERABLE', 'Plantillas que dan forma a cada tipo de producto.'),
  ('media_assets', 'NOT_REGENERABLE', 'Identidad de cada medio: ruta, hash, medidas y procedencia.'),
  ('brands', 'NOT_REGENERABLE', 'Marcas del catálogo comercial.'),
  ('brand_product_families', 'NOT_REGENERABLE', 'Familias declaradas por marca.'),
  ('catalog_metadata', 'NOT_REGENERABLE', 'Metadatos del catálogo.'),
  ('categories', 'NOT_REGENERABLE', 'Taxonomía comercial.'),
  ('product_lines', 'NOT_REGENERABLE', 'Líneas de producto.'),
  ('color_shades', 'NOT_REGENERABLE', 'Tonos: identidad de color del catálogo.'),
  ('suppliers', 'NOT_REGENERABLE', 'Proveedores.'),
  ('products', 'NOT_REGENERABLE', 'El catálogo comercial.'),
  ('product_variants', 'NOT_REGENERABLE', 'Las presentaciones vendibles.'),
  ('product_suppliers', 'NOT_REGENERABLE', 'De quién se compra cada presentación.'),
  ('price_lists', 'NOT_REGENERABLE', 'Listas de precio.'),
  ('product_attribute_values', 'NOT_REGENERABLE', 'Atributos declarados por producto.'),
  ('product_images', 'NOT_REGENERABLE', 'Imágenes declaradas del contrato antiguo.'),
  ('product_line_product_families', 'NOT_REGENERABLE', 'Relación línea–familia.'),
  ('product_media', 'NOT_REGENERABLE', 'La asociación editorial: qué medio es el principal de qué variante.'),
  ('product_relations', 'NOT_REGENERABLE', 'Relaciones comerciales confirmadas.'),
  ('template_attributes', 'NOT_REGENERABLE', 'Atributos de cada plantilla.'),
  ('template_attribute_comparisons', 'NOT_REGENERABLE', 'Comparaciones declaradas de plantilla.'),
  ('template_attribute_conditions', 'NOT_REGENERABLE', 'Condiciones declaradas de plantilla.'),
  ('variant_attribute_values', 'NOT_REGENERABLE', 'Atributos declarados por variante.'),
  ('variant_prices', 'NOT_REGENERABLE', 'Precio vigente de cada presentación.'),
  ('wholesale_rules', 'NOT_REGENERABLE', 'Reglas de precio mayorista.');

-- Lo que el ciclo destructivo demostró que faltaba. Una campaña no es un
-- proceso que se pueda «volver a correr» para recuperar sus conclusiones:
-- descargar una imagen sí se repite, decidir que una fuente no es válida no.
insert into public.catalog_recovery_contract (entity, recovery_class, rationale) values
  ('catalog_media_campaigns', 'NOT_REGENERABLE',
   'La campaña y su huella de alcance: qué se congeló y cuándo. Repetirla sobre otro catálogo daría otro alcance.'),
  ('catalog_media_campaign_items', 'NOT_REGENERABLE',
   'Los expedientes y su estado terminal. Un INVALID_SOURCE es un juicio, no un cálculo.'),
  ('catalog_media_campaign_item_actions', 'NOT_REGENERABLE',
   'Las acciones terminales sobre cada objeto, con su causa y su evidencia. Es la explicación de por qué el patrimonio quedó como quedó.'),
  ('catalog_media_item_states', 'NOT_REGENERABLE',
   'El vocabulario de estados. Si crece, los expedientes viejos dejan de entenderse sin él.'),
  ('catalog_media_runs', 'NOT_REGENERABLE',
   'Qué corrida produjo qué, y si quedó autorizada. Sin esto, un rastro abortado vuelve a poder decidir.');

-- Lo que sí se recalcula, declarado para que quede dicho que su ausencia del
-- checkpoint es una decisión y no un olvido.
insert into public.catalog_recovery_contract (entity, recovery_class, in_checkpoint, rationale) values
  ('catalog_review_work_items', 'REGENERABLE', false,
   'La Mesa se proyecta desde excepciones, reconciliaciones y candidatas. El checkpoint la reconstruye.'),
  ('catalog_relation_candidates', 'REGENERABLE', false,
   'Se regeneran desde el corte de investigación en cada restauración.');

-- Detector de huecos. No basta con declarar bien hoy: hace falta que mañana no
-- se pueda añadir una tabla de decisiones sin declararla.
--
-- El indicio es material, no de nombre: una tabla que referencia el vocabulario
-- de estados terminales, o que guarda una causa junto a una evidencia, está
-- guardando juicios. Si además nadie la declaró, el gate lo dice.
create or replace view public.catalog_recovery_contract_gaps_v1
with (security_invoker = true) as
with decision_bearing as (
  select distinct table_name
  from information_schema.columns
  where table_schema = 'public'
    and column_name in ('cause', 'resolution_code', 'decision_reason', 'defer_reason')
  union
  select distinct constraint_column_usage.table_name
  from information_schema.table_constraints
  join information_schema.constraint_column_usage using (constraint_name, table_schema)
  where table_constraints.constraint_type = 'FOREIGN KEY'
    and constraint_column_usage.table_name = 'catalog_media_item_states'
)
select
  candidate.table_name as entity,
  'guarda decisiones o causas y no está en el contrato de recuperación' as gap,
  'declarar en catalog_recovery_contract con su clase y su motivo' as remedy
from decision_bearing candidate
left join public.catalog_recovery_contract contract on contract.entity = candidate.table_name
where contract.entity is null
union all
select
  contract.entity,
  'declarado NO REGENERABLE pero marcado fuera del checkpoint' as gap,
  'incluirlo en el checkpoint o justificar por qué puede recalcularse' as remedy
from public.catalog_recovery_contract contract
where contract.recovery_class = 'NOT_REGENERABLE' and not contract.in_checkpoint;

alter table public.catalog_recovery_contract enable row level security;
create policy catalog_recovery_contract_admin_read on public.catalog_recovery_contract
  for select to authenticated using (public.is_admin());

grant select on public.catalog_recovery_contract_gaps_v1 to authenticated, service_role;

commit;
