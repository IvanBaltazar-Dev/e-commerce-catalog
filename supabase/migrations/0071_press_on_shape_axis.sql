-- ---------------------------------------------------------------------------
-- 0071 · «Forma» es un eje del catálogo, no un dato de la demo
-- ---------------------------------------------------------------------------
-- 0049 declaró que las uñas press on y los tips se describen por su forma:
-- entre sus 42 pares plantilla↔atributo está ('PRESS_ON_DECORADO', 'shape').
-- Esa fila nunca llegó a existir, y el motivo solo se ve reconstruyendo desde
-- cero: `shape` no lo creaba ninguna migración. Lo creaba
-- `supabase/seeds/0002_v2_demo.sql`, y los seeds corren DESPUÉS de todas las
-- migraciones. Cuando 0049 hacía su `join` contra attribute_definitions, el
-- atributo aún no existía, el `join` interno descartaba la fila sin ruido y la
-- migración terminaba «bien».
--
-- POR QUÉ NO SE NOTÓ HASTA AHORA: la base local se construyó aplicando
-- migraciones a mano sobre una base que ya tenía los seeds puestos. En ese
-- orden `shape` sí existía y la asociación entraba. La prueba pgTAP de 0049 la
-- daba por buena porque estaba comprobando una base que nunca se había
-- reconstruido.
--
-- LA REGLA QUE SE VIOLABA: una migración no puede depender de un seed. El seed
-- es opcional —una base de producción no lo corre— así que todo lo que una
-- migración necesite tiene que haberlo creado otra migración. Los ejes que ya
-- estaban bien lo demuestran: `tone` y `color_family` los crea 0011, `voltage`
-- y `power_watts` los crea 0015, y el seed demo se limita a re-afirmarlos.
-- `shape` era el único que 0049 trataba como eje real sin que nadie lo hubiera
-- promovido nunca.
--
-- QUÉ NO HACE ESTA MIGRACIÓN: no inventa las formas concretas. `almond` y
-- `coffin` los siembra la demo, y las formas reales del catálogo son un dato
-- del negocio, no una decisión de esquema. El eje queda disponible y sin
-- opciones; el `is_required_override = false` que hereda de 0049 impide que su
-- ausencia bloquee publicar un press on.
-- ---------------------------------------------------------------------------

begin;

-- El eje, con la misma definición que el seed demo venía imponiendo por su
-- cuenta. A partir de aquí el seed deja de ser su dueño y pasa a re-afirmarlo,
-- igual que hace con `tone` y con `voltage`.
insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('shape', 'Forma', 'single_option', 'variant', null, true, false, true, true, false, 10)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    unit = excluded.unit,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    is_required = excluded.is_required,
    is_multivalue = excluded.is_multivalue,
    sort_order = excluded.sort_order,
    is_active = true;

-- La fila que 0049 quiso escribir y perdió. Mismo criterio que allí: el eje se
-- ofrece, no se exige, y hereda su ámbito de la definición.
insert into public.template_attributes (
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, false, definition.scope, 20
from public.attribute_templates template
join public.attribute_definitions definition on definition.code = 'shape'
where template.code = 'PRESS_ON_DECORADO'
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
