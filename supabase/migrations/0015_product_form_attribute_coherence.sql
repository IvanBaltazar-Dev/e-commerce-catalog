begin;

-- Estas definiciones no deben depender del seed demostrativo: forman parte del esquema.
insert into public.attribute_definitions (
  code, name, data_type, scope, unit, is_filterable, is_searchable,
  is_variant_axis, is_required, is_multivalue, sort_order
)
values
  ('voltage', 'Voltaje', 'single_option', 'product', null, true, false, false, false, false, 10),
  ('power_watts', 'Potencia', 'measurement', 'product', 'W', true, false, false, false, false, 20)
on conflict (code) do update
set name = excluded.name,
    data_type = excluded.data_type,
    scope = excluded.scope,
    unit = excluded.unit,
    is_filterable = excluded.is_filterable,
    is_searchable = excluded.is_searchable,
    is_variant_axis = excluded.is_variant_axis,
    is_multivalue = excluded.is_multivalue,
    is_active = true;

insert into public.attribute_options(attribute_definition_id, value, label, sort_order)
select definition.id, option.value, option.label, option.sort_order
from (
  values
    ('5v', '5 V', 10),
    ('12v', '12 V', 20),
    ('24v', '24 V', 30),
    ('110v', '110 V', 40),
    ('220v', '220 V', 50),
    ('bivolt', 'Bivolt / 110–240 V', 60)
) as option(value, label, sort_order)
join public.attribute_definitions definition on definition.code = 'voltage'
on conflict (attribute_definition_id, value) do update
set label = excluded.label,
    sort_order = excluded.sort_order,
    is_active = true;

-- Reafirma las asociaciones que antes dependían del orden en que se cargaba el seed.
insert into public.template_attributes(
  template_id, attribute_definition_id, is_required_override, scope_override, sort_order
)
select template.id, definition.id, mapping.required, 'product'::public.attribute_scope, mapping.sort_order
from (
  values
    ('TORNO_ELECTRICO', 'voltage', true, 10),
    ('TORNO_ELECTRICO', 'power_watts', true, 20),
    ('LAMPARA', 'power_watts', false, 10),
    ('MAQUINA_CORTE', 'power_watts', false, 30),
    ('ACCESORIO_REPUESTO', 'voltage', false, 20),
    ('ACCESORIO_REPUESTO', 'power_watts', false, 40)
) as mapping(template_code, attribute_code, required, sort_order)
join public.attribute_templates template on template.code = mapping.template_code
join public.attribute_definitions definition on definition.code = mapping.attribute_code
on conflict (template_id, attribute_definition_id) do update
set is_required_override = excluded.is_required_override,
    scope_override = excluded.scope_override,
    sort_order = excluded.sort_order;

-- Reglas numéricas reutilizadas por la validación de valores EAV.
update public.attribute_definitions definition
set validation_rules = definition.validation_rules || rule.rules
from (
  values
    ('net_content_amount', '{"min": 0.01}'::jsonb),
    ('content_quantity', '{"min": 1}'::jsonb),
    ('content_ml', '{"min": 0.01}'::jsonb),
    ('drying_seconds', '{"min": 0}'::jsonb),
    ('retention_weeks', '{"min": 0}'::jsonb),
    ('humidity_min', '{"min": 0, "max": 100}'::jsonb),
    ('humidity_max', '{"min": 0, "max": 100}'::jsonb),
    ('power_watts', '{"min": 0}'::jsonb),
    ('rpm_min', '{"min": 0}'::jsonb),
    ('rpm_max', '{"min": 0}'::jsonb),
    ('led_count', '{"min": 0}'::jsonb),
    ('bits_included', '{"min": 0}'::jsonb),
    ('battery_minutes', '{"min": 0}'::jsonb),
    ('charge_minutes', '{"min": 0}'::jsonb),
    ('amperage', '{"min": 0}'::jsonb),
    ('pin_count', '{"min": 1}'::jsonb)
) as rule(code, rules)
where definition.code = rule.code;

create or replace function public.validate_numeric_attribute_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  rules jsonb;
begin
  if new.value_number is null then
    return new;
  end if;

  select definition.validation_rules into rules
  from public.attribute_definitions definition
  where definition.id = new.attribute_definition_id;

  if rules ? 'min' and new.value_number < (rules ->> 'min')::numeric then
    raise exception 'El valor es menor que el mínimo permitido para este atributo.';
  end if;

  if rules ? 'max' and new.value_number > (rules ->> 'max')::numeric then
    raise exception 'El valor supera el máximo permitido para este atributo.';
  end if;

  return new;
