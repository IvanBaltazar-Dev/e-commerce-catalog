begin;

-- Un accesorio puede pertenecer a cualquier categoría comercial, por eso necesita
-- declarar su área antes de aparecer como relación contextual fuera de su propio tipo.
insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('accessory_domain', 'Área de uso del accesorio', 'single_option', 'product', null, true, true, false, false, false, 5)
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
    ('nails', 'Uñas, esmaltes y manicure', 10),
    ('lashes', 'Pestañas', 20),
    ('barber', 'Barbería y cabello', 30),
    ('equipment', 'Equipos de uso general', 40),
    ('universal', 'Universal / varias áreas', 50)
) as option(value, label, sort_order)
join public.attribute_definitions definition on definition.code = 'accessory_domain'
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, true, 'product', 1
from public.attribute_templates template
join public.attribute_definitions definition on definition.code = 'accessory_domain'
where template.code = 'ACCESORIO_REPUESTO'
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
