-- ---------------------------------------------------------------------------
-- 0085 · Hechos observados y procedencia de atributos
-- ---------------------------------------------------------------------------
-- Una observación no es un hecho vigente. La fuente se conserva inmutable,
-- una resolución decide qué observaciones sostienen el hecho y recién entonces
-- la tabla operativa puede apuntar a esa procedencia.

begin;

create table public.catalog_observations (
  id uuid primary key default gen_random_uuid(),
  observation_key text not null unique,
  source_record_id uuid not null references public.catalog_source_records(id) on delete restrict,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions(id) on delete restrict,
  option_id uuid references public.attribute_options(id) on delete restrict,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  observed_unit text,
  observed_at timestamptz not null,
  extraction_method text not null,
  extractor text,
  confidence numeric(5,4) not null,
  metadata jsonb not null default '{}'::jsonb,
  target_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      else 'variant:' || variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint catalog_observations_key_not_blank check (length(trim(observation_key)) > 0),
  constraint catalog_observations_one_target check (num_nonnulls(product_id, variant_id) = 1),
  constraint catalog_observations_one_value check (
    num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 1
  ),
  constraint catalog_observations_method_allowed check (extraction_method in (
    'official_api', 'official_page', 'authorized_distributor', 'internal_document',
    'physical_packaging', 'spreadsheet', 'manual_capture', 'computer_vision'
  )),
  constraint catalog_observations_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint catalog_observations_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint catalog_observations_unit_not_blank check (
    observed_unit is null or length(trim(observed_unit)) > 0
  )
);

create index catalog_observations_target_attribute_idx
  on public.catalog_observations(target_ref, attribute_definition_id, observed_at desc);
create index catalog_observations_source_record_idx
  on public.catalog_observations(source_record_id, created_at);

create or replace function public.validate_catalog_observation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  definition public.attribute_definitions%rowtype;
begin
  select * into definition
  from public.attribute_definitions
  where id = new.attribute_definition_id and is_active;

  if not found then
    raise exception using errcode = '23503', message = 'El atributo observado no existe o está inactivo.';
  end if;

  if new.product_id is not null and definition.scope not in ('product', 'both') then
    raise exception using errcode = '23514', message = 'El atributo observado no admite valores de producto.';
  elsif new.variant_id is not null and definition.scope not in ('variant', 'both') then
    raise exception using errcode = '23514', message = 'El atributo observado no admite valores de variante.';
  end if;

  if new.option_id is not null and not exists (
    select 1
    from public.attribute_options option
    where option.id = new.option_id
      and option.attribute_definition_id = new.attribute_definition_id
      and option.is_active
  ) then
    raise exception using errcode = '23514', message = 'La opción observada no pertenece al atributo indicado.';
  end if;

  if (definition.data_type in ('single_option', 'multi_option', 'color')) <> (new.option_id is not null) then
    raise exception using errcode = '23514', message = 'El tipo observado requiere una opción controlada.';
  elsif definition.data_type = 'text' and new.value_text is null then
    raise exception using errcode = '23514', message = 'El atributo observado requiere texto.';
  elsif definition.data_type in ('integer', 'decimal', 'measurement') and new.value_number is null then
    raise exception using errcode = '23514', message = 'El atributo observado requiere un número.';
  elsif definition.data_type = 'integer' and trunc(new.value_number) <> new.value_number then
    raise exception using errcode = '23514', message = 'El atributo observado requiere un entero.';
  elsif definition.data_type = 'boolean' and new.value_boolean is null then
    raise exception using errcode = '23514', message = 'El atributo observado requiere un booleano.';
  elsif definition.data_type = 'date' and new.value_date is null then
    raise exception using errcode = '23514', message = 'El atributo observado requiere una fecha.';
  elsif definition.data_type = 'json' and new.value_json is null then
    raise exception using errcode = '23514', message = 'El atributo observado requiere JSON.';
  end if;

  return new;
end;
$function$;

create trigger catalog_observations_validate
before insert on public.catalog_observations
for each row execute function public.validate_catalog_observation();

create or replace function public.prevent_catalog_observation_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'Las observaciones son inmutables; registre una nueva observación.';
end;
$function$;

create trigger catalog_observations_immutable
before update or delete on public.catalog_observations
for each row execute function public.prevent_catalog_observation_mutation();

create table public.catalog_attribute_provenance (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions(id) on delete restrict,
  resolution_method text not null,
  decision_status text not null default 'proposed',
  rationale text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  supersedes_id uuid references public.catalog_attribute_provenance(id) on delete restrict,
  target_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      else 'variant:' || variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint catalog_attribute_provenance_one_target check (num_nonnulls(product_id, variant_id) = 1),
  constraint catalog_attribute_provenance_resolution_allowed check (resolution_method in (
    'source_authority', 'most_recent', 'unanimous_sources', 'human_override', 'unresolved_conflict'
  )),
  constraint catalog_attribute_provenance_status_allowed check (decision_status in (
    'proposed', 'approved', 'rejected', 'unresolved', 'superseded'
  )),
  constraint catalog_attribute_provenance_decision_consistent check (
    (decision_status = 'proposed' and decided_at is null)
    or (decision_status <> 'proposed' and decided_at is not null)
  ),
  constraint catalog_attribute_provenance_rationale_consistent check (
    decision_status = 'proposed' or (rationale is not null and length(trim(rationale)) > 0)
  ),
  constraint catalog_attribute_provenance_not_self check (supersedes_id is null or supersedes_id <> id)
);

