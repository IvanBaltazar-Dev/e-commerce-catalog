begin;

insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('tone', 'Tono', 'single_option', 'variant', null, true, true, true, true, false, 10),
  ('color_family', 'Familia cromática', 'single_option', 'variant', null, true, false, false, true, false, 20)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    is_required = excluded.is_required,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options(attribute_definition_id, value, label, sort_order)
select definition.id, family.value, family.label, family.sort_order
from (
  values
    ('rojos', 'Rojos', 10),
    ('rosados', 'Rosados', 20),
    ('nude', 'Nude y naturales', 30),
    ('morados', 'Morados y lilas', 40),
    ('azules', 'Azules', 50),
    ('verdes', 'Verdes', 60),
    ('amarillos-dorados', 'Amarillos y dorados', 70),
    ('naranjas-corales', 'Naranjas y corales', 80),
    ('marrones', 'Marrones', 90),
    ('blancos', 'Blancos', 100),
    ('negros-grises', 'Negros y grises', 110),
    ('metalicos', 'Metálicos', 120),
    ('transparentes', 'Transparentes', 130),
    ('multicolor', 'Multicolor y efectos', 140)
) as family(value, label, sort_order)
join public.attribute_definitions definition on definition.code = 'color_family'
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes(
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, true, 'variant'::public.attribute_scope,
  case when definition.code = 'tone' then 10 else 20 end
from public.attribute_templates template
join public.attribute_definitions definition on definition.code in ('tone', 'color_family')
where template.code = 'ESMALTE_TONOS'
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
