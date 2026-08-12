-- 0102 · Observaciones externas, precios históricos y reconciliación tipada

begin;

alter table public.catalog_observations
  drop constraint catalog_observations_one_target,
  drop constraint catalog_observations_one_value,
  drop column target_ref;

alter table public.catalog_observations
  alter column attribute_definition_id drop not null,
  add column research_run_id uuid references public.catalog_research_runs(id) on delete restrict,
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  add column observation_kind text not null default 'attribute',
  add column predicate text not null default 'attribute',
  add column related_product_id uuid references public.products(id) on delete restrict,
  add column related_variant_id uuid references public.product_variants(id) on delete restrict,
  add column related_reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  add column related_reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  add column related_system_id uuid references public.catalog_systems(id) on delete restrict,
  add column related_stage_id uuid references public.catalog_stages(id) on delete restrict,
  add column related_class_id uuid references public.catalog_classes(id) on delete restrict,
  add column target_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      when variant_id is not null then 'variant:' || variant_id::text
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  add column object_ref text generated always as (
    case
      when related_product_id is not null then 'product:' || related_product_id::text
      when related_variant_id is not null then 'variant:' || related_variant_id::text
      when related_reference_product_id is not null then 'reference_product:' || related_reference_product_id::text
      when related_reference_variant_id is not null then 'reference_variant:' || related_reference_variant_id::text
      when related_system_id is not null then 'system:' || related_system_id::text
      when related_stage_id is not null then 'stage:' || related_stage_id::text
      when related_class_id is not null then 'class:' || related_class_id::text
    end
  ) stored;

alter table public.catalog_observations
  add constraint catalog_observations_one_target check (
    num_nonnulls(product_id, variant_id, reference_product_id, reference_variant_id) = 1
  ),
  add constraint catalog_observations_one_value check (
    num_nonnulls(
      option_id, value_text, value_number, value_boolean, value_date, value_json,
      related_product_id, related_variant_id, related_reference_product_id,
      related_reference_variant_id, related_system_id, related_stage_id, related_class_id
    ) = 1
  ),
  add constraint catalog_observations_kind_allowed check (observation_kind in (
    'attribute', 'identity', 'code', 'type', 'presentation', 'shade',
    'technical_attribute', 'system', 'stage', 'class', 'relation',
    'remote_image', 'lifecycle'
  )),
  add constraint catalog_observations_predicate_not_blank check (length(trim(predicate)) > 0),
  add constraint catalog_observations_attribute_consistent check (
    (observation_kind in ('attribute', 'technical_attribute') and attribute_definition_id is not null)
    or (observation_kind not in ('attribute', 'technical_attribute') and attribute_definition_id is null)
  ),
  add constraint catalog_observations_object_consistent check (
    (observation_kind = 'system' and related_system_id is not null)
    or (observation_kind = 'stage' and related_stage_id is not null)
    or (observation_kind = 'class' and related_class_id is not null)
    or (observation_kind = 'relation' and object_ref is not null)
    or (observation_kind = 'remote_image' and object_ref is null and value_text ~ '^https?://')
    or (observation_kind not in ('system', 'stage', 'class', 'relation', 'remote_image') and object_ref is null)
  );

drop trigger catalog_observations_validate on public.catalog_observations;
drop function public.validate_catalog_observation();

create function public.validate_catalog_observation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  definition public.attribute_definitions%rowtype;
  subject_scope text;
