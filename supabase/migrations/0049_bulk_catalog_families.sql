-- 0049: familias del catálogo real como datos + deuda de medios persistida.
--
-- Prepara la importación masiva del listado real (1,500 artículos, 51 familias):
--   1. media_backfill en products/product_variants: la deuda de imagen es estado
--      del catálogo (no solo del import) y se limpia sola al llegar un medio real.
--   2. summary en import_batches: el reporte obligatorio por lote vive con el lote.
--   3. Ejes de variante genéricos que el listado real exige (aroma, set/colección,
--      talla) y plantillas genéricas para las familias sin plantilla técnica propia.
--      Sin columnas por familia: todo entra por attribute_definitions/templates.
--   4. Las 51 familias como categorías bajo las raíces existentes; raíces nuevas
--      solo para las áreas que no existían (depilación, rostro/cuerpo/maquillaje,
--      higiene, organización). Las familias que ya tenían categoría (esmaltes,
--      lámparas, tornos, máquinas de corte, pestañas en tira, extensiones,
--      adhesivos) REUTILIZAN la existente: un dato, un único dueño.

begin;

-- ---------------------------------------------------------------------------
-- 1. Deuda de medios: color = swatch temporal con tono conocido; pending = sin
--    imagen ni tono confiable. NULL = sin deuda.
-- ---------------------------------------------------------------------------

create type public.media_backfill_status as enum ('color', 'pending');

alter table public.products
  add column media_backfill public.media_backfill_status;

alter table public.product_variants
  add column media_backfill public.media_backfill_status;

comment on column public.products.media_backfill is
  'Deuda de imagen del producto: pending = sin medio principal. Se limpia sola al asociar un medio.';
comment on column public.product_variants.media_backfill is
  'Deuda de imagen de la variante: color = swatch temporal desde color_shade (sustituir por foto real); pending = sin imagen ni tono confiable.';

create or replace function public.clear_media_backfill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is not null then
    update public.products
    set media_backfill = null
    where id = new.product_id
      and media_backfill is not null;
  end if;
  if new.variant_id is not null then
    update public.product_variants
    set media_backfill = null
    where id = new.variant_id
      and media_backfill is not null;
  end if;
  return new;
end;
$$;

-- Función de trigger: nadie la invoca por RPC (contrato de privilegios de 0045).
revoke all on function public.clear_media_backfill() from public, anon, authenticated;

create trigger product_media_clears_backfill
after insert on public.product_media
for each row execute function public.clear_media_backfill();

-- ---------------------------------------------------------------------------
-- 2. Reporte por lote: contadores y tiempos del lote viven con el lote.
-- ---------------------------------------------------------------------------

alter table public.import_batches
  add column if not exists summary jsonb not null default '{}'::jsonb;

alter table public.import_batches
  drop constraint if exists import_batches_summary_object,
  add constraint import_batches_summary_object check (jsonb_typeof(summary) = 'object');

comment on column public.import_batches.summary is
  'Reporte del lote: filas procesadas, productos nuevos/reutilizados, variantes, duplicados evitados, imágenes por confianza, rechazos y duración.';

-- ---------------------------------------------------------------------------
-- 3. Ejes de variante genéricos y atributos de apoyo.
-- ---------------------------------------------------------------------------

insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('aroma', 'Aroma', 'single_option', 'variant', null, true, true, true, false, false, 15),
  ('set_name', 'Colección o set', 'single_option', 'variant', null, true, true, true, false, false, 25),
  ('size_label', 'Talla o tamaño', 'single_option', 'variant', null, true, true, true, false, false, 35),
  ('model_name', 'Modelo', 'text', 'product', null, true, true, false, false, false, 45)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    unit = excluded.unit,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options (attribute_definition_id, value, label, sort_order)
select definition.id, option.value, option.label, option.sort_order
from (values
  -- El listado real trae tonos con nombre pero sin carta de colores: la familia
  -- cromática queda como deuda clasificable, nunca inventada.
  ('color_family', 'por-clasificar', 'Por clasificar', 999),
  ('size_label', 'xs', 'XS', 10),
  ('size_label', 's', 'S', 20),
  ('size_label', 'm', 'M', 30),
  ('size_label', 'l', 'L', 40),
  ('size_label', 'xl', 'XL', 50),
  ('size_label', 'xxl', 'XXL', 60),
  ('size_label', 'unica', 'Única', 70)
) as option(attribute_code, value, label, sort_order)
join public.attribute_definitions definition on definition.code = option.attribute_code
on conflict on constraint attribute_options_definition_value_unique do update
set label = excluded.label, sort_order = excluded.sort_order, is_active = true;