create unique index catalog_attribute_provenance_current_unique_idx
  on public.catalog_attribute_provenance(target_ref, attribute_definition_id)
  where decision_status = 'approved';
create index catalog_attribute_provenance_history_idx
  on public.catalog_attribute_provenance(target_ref, attribute_definition_id, created_at desc);

create table public.catalog_provenance_observations (
  provenance_id uuid not null references public.catalog_attribute_provenance(id) on delete restrict,
  observation_id uuid not null references public.catalog_observations(id) on delete restrict,
  stance text not null,
  notes text,
  created_at timestamptz not null default now(),
  primary key (provenance_id, observation_id),
  constraint catalog_provenance_observations_stance_allowed check (stance in ('supports', 'contradicts')),
  constraint catalog_provenance_observations_notes_not_blank check (
    notes is null or length(trim(notes)) > 0
  )
);

create index catalog_provenance_observations_observation_idx
  on public.catalog_provenance_observations(observation_id, provenance_id);

create or replace function public.validate_catalog_provenance_observation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  provenance public.catalog_attribute_provenance%rowtype;
  observation public.catalog_observations%rowtype;
begin
  select * into provenance from public.catalog_attribute_provenance where id = new.provenance_id;
  select * into observation from public.catalog_observations where id = new.observation_id;

  if provenance.target_ref <> observation.target_ref
     or provenance.attribute_definition_id <> observation.attribute_definition_id then
    raise exception using
      errcode = '23514',
      message = 'La observación no corresponde al objetivo y atributo de la procedencia.';
  end if;

  if provenance.decision_status <> 'proposed' then
    raise exception using
      errcode = '55000',
      message = 'No se puede modificar la evidencia de una procedencia ya decidida.';
  end if;

  return new;
end;
$function$;

create trigger catalog_provenance_observations_validate
before insert or update on public.catalog_provenance_observations
for each row execute function public.validate_catalog_provenance_observation();

create or replace function public.protect_decided_provenance_observation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1 from public.catalog_attribute_provenance provenance
    where provenance.id = old.provenance_id and provenance.decision_status <> 'proposed'
  ) then
    raise exception using
      errcode = '55000',
      message = 'No se puede retirar evidencia de una procedencia ya decidida.';
  end if;
  return old;
end;
$function$;

create trigger catalog_provenance_observations_protect
before delete on public.catalog_provenance_observations
for each row execute function public.protect_decided_provenance_observation();

