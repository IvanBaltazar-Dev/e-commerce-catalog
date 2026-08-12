-- ---------------------------------------------------------------------------
-- 0088 · Endurecimiento de procedencia operativa
-- ---------------------------------------------------------------------------
-- En un trigger genérico, NEW adopta la fila concreta de la tabla. Una
-- expresión CASE intenta resolver campos de ambas formas de fila; las ramas
-- separadas evitan pedir variant_id a product_attribute_values y viceversa.

begin;

create or replace function public.validate_operational_attribute_provenance()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  provenance public.catalog_attribute_provenance%rowtype;
  expected_target text;
begin
  if new.provenance_id is null then
    return new;
  end if;

  if tg_table_name = 'product_attribute_values' then
    expected_target := 'product:' || new.product_id::text;
  else
    expected_target := 'variant:' || new.variant_id::text;
  end if;

  select * into provenance
  from public.catalog_attribute_provenance
  where id = new.provenance_id;

  if provenance.decision_status <> 'approved'
     or provenance.target_ref <> expected_target
     or provenance.attribute_definition_id <> new.attribute_definition_id then
    raise exception using
      errcode = '23514',
      message = 'La procedencia no es una decisión aprobada para este hecho.';
  end if;

  if not exists (
    select 1
    from public.catalog_provenance_observations link
    join public.catalog_observations observation on observation.id = link.observation_id
    where link.provenance_id = new.provenance_id
      and link.stance = 'supports'
      and observation.option_id is not distinct from new.option_id
      and observation.value_text is not distinct from new.value_text
      and observation.value_number is not distinct from new.value_number
      and observation.value_boolean is not distinct from new.value_boolean
      and observation.value_date is not distinct from new.value_date
      and observation.value_json is not distinct from new.value_json
  ) then
    raise exception using
      errcode = '23514',
      message = 'El valor operativo no coincide con ninguna observación aprobada.';
  end if;

  return new;
end;
$function$;

commit;
