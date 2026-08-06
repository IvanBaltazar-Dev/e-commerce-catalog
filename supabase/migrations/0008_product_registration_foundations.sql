begin;

-- La línea es una dimensión comercial estable, distinta de marca y categoría.
create table public.product_lines (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_lines_name_not_blank check (length(trim(name)) > 0),
  constraint product_lines_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint product_lines_brand_slug_unique unique (brand_id, slug)
);

alter table public.products
  add column product_line_id uuid references public.product_lines(id) on delete set null;

create index product_lines_brand_name_idx on public.product_lines(brand_id, name);
create index products_product_line_idx on public.products(product_line_id);

create trigger product_lines_set_updated_at
before update on public.product_lines
for each row execute function public.set_updated_at();

alter table public.product_lines enable row level security;

create policy "public read active product lines"
on public.product_lines for select to anon, authenticated
using (is_active = true);

create policy "admins manage product lines"
on public.product_lines for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select on public.product_lines to anon;
grant select, insert, update, delete on public.product_lines to authenticated, service_role;

-- Familias comprensibles del preview. La plantilla es interna; la clienta elige el tipo.
insert into public.attribute_templates (name, code, description)
values
  ('Esmalte por tonos', 'ESMALTE_TONOS', 'Esmaltes con tonos seleccionables.'),
  ('Pestaña en tira', 'PESTANA_TIRA', 'Pestañas completas para aplicación personal.'),
  ('Extensión profesional', 'EXTENSIONES_PRO', 'Extensiones por curva, grosor, longitud y color.'),
  ('Adhesivo profesional', 'ADHESIVO_PRO', 'Adhesivos con condiciones técnicas de trabajo.'),
  ('Lámpara UV/LED', 'LAMPARA', 'Lámparas con potencia, tecnología y alimentación.'),
  ('Torno o pulidor', 'TORNO_ELECTRICO', 'Tornos, pulidores y limas eléctricas.'),
  ('Máquina de corte', 'MAQUINA_CORTE', 'Clippers, trimmers y shavers.'),
  ('Accesorio o repuesto', 'ACCESORIO_REPUESTO', 'Accesorios, cargadores, micromotores y repuestos.')
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    is_active = true;

insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('presentation', 'Presentación', 'text', 'product', null, true, true, false, false, false, 10),
  ('formula_system', 'Sistema o fórmula', 'single_option', 'product', null, true, true, false, false, false, 20),
  ('requires_lamp_v2', 'Requiere lámpara', 'boolean', 'product', null, true, false, false, false, false, 30),
  ('lamp_technology', 'Tecnología de lámpara', 'single_option', 'product', null, true, false, false, false, false, 40),
  ('general_finish', 'Acabado', 'single_option', 'product', null, true, false, false, false, false, 50),
  ('collection', 'Colección', 'text', 'product', null, true, true, false, false, false, 60),
  ('strip_style', 'Estilo', 'single_option', 'variant', null, true, true, true, false, false, 10),
  ('color', 'Color', 'single_option', 'variant', null, true, true, true, false, false, 20),
  ('material', 'Material', 'text', 'product', null, true, false, false, false, false, 30),
  ('content_quantity', 'Cantidad de contenido', 'integer', 'product', null, true, false, false, false, false, 40),
  ('content_unit', 'Unidad de contenido', 'single_option', 'product', null, true, false, false, false, false, 50),
  ('reusable', 'Reutilizable', 'boolean', 'product', null, true, false, false, false, false, 60),
  ('includes_adhesive', 'Incluye adhesivo', 'boolean', 'product', null, true, false, false, false, false, 70),
  ('lash_technology', 'Tecnología o estilo', 'single_option', 'product', null, true, true, false, false, false, 10),
  ('lash_curve', 'Curva', 'single_option', 'variant', null, true, true, true, false, false, 20),
  ('lash_thickness', 'Grosor', 'single_option', 'variant', 'mm', true, true, true, false, false, 30),
  ('lash_length', 'Longitud', 'single_option', 'variant', 'mm', true, true, true, false, false, 40),
  ('length_format', 'Formato de longitud', 'single_option', 'variant', null, true, false, false, false, false, 50),
  ('adhesive_color', 'Color del adhesivo', 'single_option', 'variant', null, true, false, true, false, false, 10),
  ('content_ml', 'Contenido', 'measurement', 'product', 'ml', true, false, false, false, false, 20),
  ('drying_seconds', 'Tiempo de secado', 'decimal', 'product', 's', true, false, false, false, false, 30),
  ('retention_weeks', 'Retención estimada', 'decimal', 'product', 'semanas', true, false, false, false, false, 40),
  ('humidity_min', 'Humedad mínima', 'decimal', 'product', '%', true, false, false, false, false, 50),
  ('humidity_max', 'Humedad máxima', 'decimal', 'product', '%', true, false, false, false, false, 60),
  ('temperature_min', 'Temperatura mínima', 'decimal', 'product', '°C', true, false, false, false, false, 70),
  ('temperature_max', 'Temperatura máxima', 'decimal', 'product', '°C', true, false, false, false, false, 80),
  ('viscosity', 'Viscosidad', 'single_option', 'product', null, true, false, false, false, false, 90),
  ('experience_level', 'Nivel recomendado', 'single_option', 'product', null, true, false, false, false, false, 100),
  ('storage_instructions', 'Indicaciones de almacenamiento', 'text', 'product', null, false, true, false, false, false, 110),
  ('power_mode', 'Modo de alimentación', 'single_option', 'product', null, true, false, false, false, false, 30),
  ('charging_method', 'Método de carga', 'single_option', 'product', null, true, false, false, false, false, 40),
  ('timers', 'Temporizadores', 'text', 'product', null, true, false, false, false, false, 50),
  ('automatic_sensor', 'Sensor automático', 'boolean', 'product', null, true, false, false, false, false, 60),
  ('led_count', 'Cantidad de LEDs', 'integer', 'product', null, true, false, false, false, false, 70),
  ('removable_base', 'Base removible', 'boolean', 'product', null, true, false, false, false, false, 80),
  ('equipment_type', 'Tipo de equipo', 'single_option', 'product', null, true, true, false, false, false, 10),
  ('rpm_min', 'RPM mínimas', 'integer', 'product', 'RPM', true, false, false, false, false, 30),
  ('rpm_max', 'RPM máximas', 'integer', 'product', 'RPM', true, false, false, false, false, 40),
  ('rotation_direction', 'Sentido de giro', 'single_option', 'product', null, true, false, false, false, false, 50),
  ('speed_control', 'Control de velocidad', 'boolean', 'product', null, true, false, false, false, false, 60),
  ('control_type', 'Tipo de control', 'single_option', 'product', null, true, false, false, false, false, 70),
  ('usage_level', 'Uso recomendado', 'single_option', 'product', null, true, false, false, false, false, 80),
  ('handpiece_included', 'Incluye micromotor o manípulo', 'boolean', 'product', null, true, false, false, false, false, 90),
  ('bits_included', 'Fresas incluidas', 'integer', 'product', null, true, false, false, false, false, 100),
  ('machine_type', 'Tipo de máquina', 'single_option', 'product', null, true, true, false, false, false, 10),
  ('recommended_use', 'Uso recomendado', 'text', 'product', null, true, true, false, false, false, 20),
  ('battery_minutes', 'Autonomía', 'integer', 'product', 'min', true, false, false, false, false, 50),
  ('charge_minutes', 'Tiempo de carga', 'integer', 'product', 'min', true, false, false, false, false, 60),
  ('blade_type', 'Tipo de cuchilla o lámina', 'text', 'product', null, true, true, false, false, false, 70),
  ('cutting_range', 'Rango de corte', 'text', 'product', null, true, false, false, false, false, 80),
  ('accessory_type', 'Tipo de accesorio o repuesto', 'single_option', 'product', null, true, true, false, false, false, 10),
  ('amperage', 'Amperaje', 'measurement', 'product', 'A', true, false, false, false, false, 30),
  ('connector_type', 'Tipo de conector', 'text', 'product', null, true, true, false, false, false, 40),
  ('pin_count', 'Número de pines', 'integer', 'product', null, true, false, false, false, false, 50),
  ('compatibility_level', 'Nivel de compatibilidad', 'single_option', 'product', null, true, false, false, false, false, 60),
  ('compatibility_note', 'Nota de compatibilidad', 'text', 'product', null, false, true, false, false, false, 70)
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
from (
  values
    ('formula_system', 'traditional', 'Tradicional', 10),
    ('formula_system', 'gel-effect', 'Efecto gel sin lámpara', 20),
    ('formula_system', 'semi-permanent', 'Semipermanente UV/LED', 30),
    ('lamp_technology', 'uv', 'UV', 10),
    ('lamp_technology', 'led', 'LED', 20),
    ('lamp_technology', 'dual', 'UV/LED dual', 30),
    ('general_finish', 'glossy', 'Brillante', 10),
    ('general_finish', 'matte', 'Mate', 20),
    ('strip_style', 'natural', 'Natural', 10),
    ('strip_style', 'dramatic', 'Dramático', 20),
    ('color', 'black', 'Negro', 10),
    ('color', 'brown', 'Marrón', 20),
    ('color', 'pink', 'Rosado', 30),
    ('color', 'white', 'Blanco', 40),
    ('content_unit', 'pair', 'par', 10),
    ('content_unit', 'pairs', 'pares', 20),
    ('content_unit', 'units', 'unidades', 30),
    ('content_unit', 'lines', 'líneas', 40),
    ('content_unit', 'tray', 'bandeja', 50),
    ('lash_technology', 'classic', 'Clásica', 10),
    ('lash_technology', 'flat', 'Flat / ellipse', 20),
    ('lash_technology', 'volume', 'Volumen', 30),
    ('lash_curve', 'c', 'C', 10),
    ('lash_curve', 'd', 'D', 20),
    ('lash_curve', 'l', 'L', 30),
    ('lash_thickness', '0-07', '0.07 mm', 10),
    ('lash_thickness', '0-15', '0.15 mm', 20),
    ('lash_length', '10', '10 mm', 10),
    ('lash_length', '11', '11 mm', 20),
    ('lash_length', 'mix-8-15', 'Mix 8–15 mm', 30),
    ('length_format', 'single', 'Longitud única', 10),
    ('length_format', 'mixed', 'Mixta', 20),
    ('adhesive_color', 'black', 'Negro', 10),
    ('adhesive_color', 'clear', 'Transparente', 20),
    ('viscosity', 'low', 'Baja', 10),
    ('viscosity', 'medium', 'Media', 20),
    ('viscosity', 'high', 'Alta', 30),
    ('experience_level', 'beginner', 'Inicial', 10),
    ('experience_level', 'intermediate', 'Intermedio', 20),
    ('experience_level', 'professional', 'Profesional', 30),
    ('power_mode', 'corded', 'Solo conectado', 10),
    ('power_mode', 'cordless', 'Batería', 20),
    ('power_mode', 'cord-or-cordless', 'Conectado o batería', 30),
    ('charging_method', 'usb-c', 'USB-C', 10),
    ('charging_method', 'micro-usb', 'Micro-USB', 20),
    ('charging_method', 'charging-base', 'Base de carga', 30),
    ('charging_method', 'proprietary', 'Adaptador propietario', 40),
    ('rotation_direction', 'forward', 'Adelante', 10),
    ('rotation_direction', 'forward-reverse', 'Adelante y reversa', 20),
    ('control_type', 'body', 'En el equipo', 10),
    ('control_type', 'pedal', 'Pedal', 20),
    ('control_type', 'both', 'Equipo y pedal', 30),
    ('usage_level', 'personal', 'Personal', 10),
    ('usage_level', 'professional', 'Profesional', 20),
    ('equipment_type', 'nail-drill', 'Torno', 10),
    ('equipment_type', 'polisher', 'Pulidor', 20),
    ('equipment_type', 'electric-file', 'Lima eléctrica', 30),
    ('machine_type', 'clipper', 'Cortadora / clipper', 10),
    ('machine_type', 'trimmer', 'Trimmer / patillera', 20),
    ('machine_type', 'shaver', 'Afeitadora / shaver', 30),
    ('accessory_type', 'charger', 'Cargador', 10),
    ('accessory_type', 'handpiece', 'Micromotor / manípulo', 20),
    ('accessory_type', 'comb', 'Peineta o guía', 30),
    ('accessory_type', 'blade', 'Cuchilla o cabezal', 40),
    ('accessory_type', 'bit', 'Fresa', 50),
    ('accessory_type', 'other', 'Otro accesorio', 60),
    ('compatibility_level', 'universal', 'Universal', 10),
    ('compatibility_level', 'broad', 'Ampliamente compatible', 20),
    ('compatibility_level', 'brand-family', 'Familia de marca', 30),
    ('compatibility_level', 'specific-model', 'Modelo específico', 40),
    ('compatibility_level', 'unconfirmed', 'Por confirmar', 50)
) as option(attribute_code, value, label, sort_order)
join public.attribute_definitions definition on definition.code = option.attribute_code
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, mapping.required, definition.scope, mapping.sort_order
from (
  values
    ('ESMALTE_TONOS', 'presentation', false, 5),
    ('ESMALTE_TONOS', 'formula_system', false, 10),
    ('ESMALTE_TONOS', 'requires_lamp_v2', false, 20),
    ('ESMALTE_TONOS', 'lamp_technology', false, 30),
    ('ESMALTE_TONOS', 'general_finish', false, 40),
    ('ESMALTE_TONOS', 'collection', false, 50),
    ('PESTANA_TIRA', 'strip_style', false, 10),
    ('PESTANA_TIRA', 'color', false, 20),
    ('PESTANA_TIRA', 'material', false, 30),
    ('PESTANA_TIRA', 'content_quantity', false, 40),
    ('PESTANA_TIRA', 'content_unit', false, 50),
    ('PESTANA_TIRA', 'reusable', false, 60),
    ('PESTANA_TIRA', 'includes_adhesive', false, 70),
    ('EXTENSIONES_PRO', 'lash_technology', false, 10),
    ('EXTENSIONES_PRO', 'lash_curve', false, 20),
    ('EXTENSIONES_PRO', 'lash_thickness', false, 30),
    ('EXTENSIONES_PRO', 'lash_length', false, 40),
    ('EXTENSIONES_PRO', 'length_format', false, 50),
    ('EXTENSIONES_PRO', 'color', false, 60),
    ('EXTENSIONES_PRO', 'content_quantity', false, 70),
    ('EXTENSIONES_PRO', 'content_unit', false, 80),
    ('EXTENSIONES_PRO', 'material', false, 90),
    ('ADHESIVO_PRO', 'adhesive_color', false, 10),
    ('ADHESIVO_PRO', 'content_ml', false, 20),
    ('ADHESIVO_PRO', 'drying_seconds', false, 30),
    ('ADHESIVO_PRO', 'retention_weeks', false, 40),
    ('ADHESIVO_PRO', 'humidity_min', false, 50),
    ('ADHESIVO_PRO', 'humidity_max', false, 60),
    ('ADHESIVO_PRO', 'temperature_min', false, 70),
    ('ADHESIVO_PRO', 'temperature_max', false, 80),
    ('ADHESIVO_PRO', 'viscosity', false, 90),
    ('ADHESIVO_PRO', 'experience_level', false, 100),
    ('ADHESIVO_PRO', 'storage_instructions', false, 110),
    ('LAMPARA', 'power_watts', false, 10),
    ('LAMPARA', 'lamp_technology', false, 20),
    ('LAMPARA', 'power_mode', false, 30),
    ('LAMPARA', 'charging_method', false, 40),
    ('LAMPARA', 'timers', false, 50),
    ('LAMPARA', 'automatic_sensor', false, 60),
    ('LAMPARA', 'led_count', false, 70),
    ('LAMPARA', 'removable_base', false, 80),
    ('LAMPARA', 'color', false, 90),
    ('TORNO_ELECTRICO', 'equipment_type', false, 5),
    ('TORNO_ELECTRICO', 'rpm_min', false, 30),
    ('TORNO_ELECTRICO', 'rpm_max', false, 40),
    ('TORNO_ELECTRICO', 'power_mode', false, 50),
    ('TORNO_ELECTRICO', 'charging_method', false, 60),
    ('TORNO_ELECTRICO', 'rotation_direction', false, 70),
    ('TORNO_ELECTRICO', 'speed_control', false, 80),
    ('TORNO_ELECTRICO', 'control_type', false, 90),
    ('TORNO_ELECTRICO', 'usage_level', false, 100),
    ('TORNO_ELECTRICO', 'handpiece_included', false, 110),
    ('TORNO_ELECTRICO', 'bits_included', false, 120),
    ('TORNO_ELECTRICO', 'color', false, 130),
    ('MAQUINA_CORTE', 'machine_type', false, 10),
    ('MAQUINA_CORTE', 'recommended_use', false, 20),
    ('MAQUINA_CORTE', 'power_watts', false, 30),
    ('MAQUINA_CORTE', 'rpm_max', false, 40),
    ('MAQUINA_CORTE', 'power_mode', false, 50),
    ('MAQUINA_CORTE', 'battery_minutes', false, 60),
    ('MAQUINA_CORTE', 'charge_minutes', false, 70),
    ('MAQUINA_CORTE', 'blade_type', false, 80),
    ('MAQUINA_CORTE', 'cutting_range', false, 90),
    ('MAQUINA_CORTE', 'color', false, 100),
    ('ACCESORIO_REPUESTO', 'accessory_type', false, 10),
    ('ACCESORIO_REPUESTO', 'voltage', false, 20),
    ('ACCESORIO_REPUESTO', 'amperage', false, 30),
    ('ACCESORIO_REPUESTO', 'power_watts', false, 40),
    ('ACCESORIO_REPUESTO', 'connector_type', false, 50),
    ('ACCESORIO_REPUESTO', 'pin_count', false, 60),
    ('ACCESORIO_REPUESTO', 'compatibility_level', false, 70),
    ('ACCESORIO_REPUESTO', 'compatibility_note', false, 80),
    ('ACCESORIO_REPUESTO', 'color', false, 90)
) as mapping(template_code, attribute_code, required, sort_order)
join public.attribute_templates template on template.code = mapping.template_code
join public.attribute_definitions definition on definition.code = mapping.attribute_code
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