end;
$$;

create trigger product_attribute_values_numeric_rules
before insert or update on public.product_attribute_values
for each row execute function public.validate_numeric_attribute_rules();

create trigger variant_attribute_values_numeric_rules
before insert or update on public.variant_attribute_values
for each row execute function public.validate_numeric_attribute_rules();

create table public.template_attribute_comparisons (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null,
  lower_attribute_definition_id uuid not null,
  upper_attribute_definition_id uuid not null,
  created_at timestamptz not null default now(),
  constraint template_attribute_comparisons_distinct check (lower_attribute_definition_id <> upper_attribute_definition_id),
  constraint template_attribute_comparisons_lower_fk foreign key (template_id, lower_attribute_definition_id)
    references public.template_attributes(template_id, attribute_definition_id) on delete cascade,
  constraint template_attribute_comparisons_upper_fk foreign key (template_id, upper_attribute_definition_id)
    references public.template_attributes(template_id, attribute_definition_id) on delete cascade,
  constraint template_attribute_comparisons_unique unique (template_id, lower_attribute_definition_id, upper_attribute_definition_id)
);

alter table public.template_attribute_comparisons enable row level security;

create policy "authenticated read template attribute comparisons"
on public.template_attribute_comparisons for select to authenticated
using (true);

create policy "admins manage template attribute comparisons"
on public.template_attribute_comparisons for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.template_attribute_comparisons to authenticated, service_role;

insert into public.template_attribute_comparisons(
  template_id, lower_attribute_definition_id, upper_attribute_definition_id
)
select template.id, lower_definition.id, upper_definition.id
from (
  values
    ('ADHESIVO_PRO', 'humidity_min', 'humidity_max'),
    ('ADHESIVO_PRO', 'temperature_min', 'temperature_max'),
    ('TORNO_ELECTRICO', 'rpm_min', 'rpm_max')
) as rule(template_code, lower_code, upper_code)
join public.attribute_templates template on template.code = rule.template_code
join public.attribute_definitions lower_definition on lower_definition.code = rule.lower_code
join public.attribute_definitions upper_definition on upper_definition.code = rule.upper_code
on conflict do nothing;