-- ---------------------------------------------------------------------------
-- 4. Plantillas genéricas para familias sin plantilla técnica dedicada.
-- ---------------------------------------------------------------------------

insert into public.attribute_templates (name, code, description)
values
  ('Herramienta básica', 'HERRAMIENTA_BASICA', 'Herramientas manuales: cepillos, peines, tijeras, pinceles, limas.'),
  ('Consumible básico', 'CONSUMIBLE_BASICO', 'Consumibles: algodón, toallas, guantes, bandas, desechables.'),
  ('Producto cosmético', 'PRODUCTO_COSMETICO', 'Cosméticos y tratamientos: capilar, facial, corporal, ceras, maquillaje.'),
  ('Sistema para uñas', 'SISTEMA_UNAS', 'Sistemas técnicos de uñas: acrílicos, polygel, preparadores, remoción.'),
  ('Equipo eléctrico', 'EQUIPO_ELECTRICO', 'Equipos eléctricos: planchas, secadoras, fundidores de cera, iluminación.'),
  ('Organización y apoyo', 'ORGANIZACION_APOYO', 'Maletines, organizadores, espejos, moldes, recipientes de trabajo.'),
  ('Press on y tips', 'PRESS_ON_DECORADO', 'Uñas press on, tips y sistemas de extensión listos para usar.'),
  ('Decoración nail art', 'DECORACION_NAIL_ART', 'Adornos, pigmentos, láminas y decoración para uñas.')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    is_active = true;

insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, false, definition.scope, mapping.sort_order
from (values
  ('HERRAMIENTA_BASICA', 'presentation', 10),
  ('HERRAMIENTA_BASICA', 'material', 20),
  ('HERRAMIENTA_BASICA', 'color', 30),
  ('HERRAMIENTA_BASICA', 'size_label', 40),
  ('CONSUMIBLE_BASICO', 'presentation', 10),
  ('CONSUMIBLE_BASICO', 'content_quantity', 20),
  ('CONSUMIBLE_BASICO', 'content_unit', 30),
  ('CONSUMIBLE_BASICO', 'material', 40),
  ('CONSUMIBLE_BASICO', 'size_label', 50),
  ('CONSUMIBLE_BASICO', 'color', 60),
  ('PRODUCTO_COSMETICO', 'presentation', 10),
  ('PRODUCTO_COSMETICO', 'content_ml', 20),
  ('PRODUCTO_COSMETICO', 'formula_system', 30),
  ('PRODUCTO_COSMETICO', 'collection', 40),
  ('PRODUCTO_COSMETICO', 'tone', 50),
  ('PRODUCTO_COSMETICO', 'color', 60),
  ('PRODUCTO_COSMETICO', 'aroma', 70),
  ('SISTEMA_UNAS', 'presentation', 10),
  ('SISTEMA_UNAS', 'content_ml', 20),
  ('SISTEMA_UNAS', 'formula_system', 30),
  ('SISTEMA_UNAS', 'requires_lamp_v2', 40),
  ('SISTEMA_UNAS', 'color', 50),
  ('SISTEMA_UNAS', 'set_name', 60),
  ('EQUIPO_ELECTRICO', 'equipment_type', 10),
  ('EQUIPO_ELECTRICO', 'model_name', 20),
  ('EQUIPO_ELECTRICO', 'power_watts', 30),
  ('EQUIPO_ELECTRICO', 'voltage', 40),
  ('EQUIPO_ELECTRICO', 'power_mode', 50),
  ('EQUIPO_ELECTRICO', 'color', 60),
  ('ORGANIZACION_APOYO', 'presentation', 10),
  ('ORGANIZACION_APOYO', 'material', 20),
  ('ORGANIZACION_APOYO', 'size_label', 30),
  ('ORGANIZACION_APOYO', 'color', 40),
  ('PRESS_ON_DECORADO', 'presentation', 10),
  ('PRESS_ON_DECORADO', 'shape', 20),
  ('PRESS_ON_DECORADO', 'size_label', 30),
  ('PRESS_ON_DECORADO', 'set_name', 40),
  ('PRESS_ON_DECORADO', 'color', 50),
  ('DECORACION_NAIL_ART', 'presentation', 10),
  ('DECORACION_NAIL_ART', 'material', 20),
  ('DECORACION_NAIL_ART', 'color', 30),
  ('DECORACION_NAIL_ART', 'set_name', 40)
) as mapping(template_code, attribute_code, sort_order)
join public.attribute_templates template on template.code = mapping.template_code
join public.attribute_definitions definition on definition.code = mapping.attribute_code
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 5. Raíces nuevas (las áreas del listado que no existían).
-- ---------------------------------------------------------------------------