-- Árbol interno: la UI mostrará solo los nombres de familia, nunca la ruta.
insert into public.categories (parent_id, name, slug, template_id, sort_order)
values
  (null, 'Uñas', 'unas', null, 100),
  (null, 'Pestañas', 'pestanas', null, 200),
  (null, 'Equipos', 'equipos', null, 300),
  (null, 'Accesorios', 'accesorios', null, 500)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Esmaltes', 'esmaltes', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'unas' and template.code = 'ESMALTE_TONOS'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Pestañas en tira', 'pestanas-en-tira', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'pestanas' and template.code = 'PESTANA_TIRA'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Extensiones profesionales', 'extensiones-profesionales-v2', template.id, 20
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'pestanas' and template.code = 'EXTENSIONES_PRO'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Adhesivos profesionales', 'adhesivos-profesionales', template.id, 30
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'pestanas' and template.code = 'ADHESIVO_PRO'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Lámparas', 'lamparas', template.id, 20
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'equipos' and template.code = 'LAMPARA'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Tornos y pulidores', 'tornos', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'equipos' and template.code = 'TORNO_ELECTRICO'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
values (null, 'Barbería y cabello', 'barberia-cabello', null, 400)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, is_active = true, sort_order = excluded.sort_order;

insert into public.categories (parent_id, name, slug, template_id, sort_order)
select parent.id, 'Máquinas de corte', 'maquinas-de-corte', template.id, 10
from public.categories parent
cross join public.attribute_templates template
where parent.parent_id is null and parent.slug = 'barberia-cabello' and template.code = 'MAQUINA_CORTE'
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name, template_id = excluded.template_id, is_active = true, sort_order = excluded.sort_order;

update public.categories
set template_id = (select id from public.attribute_templates where code = 'ACCESORIO_REPUESTO')
where parent_id is null and slug = 'accesorios';

commit;