create or replace function public.validate_catalog_attribute_provenance_decision()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  previous public.catalog_attribute_provenance%rowtype;
begin
  if new.supersedes_id is not null then
    select * into previous
    from public.catalog_attribute_provenance
    where id = new.supersedes_id;

    if previous.target_ref <> new.target_ref
       or previous.attribute_definition_id <> new.attribute_definition_id then
      raise exception using
        errcode = '23514',
        message = 'Una procedencia solo puede reemplazar al mismo hecho.';
    end if;
  end if;

  if new.decision_status = 'approved' and not exists (
    select 1
    from public.catalog_provenance_observations link
    where link.provenance_id = new.id and link.stance = 'supports'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Una procedencia aprobada necesita al menos una observación que la sostenga.';
  end if;

  return new;
end;
$function$;

create trigger catalog_attribute_provenance_validate_decision
before insert or update on public.catalog_attribute_provenance
for each row execute function public.validate_catalog_attribute_provenance_decision();

alter table public.product_attribute_values
  add column provenance_id uuid references public.catalog_attribute_provenance(id) on delete restrict,
  add column needs_review boolean not null default false;

alter table public.variant_attribute_values
  add column provenance_id uuid references public.catalog_attribute_provenance(id) on delete restrict,
  add column needs_review boolean not null default false;

create index product_attribute_values_provenance_idx
  on public.product_attribute_values(provenance_id) where provenance_id is not null;
create index variant_attribute_values_provenance_idx
  on public.variant_attribute_values(provenance_id) where provenance_id is not null;
create index product_attribute_values_review_idx
  on public.product_attribute_values(product_id) where needs_review;
create index variant_attribute_values_review_idx
  on public.variant_attribute_values(variant_id) where needs_review;

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

  expected_target := case
    when tg_table_name = 'product_attribute_values' then 'product:' || new.product_id::text
    else 'variant:' || new.variant_id::text
  end;

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

create trigger product_attribute_values_validate_provenance
before insert or update on public.product_attribute_values
for each row execute function public.validate_operational_attribute_provenance();

create trigger variant_attribute_values_validate_provenance
before insert or update on public.variant_attribute_values
for each row execute function public.validate_operational_attribute_provenance();

-- Evidencia reutilizable para roles, membresías y relaciones. Los hechos de
-- atributo conservan su vínculo más preciso observación↔procedencia arriba.
create table public.catalog_evidence_sets (
  id uuid primary key default gen_random_uuid(),
  evidence_key text not null,
  version integer not null default 1,
  evidence_type text not null,
  decision_status text not null default 'proposed',
  confidence numeric(5,4) not null,
  rationale text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  supersedes_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (evidence_key, version),
  constraint catalog_evidence_sets_key_not_blank check (length(trim(evidence_key)) > 0),
  constraint catalog_evidence_sets_version_positive check (version > 0),
  constraint catalog_evidence_sets_type_allowed check (evidence_type in (
    'official_sources', 'physical_packaging', 'authorized_distributor',
    'internal_document', 'human_review', 'derived_rule'
  )),
  constraint catalog_evidence_sets_status_allowed check (decision_status in (
    'proposed', 'approved', 'rejected', 'superseded'
  )),
  constraint catalog_evidence_sets_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint catalog_evidence_sets_decision_consistent check (
    (decision_status = 'proposed' and decided_at is null)
    or (decision_status <> 'proposed' and decided_at is not null)
  ),
  constraint catalog_evidence_sets_rationale_consistent check (
    decision_status = 'proposed' or (rationale is not null and length(trim(rationale)) > 0)
  ),
  constraint catalog_evidence_sets_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint catalog_evidence_sets_not_self check (supersedes_id is null or supersedes_id <> id)
);

create index catalog_evidence_sets_review_idx
  on public.catalog_evidence_sets(decision_status, evidence_type, created_at);

create table public.catalog_evidence_items (
  id uuid primary key default gen_random_uuid(),
  evidence_set_id uuid not null references public.catalog_evidence_sets(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  observation_id uuid references public.catalog_observations(id) on delete restrict,
  stance text not null default 'supports',
  notes text,
  created_at timestamptz not null default now(),
  constraint catalog_evidence_items_one_source check (
    num_nonnulls(source_record_id, observation_id) = 1
  ),
  constraint catalog_evidence_items_stance_allowed check (stance in ('supports', 'contradicts')),
  constraint catalog_evidence_items_notes_not_blank check (
    notes is null or length(trim(notes)) > 0
  )
);

create unique index catalog_evidence_items_source_unique_idx
  on public.catalog_evidence_items(evidence_set_id, source_record_id, stance)
  where source_record_id is not null;
create unique index catalog_evidence_items_observation_unique_idx
  on public.catalog_evidence_items(evidence_set_id, observation_id, stance)
  where observation_id is not null;

create or replace function public.catalog_assert_approved_evidence(p_evidence_set_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.catalog_evidence_sets evidence
    where evidence.id = p_evidence_set_id
      and evidence.decision_status = 'approved'
  );
$function$;

revoke execute on function public.catalog_assert_approved_evidence(uuid) from public, anon;
grant execute on function public.catalog_assert_approved_evidence(uuid) to authenticated, service_role;

create trigger catalog_evidence_sets_set_updated_at
before update on public.catalog_evidence_sets
for each row execute function public.set_updated_at();

alter table public.catalog_observations enable row level security;
alter table public.catalog_attribute_provenance enable row level security;
alter table public.catalog_provenance_observations enable row level security;
alter table public.catalog_evidence_sets enable row level security;
alter table public.catalog_evidence_items enable row level security;

create policy "admins manage catalog observations" on public.catalog_observations
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog attribute provenance" on public.catalog_attribute_provenance
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog provenance observations" on public.catalog_provenance_observations
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog evidence sets" on public.catalog_evidence_sets
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog evidence items" on public.catalog_evidence_items
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert on public.catalog_observations to authenticated, service_role;
grant select, insert, update on public.catalog_attribute_provenance to authenticated, service_role;
grant select, insert, update, delete on public.catalog_provenance_observations to authenticated, service_role;
grant select, insert, update, delete on public.catalog_evidence_sets, public.catalog_evidence_items
to authenticated, service_role;

comment on table public.catalog_observations is
  'Observaciones tipadas e inmutables obtenidas de registros fuente. No son hechos operativos hasta que una procedencia las aprueba.';
comment on table public.catalog_attribute_provenance is
  'Historia de decisiones que resuelven observaciones contradictorias para un atributo de producto o variante.';
comment on column public.product_attribute_values.provenance_id is
  'Decisión aprobada que explica el valor; null significa captura manual sin procedencia registrada.';
comment on column public.product_attribute_values.needs_review is
  'La captura manual o heredada necesita revisión, sin impedir guardar el borrador.';

commit;
