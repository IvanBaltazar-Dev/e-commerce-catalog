begin;

create table public.template_attribute_conditions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.attribute_templates(id) on delete cascade,
  target_attribute_definition_id uuid not null references public.attribute_definitions(id) on delete cascade,
  source_attribute_definition_id uuid not null references public.attribute_definitions(id) on delete cascade,
  operator text not null,
  expected_boolean boolean,
  expected_option_id uuid references public.attribute_options(id),
  is_required_when_visible boolean not null default false,
  created_at timestamptz not null default now(),
  constraint template_attribute_conditions_operator check (operator in ('equals_boolean', 'equals_option', 'is_set')),
  constraint template_attribute_conditions_typed_value check (
    (operator = 'equals_boolean' and expected_boolean is not null and expected_option_id is null)
    or (operator = 'equals_option' and expected_boolean is null and expected_option_id is not null)
    or (operator = 'is_set' and expected_boolean is null and expected_option_id is null)
  ),
  constraint template_attribute_conditions_distinct_fields check (target_attribute_definition_id <> source_attribute_definition_id),
  constraint template_attribute_conditions_unique unique (template_id, target_attribute_definition_id, source_attribute_definition_id)
);

create index template_attribute_conditions_source_idx
on public.template_attribute_conditions(template_id, source_attribute_definition_id);

alter table public.template_attribute_conditions enable row level security;

create policy "authenticated read template attribute conditions"
on public.template_attribute_conditions for select to authenticated
using (true);

create policy "admins manage template attribute conditions"
on public.template_attribute_conditions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.template_attribute_conditions to authenticated, service_role;

insert into public.template_attribute_conditions(
  template_id,
  target_attribute_definition_id,
  source_attribute_definition_id,
  operator,
  expected_boolean,
  is_required_when_visible
)
select
  template.id,
  target.id,
  source.id,
  'equals_boolean',
  true,
  true
from public.attribute_templates template
join public.attribute_definitions target on target.code = 'lamp_technology'
join public.attribute_definitions source on source.code = 'requires_lamp_v2'
where template.code = 'ESMALTE_TONOS'
on conflict (template_id, target_attribute_definition_id, source_attribute_definition_id) do update
set operator = excluded.operator,
    expected_boolean = excluded.expected_boolean,
    expected_option_id = null,
    is_required_when_visible = excluded.is_required_when_visible;

update public.template_attributes association
set is_required_override = true
from public.attribute_templates template, public.attribute_definitions definition
where association.template_id = template.id
  and association.attribute_definition_id = definition.id
  and template.code = 'ESMALTE_TONOS'
  and definition.code = 'requires_lamp_v2';

-- Elimina datos anteriores que ya son semánticamente incompatibles.
delete from public.product_attribute_values target_value
using public.products product,
      public.attribute_templates template,
      public.attribute_definitions target_definition
where target_value.product_id = product.id
  and product.template_id = template.id
  and template.code = 'ESMALTE_TONOS'
  and target_value.attribute_definition_id = target_definition.id
  and target_definition.code = 'lamp_technology'
  and not exists (
    select 1
    from public.product_attribute_values source_value
    join public.attribute_definitions source_definition
      on source_definition.id = source_value.attribute_definition_id
     and source_definition.code = 'requires_lamp_v2'
    where source_value.product_id = product.id
      and source_value.value_boolean = true
  );

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

create or replace function public.enforce_product_attribute_conditions()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.validate_product_attribute_conditions(old.product_id);
    return old;
  end if;

  perform public.validate_product_attribute_conditions(new.product_id);
  return new;
end;
$$;

create constraint trigger product_attribute_conditions_check
after insert or update or delete on public.product_attribute_values
deferrable initially deferred
for each row execute function public.enforce_product_attribute_conditions();

commit;