create or replace function public.validate_product_attribute_comparisons(p_product_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  rule record;
  lower_value numeric;
  upper_value numeric;
begin
  for rule in
    select comparison.*
    from public.products product
    join public.template_attribute_comparisons comparison on comparison.template_id = product.template_id
    where product.id = p_product_id
  loop
    select value.value_number into lower_value
    from public.product_attribute_values value
    where value.product_id = p_product_id
      and value.attribute_definition_id = rule.lower_attribute_definition_id;

    select value.value_number into upper_value
    from public.product_attribute_values value
    where value.product_id = p_product_id
      and value.attribute_definition_id = rule.upper_attribute_definition_id;

    if lower_value is not null and upper_value is not null and lower_value > upper_value then
      raise exception 'El valor mínimo de un rango no puede superar su valor máximo.';
    end if;
  end loop;
end;
$$;

create or replace function public.enforce_product_attribute_comparisons()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.validate_product_attribute_comparisons(old.product_id);
    return old;
  end if;

  perform public.validate_product_attribute_comparisons(new.product_id);
  return new;
end;
$$;

create constraint trigger product_attribute_comparisons_check
after insert or update or delete on public.product_attribute_values
deferrable initially deferred
for each row execute function public.enforce_product_attribute_comparisons();

-- Presentación de esmalte fue reemplazada por cantidad decimal + unidad controlada.
delete from public.product_attribute_values value
using public.attribute_definitions definition
where value.attribute_definition_id = definition.id
  and definition.code = 'presentation';

update public.attribute_definitions definition
set is_active = false
where definition.code = 'presentation'
  and not exists (
    select 1 from public.template_attributes mapping
    where mapping.attribute_definition_id = definition.id
  );

-- Sanea valores históricos que ya no pertenecen a la plantilla de su producto.
delete from public.product_attribute_values value
using public.products product, public.attribute_definitions definition
where value.product_id = product.id
  and value.attribute_definition_id = definition.id
  and (
    definition.scope not in ('product', 'both')
    or not exists (
      select 1 from public.template_attributes mapping
      where mapping.template_id = product.template_id
        and mapping.attribute_definition_id = value.attribute_definition_id
        and coalesce(mapping.scope_override, definition.scope) in ('product', 'both')
    )
  );

delete from public.variant_attribute_values value
using public.product_variants variant, public.products product, public.attribute_definitions definition
where value.variant_id = variant.id
  and variant.product_id = product.id
  and value.attribute_definition_id = definition.id
  and (
    definition.scope not in ('variant', 'both')
    or not exists (
      select 1 from public.template_attributes mapping
      where mapping.template_id = product.template_id
        and mapping.attribute_definition_id = value.attribute_definition_id
        and coalesce(mapping.scope_override, definition.scope) in ('variant', 'both')
    )
  );

-- Permite expresar "solo cuando no sea Solo conectado" sin lógica especial en el frontend.
alter table public.template_attribute_conditions
  drop constraint template_attribute_conditions_operator,
  drop constraint template_attribute_conditions_typed_value;

alter table public.template_attribute_conditions
  add constraint template_attribute_conditions_operator
    check (operator in ('equals_boolean', 'equals_option', 'not_equals_option', 'is_set')),
  add constraint template_attribute_conditions_typed_value check (
    (operator = 'equals_boolean' and expected_boolean is not null and expected_option_id is null)
    or (operator in ('equals_option', 'not_equals_option') and expected_boolean is null and expected_option_id is not null)
    or (operator = 'is_set' and expected_boolean is null and expected_option_id is null)
  );

insert into public.template_attribute_conditions(
  template_id,
  target_attribute_definition_id,
  source_attribute_definition_id,
  operator,
  expected_option_id,
  is_required_when_visible
)
select template.id, target.id, source.id, 'not_equals_option', corded.id, false
from (
  values
    ('LAMPARA', 'charging_method'),
    ('TORNO_ELECTRICO', 'charging_method'),
    ('MAQUINA_CORTE', 'battery_minutes'),
    ('MAQUINA_CORTE', 'charge_minutes')
) as rule(template_code, target_code)
join public.attribute_templates template on template.code = rule.template_code
join public.attribute_definitions target on target.code = rule.target_code
join public.attribute_definitions source on source.code = 'power_mode'
join public.attribute_options corded
  on corded.attribute_definition_id = source.id
 and corded.value = 'corded'
on conflict (template_id, target_attribute_definition_id, source_attribute_definition_id) do update
set operator = excluded.operator,
    expected_boolean = null,
    expected_option_id = excluded.expected_option_id,
    is_required_when_visible = excluded.is_required_when_visible;

create or replace function public.validate_product_attribute_conditions(p_product_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  rule record;
  condition_matches boolean;
  target_exists boolean;
begin
  for rule in
    select condition.*
    from public.products product
    join public.template_attribute_conditions condition on condition.template_id = product.template_id
    where product.id = p_product_id
  loop
    select case rule.operator
      when 'equals_boolean' then exists (
        select 1 from public.product_attribute_values value
        where value.product_id = p_product_id
          and value.attribute_definition_id = rule.source_attribute_definition_id
          and value.value_boolean is not distinct from rule.expected_boolean
      )
      when 'equals_option' then exists (
        select 1 from public.product_attribute_values value
        where value.product_id = p_product_id
          and value.attribute_definition_id = rule.source_attribute_definition_id
          and value.option_id = rule.expected_option_id
      )
      when 'not_equals_option' then exists (
        select 1 from public.product_attribute_values value
        where value.product_id = p_product_id
          and value.attribute_definition_id = rule.source_attribute_definition_id
          and value.option_id is not null
          and value.option_id <> rule.expected_option_id
      )
      when 'is_set' then exists (
        select 1 from public.product_attribute_values value
        where value.product_id = p_product_id
          and value.attribute_definition_id = rule.source_attribute_definition_id
      )
      else false
    end into condition_matches;

    select exists (
      select 1 from public.product_attribute_values value
      where value.product_id = p_product_id
        and value.attribute_definition_id = rule.target_attribute_definition_id
    ) into target_exists;

    if not condition_matches and target_exists then
      raise exception 'Un atributo dependiente fue informado cuando su condición no se cumple.';
    end if;

    if condition_matches and rule.is_required_when_visible and not target_exists then
      raise exception 'Falta completar un atributo obligatorio según la respuesta anterior.';
    end if;
  end loop;
end;
$$;

commit;