insert into public.categories (parent_id, name, slug, template_id, sort_order)
values
  (null, 'Depilación', 'depilacion', null, 600),
  (null, 'Rostro, cuerpo y maquillaje', 'rostro-cuerpo-maquillaje', null, 700),
  (null, 'Higiene y consumibles', 'higiene-consumibles', null, 800),
  (null, 'Organización y apoyo', 'organizacion-apoyo', null, 900)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 6. Familias del listado como hojas. Las siete familias con categoría previa
--    (esmaltes, lámparas, tornos, máquinas de corte, pestañas en tira,
--    extensiones profesionales, adhesivos profesionales) no se insertan aquí.
-- ---------------------------------------------------------------------------

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, leaf.name, leaf.slug, template.id, leaf.sort_order
from (values
  -- Uñas, manicure y pedicure → raíz existente «unas»
  ('unas', 'Bases, tops y finalizadores', 'bases-y-tops', 'ESMALTE_TONOS', 20),
  ('unas', 'Sistema acrílico', 'sistema-acrilico', 'SISTEMA_UNAS', 30),
  ('unas', 'Polygel y gel constructor', 'polygel-constructor', 'SISTEMA_UNAS', 40),
  ('unas', 'Soft gel y adhesivos para uñas', 'soft-gel-adhesivos', 'SISTEMA_UNAS', 50),
  ('unas', 'Preparadores y adherencia', 'preparadores-adherencia', 'SISTEMA_UNAS', 60),
  ('unas', 'Remoción y limpieza', 'remocion-limpieza', 'SISTEMA_UNAS', 70),
  ('unas', 'Press on y uñas decoradas', 'press-on', 'PRESS_ON_DECORADO', 80),
  ('unas', 'Tips y dual system', 'tips-dual-system', 'PRESS_ON_DECORADO', 90),
  ('unas', 'Decoración y nail art', 'decoracion-nail-art', 'DECORACION_NAIL_ART', 100),
  ('unas', 'Pinceles y herramientas de diseño', 'pinceles-diseno', 'HERRAMIENTA_BASICA', 110),
  ('unas', 'Herramientas de manicure y pedicure', 'herramientas-manicure', 'HERRAMIENTA_BASICA', 120),
  ('unas', 'Limas, buffers y pulido', 'limas-buffers', 'HERRAMIENTA_BASICA', 130),
  ('unas', 'Cuidado de cutícula, manos y pies', 'cuidado-cuticula', 'PRODUCTO_COSMETICO', 140),
  ('unas', 'Brocas y repuestos de drill', 'brocas-repuestos', 'ACCESORIO_REPUESTO', 150),
  ('unas', 'Moldes, práctica y exhibición', 'moldes-exhibicion', 'ORGANIZACION_APOYO', 160),
  ('unas', 'Recipientes y accesorios de trabajo', 'recipientes-trabajo', 'ORGANIZACION_APOYO', 170),
  -- Cejas y pestañas → raíz existente «pestanas»
  ('pestanas', 'Diseño y tinturación de cejas', 'cejas-diseno', 'PRODUCTO_COSMETICO', 40),
  ('pestanas', 'Lifting, rizado y laminado', 'lifting-laminado', 'PRODUCTO_COSMETICO', 50),
  ('pestanas', 'Herramientas y consumibles', 'herramientas-pestanas', 'HERRAMIENTA_BASICA', 60),
  ('pestanas', 'Rizadores y repuestos', 'rizadores-pestanas', 'HERRAMIENTA_BASICA', 70),
  -- Cabello y barbería → raíz existente «barberia-cabello»
  ('barberia-cabello', 'Accesorios y protección de peluquería', 'accesorios-peluqueria', 'HERRAMIENTA_BASICA', 20),
  ('barberia-cabello', 'Cepillos y peines', 'cepillos-y-peines', 'HERRAMIENTA_BASICA', 30),
  ('barberia-cabello', 'Coloración y procesos químicos', 'coloracion-quimicos', 'PRODUCTO_COSMETICO', 40),
  ('barberia-cabello', 'Tratamiento, lavado y estilizado', 'tratamiento-capilar', 'PRODUCTO_COSMETICO', 50),
  ('barberia-cabello', 'Planchas, secadoras y rizadores', 'planchas-secadoras', 'EQUIPO_ELECTRICO', 60),
  ('barberia-cabello', 'Tijeras, navajas y herramientas', 'tijeras-navajas', 'HERRAMIENTA_BASICA', 70),
  ('barberia-cabello', 'Desinfección y mantenimiento', 'desinfeccion-maquinas', 'PRODUCTO_COSMETICO', 80),
  -- Depilación
  ('depilacion', 'Ceras depilatorias', 'ceras-depilatorias', 'PRODUCTO_COSMETICO', 10),
  ('depilacion', 'Cremas depilatorias', 'cremas-depilatorias', 'PRODUCTO_COSMETICO', 20),
  ('depilacion', 'Bandas y consumibles', 'bandas-consumibles', 'CONSUMIBLE_BASICO', 30),
  ('depilacion', 'Equipos para cera', 'equipos-cera', 'EQUIPO_ELECTRICO', 40),
  -- Rostro, cuerpo y maquillaje
  ('rostro-cuerpo-maquillaje', 'Cuidado facial', 'cuidado-facial', 'PRODUCTO_COSMETICO', 10),
  ('rostro-cuerpo-maquillaje', 'Cuidado corporal, manos y pies', 'cuidado-corporal', 'PRODUCTO_COSMETICO', 20),
  ('rostro-cuerpo-maquillaje', 'Maquillaje de ojos y rostro', 'maquillaje', 'PRODUCTO_COSMETICO', 30),
  ('rostro-cuerpo-maquillaje', 'Labios', 'labios', 'PRODUCTO_COSMETICO', 40),
  ('rostro-cuerpo-maquillaje', 'Espejos y accesorios personales', 'espejos-accesorios', 'ORGANIZACION_APOYO', 50),
  -- Higiene y consumibles
  ('higiene-consumibles', 'Algodón, gasas y wipes', 'algodon-gasas', 'CONSUMIBLE_BASICO', 10),
  ('higiene-consumibles', 'Campos, toallas y desechables', 'toallas-desechables', 'CONSUMIBLE_BASICO', 20),
  ('higiene-consumibles', 'Guantes y protección', 'guantes-proteccion', 'CONSUMIBLE_BASICO', 30),
  ('higiene-consumibles', 'Sanitización y esterilización', 'sanitizacion-esterilizacion', 'CONSUMIBLE_BASICO', 40),
  ('higiene-consumibles', 'Dispensadores y recipientes', 'dispensadores', 'ORGANIZACION_APOYO', 50),
  -- Organización, mobiliario y apoyo
  ('organizacion-apoyo', 'Maletines, neceseres y mochilas', 'maletines', 'ORGANIZACION_APOYO', 10),
  ('organizacion-apoyo', 'Organizadores y carros auxiliares', 'organizadores', 'ORGANIZACION_APOYO', 20),
  ('organizacion-apoyo', 'Lámparas de mesa e iluminación', 'lamparas-mesa', 'EQUIPO_ELECTRICO', 30)
) as leaf(root_slug, name, slug, template_code, sort_order)
join public.categories parent
  on parent.parent_id is null and parent.slug = leaf.root_slug
join public.attribute_templates template
  on template.code = leaf.template_code
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name,
    template_id = excluded.template_id,
    is_active = true,
    sort_order = excluded.sort_order;

commit;
