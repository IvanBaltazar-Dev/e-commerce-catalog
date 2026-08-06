begin;

create or replace function public.validate_attribute_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  definition public.attribute_definitions%rowtype;
  owner_template_id uuid;
  existing_count integer;
begin
  select * into definition
  from public.attribute_definitions
  where id = new.attribute_definition_id
    and is_active;

  if not found then
    raise exception using errcode = '23503', message = 'El atributo no existe o está inactivo.';
  end if;

  if tg_table_name = 'product_attribute_values' then
    if definition.scope not in ('product', 'both') then
      raise exception using errcode = '23514', message = 'El atributo no admite valores de producto.';
    end if;

    select p.template_id into owner_template_id
    from public.products p
    where p.id = new.product_id;
  else
    if definition.scope not in ('variant', 'both') then
      raise exception using errcode = '23514', message = 'El atributo no admite valores de variante.';
    end if;

    select p.template_id into owner_template_id
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = new.variant_id;
  end if;

  if not exists (
    select 1
    from public.template_attributes ta
    where ta.template_id = owner_template_id
      and ta.attribute_definition_id = new.attribute_definition_id
  ) then
    raise exception using errcode = '23514', message = 'El atributo no pertenece a la plantilla del producto.';
  end if;

  if new.option_id is not null and not exists (
    select 1 from public.attribute_options o
    where o.id = new.option_id
      and o.attribute_definition_id = new.attribute_definition_id
      and o.is_active
  ) then
    raise exception using errcode = '23514', message = 'La opción no pertenece al atributo indicado.';
  end if;

  if (definition.data_type in ('single_option', 'multi_option', 'color')) <> (new.option_id is not null) then
    raise exception using errcode = '23514', message = 'El tipo de dato requiere una opción controlada.';
  end if;

  if definition.data_type = 'text' and new.value_text is null then
    raise exception using errcode = '23514', message = 'El atributo requiere un valor de texto.';
  elsif definition.data_type in ('integer', 'decimal', 'measurement') and new.value_number is null then
    raise exception using errcode = '23514', message = 'El atributo requiere un valor numérico.';
  elsif definition.data_type = 'integer' and trunc(new.value_number) <> new.value_number then
    raise exception using errcode = '23514', message = 'El atributo requiere un número entero.';
  elsif definition.data_type = 'boolean' and new.value_boolean is null then
    raise exception using errcode = '23514', message = 'El atributo requiere un valor booleano.';
  elsif definition.data_type = 'date' and new.value_date is null then
    raise exception using errcode = '23514', message = 'El atributo requiere una fecha.';
  elsif definition.data_type = 'json' and new.value_json is null then
    raise exception using errcode = '23514', message = 'El atributo requiere un valor JSON.';
  end if;

  if not definition.is_multivalue then
    if tg_table_name = 'product_attribute_values' then
      select count(*) into existing_count
      from public.product_attribute_values value
      where value.product_id = new.product_id
        and value.attribute_definition_id = new.attribute_definition_id
        and value.id <> new.id;
    else
      select count(*) into existing_count
      from public.variant_attribute_values value
      where value.variant_id = new.variant_id
        and value.attribute_definition_id = new.attribute_definition_id
        and value.id <> new.id;
    end if;

    if existing_count > 0 then
      raise exception using errcode = '23505', message = 'El atributo no admite múltiples valores.';
    end if;
  end if;

  return new;
end;
$$;

insert into public.attribute_definitions (
  code, name, description, data_type, scope, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, validation_rules, sort_order
)
values
  ('free_from_count', 'Cantidad Free From', 'Cantidad de componentes que la fórmula declara excluir.', 'integer', 'product', true, false, false, false, false, '{"min": 0, "max": 100}'::jsonb, 60),
  ('vegan', 'Vegano', 'Indica si el producto se declara vegano.', 'boolean', 'product', true, false, false, false, false, '{}'::jsonb, 70),
  ('cruelty_free', 'Libre de crueldad', 'Indica si el producto se declara libre de crueldad animal.', 'boolean', 'product', true, false, false, false, false, '{}'::jsonb, 80),
  ('wear_days_max', 'Duración máxima estimada', 'Duración comercial máxima expresada en días.', 'integer', 'product', true, false, false, false, false, '{"min": 0, "max": 365}'::jsonb, 90),
  ('brush_type', 'Tipo de pincel', 'Descripción del pincel o aplicador.', 'text', 'product', false, true, false, false, false, '{}'::jsonb, 100),
  ('catalog_observation', 'Observación de catálogo', 'Descripción editorial breve para el catálogo.', 'text', 'product', false, true, false, false, false, '{}'::jsonb, 110),
  ('catalog_highlight', 'Destacado de catálogo', 'Beneficio o argumento comercial destacado.', 'text', 'product', false, true, false, false, false, '{}'::jsonb, 120),
  ('expert_tip', 'Consejo experto', 'Recomendación de uso o aplicación.', 'text', 'product', false, true, false, false, false, '{}'::jsonb, 130),
  ('finish_type', 'Tipo de acabado del tono', 'Acabado específico de cada variante de esmalte.', 'single_option', 'variant', true, true, false, false, false, '{}'::jsonb, 30),
  ('tone_group', 'Grupo del tono', 'Agrupación comercial dentro de una carta de colores.', 'single_option', 'variant', true, true, false, false, false, '{}'::jsonb, 40),
  ('photochromic_pair', 'Par fotocromático', 'Colores de referencia sin sol y con sol.', 'json', 'variant', false, false, false, false, false, '{}'::jsonb, 50)
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    data_type = excluded.data_type,
    scope = excluded.scope,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    is_required = excluded.is_required,
    is_multivalue = excluded.is_multivalue,
    validation_rules = excluded.validation_rules,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.attribute_options(attribute_definition_id, value, label, sort_order)
select definition.id, option.value, option.label, option.sort_order
from (
  values
    ('finish_type', 'creamy', 'Cremoso', 10),
    ('finish_type', 'pearl', 'Perlado', 20),
    ('finish_type', 'translucent', 'Traslúcido', 30),
    ('finish_type', 'metallic', 'Metalizado', 40),
    ('finish_type', 'pearl-metallic', 'Perlado + metalizado', 50),
    ('finish_type', 'translucent-pearl', 'Traslúcido + perlado', 60),
    ('finish_type', 'glitter', 'Brillo con partículas / escarchado', 70),
    ('finish_type', 'photochromatic', 'Fotocromático', 80),
    ('tone_group', 'carta-principal', 'Carta principal', 10),
    ('tone_group', 'brillos-particulas', 'Brillos con partículas', 20),
    ('tone_group', 'decoracion', 'Decoración', 30),
    ('tone_group', 'fotocromatico', 'Fotocromáticos', 40)
) as option(attribute_code, value, label, sort_order)
join public.attribute_definitions definition on definition.code = option.attribute_code
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.template_attributes(
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, false, definition.scope, definition.sort_order
from public.attribute_templates template
join public.attribute_definitions definition on definition.code in (
  'free_from_count', 'vegan', 'cruelty_free', 'wear_days_max', 'brush_type',
  'catalog_observation', 'catalog_highlight', 'expert_tip', 'finish_type',
  'tone_group', 'photochromic_pair'
)
where template.code = 'ESMALTE_TONOS'
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

commit;
