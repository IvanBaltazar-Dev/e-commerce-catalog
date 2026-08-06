begin;

-- Los adhesivos deben declarar su uso y alcance de marca antes de participar
-- en recomendaciones automáticas. No se infieren estos datos por nombre.
insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('adhesive_application', 'Uso del adhesivo', 'single_option', 'product', null, true, true, false, false, false, 5),
  ('adhesive_brand_scope', 'Compatibilidad de marca', 'single_option', 'product', null, true, true, false, false, false, 15)
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
    ('adhesive_application', 'strip-lashes', 'Pestañas en tira', 10),
    ('adhesive_application', 'extensions', 'Extensiones profesionales', 20),
    ('adhesive_application', 'both', 'Ambos usos (solo si el fabricante lo indica)', 30),
    ('adhesive_brand_scope', 'universal', 'Universal / sin restricción de marca', 10),
    ('adhesive_brand_scope', 'same-brand', 'Solo productos de la misma marca', 20),
    ('adhesive_brand_scope', 'specific-brand', 'Marca o sistema específico', 30),
    ('adhesive_brand_scope', 'unconfirmed', 'Por confirmar', 40)
) as option(attribute_code, value, label, sort_order)
join public.attribute_definitions definition on definition.code = option.attribute_code
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, mapping.required, 'product', mapping.sort_order
from (
  values
    ('ADHESIVO_PRO', 'adhesive_application', false, 1),
    ('ADHESIVO_PRO', 'adhesive_brand_scope', false, 2),
    ('ADHESIVO_PRO', 'compatibility_note', false, 115)
) as mapping(template_code, attribute_code, required, sort_order)
join public.attribute_templates template on template.code = mapping.template_code
join public.attribute_definitions definition on definition.code = mapping.attribute_code
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