begin
  subject_scope := case
    when new.product_id is not null or new.reference_product_id is not null then 'product'
    else 'variant'
  end;

  if new.attribute_definition_id is not null then
    select * into definition
    from public.attribute_definitions
    where id = new.attribute_definition_id and is_active;

    if not found then
      raise exception using errcode = '23503', message = 'El atributo observado no existe o está inactivo.';
    end if;

    if subject_scope = 'product' and definition.scope not in ('product', 'both') then
      raise exception using errcode = '23514', message = 'El atributo observado no admite valores de producto.';
    elsif subject_scope = 'variant' and definition.scope not in ('variant', 'both') then
      raise exception using errcode = '23514', message = 'El atributo observado no admite valores de variante.';
    end if;

    if new.option_id is not null and not exists (
      select 1 from public.attribute_options option
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
  elsif new.option_id is not null then
    raise exception using errcode = '23514', message = 'Una opción observada necesita definición de atributo.';
  end if;

  return new;
end;
$function$;

create trigger catalog_observations_validate
before insert on public.catalog_observations
for each row execute function public.validate_catalog_observation();

create index catalog_observations_target_predicate_idx
  on public.catalog_observations(target_ref, predicate, observed_at desc);
create index catalog_observations_reference_product_idx
  on public.catalog_observations(reference_product_id, observed_at desc)
  where reference_product_id is not null;
create index catalog_observations_reference_variant_idx
  on public.catalog_observations(reference_variant_id, observed_at desc)
  where reference_variant_id is not null;
create index catalog_observations_run_idx
  on public.catalog_observations(research_run_id, observation_kind, observed_at desc)
  where research_run_id is not null;

alter table public.catalog_attribute_provenance
  drop constraint catalog_attribute_provenance_one_target;

alter table public.catalog_attribute_provenance
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  add column subject_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      when variant_id is not null then 'variant:' || variant_id::text
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  add constraint catalog_attribute_provenance_one_target check (
    num_nonnulls(product_id, variant_id, reference_product_id, reference_variant_id) = 1
  );

create unique index catalog_attribute_provenance_subject_current_unique_idx
  on public.catalog_attribute_provenance(subject_ref, attribute_definition_id)
  where decision_status = 'approved';
create index catalog_attribute_provenance_subject_history_idx
  on public.catalog_attribute_provenance(subject_ref, attribute_definition_id, created_at desc);
create index catalog_attribute_provenance_reference_product_idx
  on public.catalog_attribute_provenance(reference_product_id, attribute_definition_id, created_at desc)
  where reference_product_id is not null;
create index catalog_attribute_provenance_reference_variant_idx
  on public.catalog_attribute_provenance(reference_variant_id, attribute_definition_id, created_at desc)
  where reference_variant_id is not null;

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

  if provenance.subject_ref <> observation.target_ref
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

    if previous.subject_ref <> new.subject_ref
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

alter table public.catalog_reconciliation_cases
  add column research_run_id uuid references public.catalog_research_runs(id) on delete restrict,
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  add constraint catalog_reconciliation_cases_reference_consistent check (
    (reference_product_id is null and reference_variant_id is null)
    or (entity_type = 'product' and reference_product_id is not null and reference_variant_id is null)
    or (entity_type = 'variant' and reference_variant_id is not null and reference_product_id is null)
  );

drop index public.catalog_reconciliation_cases_active_unique_idx;
create unique index catalog_reconciliation_cases_active_unique_idx
  on public.catalog_reconciliation_cases(
    entity_type,
    coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(shade_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(reference_product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(reference_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_record_id,
    algorithm
  ) where status in ('proposed', 'needs_review', 'approved');

create index catalog_reconciliation_cases_reference_product_idx
  on public.catalog_reconciliation_cases(reference_product_id, status, score desc)
  where reference_product_id is not null;
create index catalog_reconciliation_cases_reference_variant_idx
  on public.catalog_reconciliation_cases(reference_variant_id, status, score desc)
  where reference_variant_id is not null;

create table public.catalog_reference_prices (
  id uuid primary key default gen_random_uuid(),
  price_key text not null unique,
  research_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  source_id uuid not null references public.catalog_sources(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  currency text not null,
  amount numeric(18,4) not null,
  presentation text,
  external_availability text,
  observed_at timestamptz not null,
  content_fingerprint text not null,
  metadata jsonb not null default '{}'::jsonb,
  target_ref text generated always as (
    case
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint catalog_reference_prices_key_not_blank check (length(trim(price_key)) > 0),
  constraint catalog_reference_prices_one_target check (
    num_nonnulls(reference_product_id, reference_variant_id) = 1
  ),
  constraint catalog_reference_prices_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint catalog_reference_prices_amount_non_negative check (amount >= 0),
  constraint catalog_reference_prices_availability_allowed check (
    external_availability is null or external_availability in (
      'available', 'out_of_stock', 'preorder', 'unknown', 'unavailable'
    )
  ),
  constraint catalog_reference_prices_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_reference_prices_history_idx
  on public.catalog_reference_prices(target_ref, source_id, observed_at desc);
create index catalog_reference_prices_run_idx
  on public.catalog_reference_prices(research_run_id, observed_at desc);

create table public.catalog_reference_media (
  id uuid primary key default gen_random_uuid(),
  media_key text not null unique,
  reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  source_id uuid not null references public.catalog_sources(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  media_kind text not null,
  remote_url text not null,
  content_hash text,
  mime_type text,
  validation_status text not null default 'remote_reference',
  first_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  last_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  target_ref text generated always as (
    case
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_reference_media_key_not_blank check (length(trim(media_key)) > 0),
  constraint catalog_reference_media_one_target check (
    num_nonnulls(reference_product_id, reference_variant_id) = 1
  ),
  constraint catalog_reference_media_kind_allowed check (media_kind in (
    'image', 'swatch', 'manual', 'technical_sheet', 'document'
  )),
  constraint catalog_reference_media_url_http check (remote_url ~ '^https?://'),
  constraint catalog_reference_media_validation_allowed check (validation_status in (
    'remote_reference', 'verified', 'rejected', 'unavailable'
  )),
  constraint catalog_reference_media_seen_consistent check (first_seen_at <= last_seen_at),
  constraint catalog_reference_media_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index catalog_reference_media_target_url_idx
  on public.catalog_reference_media(target_ref, remote_url);
create index catalog_reference_media_status_idx
  on public.catalog_reference_media(validation_status, last_seen_at desc);

create trigger catalog_reference_media_set_updated_at before update on public.catalog_reference_media
for each row execute function public.set_updated_at();

alter table public.catalog_reference_prices enable row level security;
alter table public.catalog_reference_media enable row level security;

create policy "admins manage catalog reference prices" on public.catalog_reference_prices
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reference media" on public.catalog_reference_media
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert on public.catalog_reference_prices to authenticated, service_role;
grant select, insert, update, delete on public.catalog_reference_media to authenticated, service_role;

create or replace function public.get_catalog_reference_knowledge_v1(p_reference_key text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with target as (
    select product.*
    from public.catalog_reference_products product
    where product.reference_key = p_reference_key
  )
  select jsonb_build_object(
    'referenceProduct', (select to_jsonb(target) from target),
    'variants', coalesce((
      select jsonb_agg(to_jsonb(variant) order by variant.reference_key)
      from public.catalog_reference_variants variant
      where variant.reference_product_id = (select id from target)
    ), '[]'::jsonb),
    'identifiers', coalesce((
      select jsonb_agg(to_jsonb(identifier) order by identifier.identifier_kind, identifier.normalized_value)
      from public.catalog_reference_identifiers identifier
      where identifier.reference_product_id = (select id from target)
         or identifier.reference_variant_id in (
           select variant.id from public.catalog_reference_variants variant
           where variant.reference_product_id = (select id from target)
         )
    ), '[]'::jsonb),
    'observations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'observationKey', observation.observation_key,
        'subject', observation.target_ref,
        'kind', observation.observation_kind,
        'predicate', observation.predicate,
        'object', observation.object_ref,
        'valueText', observation.value_text,
        'valueNumber', observation.value_number,
        'valueBoolean', observation.value_boolean,
        'valueDate', observation.value_date,
        'valueJson', observation.value_json,
        'confidence', observation.confidence,
        'observedAt', observation.observed_at,
        'sourceRecordId', observation.source_record_id
      ) order by observation.observed_at, observation.observation_key)
      from public.catalog_observations observation
      where observation.reference_product_id = (select id from target)
         or observation.reference_variant_id in (
           select variant.id from public.catalog_reference_variants variant
           where variant.reference_product_id = (select id from target)
         )
    ), '[]'::jsonb),
    'prices', coalesce((
      select jsonb_agg(to_jsonb(price) order by price.observed_at desc)
      from public.catalog_reference_prices price
      where price.reference_product_id = (select id from target)
         or price.reference_variant_id in (
           select variant.id from public.catalog_reference_variants variant
           where variant.reference_product_id = (select id from target)
         )
    ), '[]'::jsonb),
    'presence', coalesce((
      select jsonb_agg(to_jsonb(event) order by event.observed_at)
      from public.catalog_reference_presence_events event
      where event.reference_product_id = (select id from target)
         or event.reference_variant_id in (
           select variant.id from public.catalog_reference_variants variant
           where variant.reference_product_id = (select id from target)
         )
    ), '[]'::jsonb),
    'reconciliations', coalesce((
      select jsonb_agg(to_jsonb(reconciliation) order by reconciliation.score desc)
      from public.catalog_reconciliation_cases reconciliation
      where reconciliation.reference_product_id = (select id from target)
         or reconciliation.reference_variant_id in (
           select variant.id from public.catalog_reference_variants variant
           where variant.reference_product_id = (select id from target)
         )
    ), '[]'::jsonb)
  )
  where exists (select 1 from target);
$function$;

revoke execute on function public.get_catalog_reference_knowledge_v1(text) from public, anon;
grant execute on function public.get_catalog_reference_knowledge_v1(text) to authenticated, service_role;

comment on table public.catalog_reference_prices is
  'Precio observado fuera de Bellaroshé. Nunca escribe ni reemplaza variant_prices.';
comment on function public.get_catalog_reference_knowledge_v1(text) is
  'Respuesta persistida con identidad externa, fuente, observaciones, deltas, precios y reconciliación.';

commit;
