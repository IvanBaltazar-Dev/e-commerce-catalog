begin;

insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('net_content_amount', 'Contenido neto', 'decimal', 'product', null, true, false, false, true, false, 5),
  ('net_content_unit', 'Unidad del contenido', 'single_option', 'product', null, true, false, false, true, false, 6)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    is_filterable = excluded.is_filterable,
    is_required = excluded.is_required,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options(attribute_definition_id, value, label, sort_order)
select definition.id, unit.value, unit.label, unit.sort_order
from (
  values
    ('ml', 'ml', 10),
    ('fl-oz', 'fl oz', 20)
) as unit(value, label, sort_order)
join public.attribute_definitions definition on definition.code = 'net_content_unit'
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options(attribute_definition_id, value, label, sort_order)
select definition.id, finish.value, finish.label, finish.sort_order
from (
  values
    ('glossy', 'Brillante', 10),
    ('matte', 'Mate', 20),
    ('creamy', 'Cremoso', 30),
    ('satin', 'Satinado', 40),
    ('pearl', 'Perlado', 50),
    ('shimmer', 'Shimmer', 60),
    ('glitter', 'Glitter', 70),
    ('metallic', 'Metálico', 80),
    ('holographic', 'Holográfico', 90),
    ('cat-eye', 'Ojo de gato', 100),
    ('jelly', 'Jelly / translúcido', 110),
    ('neon', 'Neón', 120),
    ('mirror', 'Espejo / chrome', 130),
    ('magnetic', 'Magnético', 140),
    ('crackle', 'Craquelado', 150)
) as finish(value, label, sort_order)
join public.attribute_definitions definition on definition.code = 'general_finish'
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

delete from public.template_attributes association
using public.attribute_templates template, public.attribute_definitions definition
where association.template_id = template.id
  and association.attribute_definition_id = definition.id
  and template.code = 'ESMALTE_TONOS'
  and definition.code = 'presentation';

insert into public.template_attributes(
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, true, 'product'::public.attribute_scope,
  case when definition.code = 'net_content_amount' then 5 else 6 end
from public.attribute_templates template
join public.attribute_definitions definition on definition.code in ('net_content_amount', 'net_content_unit')
where template.code = 'ESMALTE_TONOS'
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
