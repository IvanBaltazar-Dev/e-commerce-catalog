-- Bellaroshe Catalog V2
-- Modelo aditivo: conserva V1, crea la unidad comprable variante y realiza backfill.

begin;

create extension if not exists btree_gist;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Tipos controlados
-- ---------------------------------------------------------------------------

create type public.product_editorial_status as enum (
  'draft',
  'in_review',
  'published',
  'hidden',
  'incomplete'
);

create type public.attribute_data_type as enum (
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'single_option',
  'multi_option',
  'color',
  'measurement'
);

create type public.attribute_scope as enum ('product', 'variant', 'both');

create type public.media_role as enum (
  'main',
  'gallery',
  'color_chart',
  'technical_sheet',
  'catalog_pdf',
  'swatch',
  'packaging',
  'detail'
);

create type public.price_list_type as enum ('retail', 'wholesale', 'special');
create type public.wholesale_scope_type as enum ('variant', 'product', 'brand', 'category');
create type public.wholesale_mixing_policy as enum (
  'same_variant',
  'same_product',
  'same_brand',
  'same_category'
);

create type public.product_relation_type as enum (
  'compatible_with',
  'replacement_for',
  'spare_part_for',
  'accessory_for',
  'recommended_with',
  'alternative_to',
  'requires',
  'included_with'
);

create type public.compatibility_status as enum (
  'confirmed',
  'conditional',
  'unknown',
  'not_compatible'
);

create type public.import_batch_status as enum (
  'uploaded',
  'parsing',
  'normalized',
  'needs_review',
  'approved',
  'committed',
  'failed',
  'cancelled'
);

create type public.import_proposed_action as enum (
  'create_product',
  'create_variant',
  'update_product',
  'update_variant',
  'skip',
  'merge'
);

create type public.import_row_status as enum (
  'pending',
  'normalized',
  'needs_review',
  'approved',
  'committed',
  'skipped',
  'failed'
);

create type public.import_issue_severity as enum ('info', 'warning', 'error', 'blocking');
create type public.import_issue_status as enum ('open', 'resolved', 'ignored');

-- ---------------------------------------------------------------------------
-- Plantillas y atributos
-- ---------------------------------------------------------------------------

create table public.attribute_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attribute_templates_name_not_blank check (length(trim(name)) > 0),
  constraint attribute_templates_code_format check (code ~ '^[A-Z0-9]+(_[A-Z0-9]+)*$')
);

create table public.attribute_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  data_type public.attribute_data_type not null,
  unit text,
  scope public.attribute_scope not null,
  is_filterable boolean not null default false,
  is_searchable boolean not null default false,
  is_variant_axis boolean not null default false,
  is_required boolean not null default false,
  is_multivalue boolean not null default false,
  validation_rules jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attribute_definitions_code_format check (code ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  constraint attribute_definitions_name_not_blank check (length(trim(name)) > 0),
  constraint attribute_definitions_rules_object check (jsonb_typeof(validation_rules) = 'object'),
  constraint attribute_definitions_axis_scope check (
    not is_variant_axis or scope in ('variant', 'both')
  ),
  constraint attribute_definitions_multi_type check (
    not is_multivalue or data_type in ('multi_option', 'text')
  )
);

create table public.attribute_options (
  id uuid primary key default gen_random_uuid(),
  attribute_definition_id uuid not null references public.attribute_definitions(id),
  value text not null,
  label text not null,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attribute_options_value_not_blank check (length(trim(value)) > 0),
  constraint attribute_options_label_not_blank check (length(trim(label)) > 0),
  constraint attribute_options_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint attribute_options_definition_value_unique unique (attribute_definition_id, value)
);

create table public.template_attributes (
  template_id uuid not null references public.attribute_templates(id),
  attribute_definition_id uuid not null references public.attribute_definitions(id),
  is_required_override boolean,
  scope_override public.attribute_scope,
  sort_order integer not null default 0,
  default_value jsonb,
  created_at timestamptz not null default now(),
  primary key (template_id, attribute_definition_id)
);

insert into public.attribute_templates (name, code, description)
values (
  'Legado V1',
  'LEGACY_V1',
  'Plantilla temporal usada para conservar y migrar productos creados con el modelo V1.'
);

-- ---------------------------------------------------------------------------
-- Jerarquía de categorías y evolución aditiva de productos
-- ---------------------------------------------------------------------------

alter table public.categories
  drop constraint categories_slug_key;

alter table public.categories
  add column parent_id uuid references public.categories(id),
  add column template_id uuid references public.attribute_templates(id);

alter table public.categories
  add constraint categories_parent_not_self check (parent_id is null or parent_id <> id),
  add constraint categories_parent_slug_unique unique nulls not distinct (parent_id, slug);

update public.categories
set template_id = (
  select id from public.attribute_templates where code = 'LEGACY_V1'
)
where template_id is null;

alter table public.products
  add column template_id uuid references public.attribute_templates(id),
  add column short_description text,
  add column editorial_status public.product_editorial_status not null default 'published',
  add column is_featured boolean not null default false,
  add column published_at timestamptz;

update public.products
set template_id = (
      select id from public.attribute_templates where code = 'LEGACY_V1'
    ),
    editorial_status = case
      when description is null or length(trim(description)) = 0
        then 'incomplete'::public.product_editorial_status
      when is_active then 'published'::public.product_editorial_status
      else 'hidden'::public.product_editorial_status
    end,
    published_at = case when is_active then created_at else null end
where template_id is null;

alter table public.products
  alter column template_id set not null;

comment on column public.products.is_active is
  'Desactivación lógica u operativa. Tiene precedencia sobre editorial_status y conserva referencias históricas.';
comment on column public.products.editorial_status is
  'Estado exclusivo del flujo editorial: draft, in_review, published, hidden o incomplete.';

-- ---------------------------------------------------------------------------
-- Variantes: toda unidad comprable vive aquí
-- ---------------------------------------------------------------------------

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  sku text,
  name text not null,
  variant_key text not null,
  barcode text,
  availability_status public.product_availability not null default 'consult',
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  weight numeric(12, 3),
  width numeric(12, 3),
  height numeric(12, 3),
  length numeric(12, 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_name_not_blank check (length(trim(name)) > 0),
  constraint product_variants_sku_not_blank check (sku is null or length(trim(sku)) > 0),
  constraint product_variants_key_not_blank check (length(trim(variant_key)) > 0),
  constraint product_variants_dimensions_non_negative check (
    (weight is null or weight >= 0)
    and (width is null or width >= 0)
    and (height is null or height >= 0)
    and (length is null or length >= 0)
  ),
  constraint product_variants_product_key_unique unique (product_id, variant_key)
);

create unique index product_variants_sku_unique_idx
on public.product_variants(lower(sku))
where sku is not null;

create unique index product_variants_one_active_default_idx
on public.product_variants(product_id)
where is_default and is_active;

create index product_variants_product_sort_idx
on public.product_variants(product_id, is_active, sort_order);

create index product_variants_availability_idx
on public.product_variants(availability_status)
where is_active;

-- ---------------------------------------------------------------------------
-- Valores tipados de atributos
-- ---------------------------------------------------------------------------

create table public.product_attribute_values (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions(id),
  option_id uuid references public.attribute_options(id),
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_attribute_values_one_value check (
    num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 1
  )
);

create table public.variant_attribute_values (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions(id),
  option_id uuid references public.attribute_options(id),
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variant_attribute_values_one_value check (
    num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 1
  )
);

create index product_attribute_values_filter_option_idx
on public.product_attribute_values(attribute_definition_id, option_id, product_id)
where option_id is not null;

create index product_attribute_values_filter_number_idx
on public.product_attribute_values(attribute_definition_id, value_number, product_id)
where value_number is not null;

create index variant_attribute_values_filter_option_idx
on public.variant_attribute_values(attribute_definition_id, option_id, variant_id)
where option_id is not null;

create index variant_attribute_values_filter_number_idx
on public.variant_attribute_values(attribute_definition_id, value_number, variant_id)
where value_number is not null;

-- ---------------------------------------------------------------------------
-- Medios unificados
-- ---------------------------------------------------------------------------

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  width integer,
  height integer,
  alt_text text,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_assets_bucket_not_blank check (length(trim(bucket)) > 0),
  constraint media_assets_path_not_blank check (length(trim(storage_path)) > 0),
  constraint media_assets_file_name_not_blank check (length(trim(file_name)) > 0),
  constraint media_assets_size_non_negative check (size_bytes is null or size_bytes >= 0),
  constraint media_assets_dimensions_non_negative check (
    (width is null or width >= 0) and (height is null or height >= 0)
  ),
  constraint media_assets_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint media_assets_bucket_path_unique unique (bucket, storage_path)
);

create unique index media_assets_checksum_unique_idx
on public.media_assets(checksum)
where checksum is not null;

alter table public.brands
  add column logo_media_id uuid references public.media_assets(id);

create table public.product_media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  media_asset_id uuid not null references public.media_assets(id),
  media_role public.media_role not null,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint product_media_exactly_one_owner check (
    num_nonnulls(product_id, variant_id) = 1
  )
);

create unique index product_media_product_asset_role_unique_idx
on public.product_media(product_id, media_asset_id, media_role)
where product_id is not null;

create unique index product_media_variant_asset_role_unique_idx
on public.product_media(variant_id, media_asset_id, media_role)
where variant_id is not null;

create unique index product_media_one_primary_product_role_idx
on public.product_media(product_id, media_role)
where product_id is not null and is_primary;

create unique index product_media_one_primary_variant_role_idx
on public.product_media(variant_id, media_role)
where variant_id is not null and is_primary;

create index product_media_product_sort_idx
on public.product_media(product_id, media_role, sort_order)
where product_id is not null;

create index product_media_variant_sort_idx
on public.product_media(variant_id, media_role, sort_order)
where variant_id is not null;

-- ---------------------------------------------------------------------------
-- Precios y reglas mayoristas
-- ---------------------------------------------------------------------------

create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  currency char(3) not null default 'PEN',
  price_type public.price_list_type not null,
  priority integer not null default 0,
  is_public boolean not null default true,
  is_active boolean not null default true,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_lists_code_format check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint price_lists_name_not_blank check (length(trim(name)) > 0),
  constraint price_lists_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint price_lists_validity check (valid_to is null or valid_from is null or valid_to > valid_from)
);

create table public.variant_prices (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  price_list_id uuid not null references public.price_lists(id),
  amount numeric(12, 2) not null,
  compare_at_amount numeric(12, 2),
  minimum_quantity integer not null default 1,
  validity tstzrange not null default tstzrange(now(), null, '[)'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variant_prices_amount_non_negative check (amount >= 0),
  constraint variant_prices_compare_non_negative check (
    compare_at_amount is null or compare_at_amount >= 0
  ),
  constraint variant_prices_minimum_positive check (minimum_quantity > 0),
  constraint variant_prices_validity_nonempty check (
    not isempty(validity) and lower(validity) is not null
  ),
  constraint variant_prices_no_active_overlap exclude using gist (
    variant_id with =,
    price_list_id with =,
    validity with &&
  ) where (is_active)
);

create index variant_prices_lookup_idx
on public.variant_prices(variant_id, price_list_id, is_active);

create table public.wholesale_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope_type public.wholesale_scope_type not null,
  variant_id uuid references public.product_variants(id),
  product_id uuid references public.products(id),
  brand_id uuid references public.brands(id),
  category_id uuid references public.categories(id),
  minimum_quantity integer not null,
  mixing_policy public.wholesale_mixing_policy not null,
  price_list_id uuid not null references public.price_lists(id),
  priority integer not null default 0,
  is_active boolean not null default true,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_rules_name_not_blank check (length(trim(name)) > 0),
  constraint wholesale_rules_exactly_one_scope check (
    num_nonnulls(variant_id, product_id, brand_id, category_id) = 1
  ),
  constraint wholesale_rules_scope_consistent check (
    (scope_type = 'variant' and variant_id is not null)
    or (scope_type = 'product' and product_id is not null)
    or (scope_type = 'brand' and brand_id is not null)
    or (scope_type = 'category' and category_id is not null)
  ),
  constraint wholesale_rules_minimum_positive check (minimum_quantity > 0),
  constraint wholesale_rules_validity check (
    valid_to is null or valid_from is null or valid_to > valid_from
  )
);

create index wholesale_rules_variant_idx on public.wholesale_rules(variant_id) where variant_id is not null;
create index wholesale_rules_product_idx on public.wholesale_rules(product_id) where product_id is not null;
create index wholesale_rules_brand_idx on public.wholesale_rules(brand_id) where brand_id is not null;
create index wholesale_rules_category_idx on public.wholesale_rules(category_id) where category_id is not null;

insert into public.price_lists (code, name, price_type, priority)
values
  ('retail-pen', 'Precio minorista PEN', 'retail', 100),
  ('wholesale-pen', 'Precio mayorista PEN', 'wholesale', 200);

-- ---------------------------------------------------------------------------
-- Relaciones comerciales y técnicas
-- ---------------------------------------------------------------------------

create table public.product_relations (
  id uuid primary key default gen_random_uuid(),
  source_product_id uuid references public.products(id),
  source_variant_id uuid references public.product_variants(id),
  target_product_id uuid references public.products(id),
  target_variant_id uuid references public.product_variants(id),
  relation_type public.product_relation_type not null,
  compatibility_status public.compatibility_status not null default 'unknown',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  source_ref text generated always as (
    case
      when source_product_id is not null then 'product:' || source_product_id::text
      else 'variant:' || source_variant_id::text
    end
  ) stored,
  target_ref text generated always as (
    case
      when target_product_id is not null then 'product:' || target_product_id::text
      else 'variant:' || target_variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_relations_one_source check (
    num_nonnulls(source_product_id, source_variant_id) = 1
  ),
  constraint product_relations_one_target check (
    num_nonnulls(target_product_id, target_variant_id) = 1
  ),
  constraint product_relations_not_self check (source_ref <> target_ref),
  constraint product_relations_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index product_relations_directional_unique_idx
on public.product_relations(relation_type, source_ref, target_ref)
where is_active and relation_type in (
  'spare_part_for',
  'accessory_for',
  'replacement_for',
  'requires',
  'included_with',
  'recommended_with'
);

create unique index product_relations_symmetric_unique_idx
on public.product_relations(
  relation_type,
  least(source_ref, target_ref),
  greatest(source_ref, target_ref)
)
where is_active and relation_type in ('compatible_with', 'alternative_to');

create index product_relations_source_product_idx
on public.product_relations(source_product_id)
where source_product_id is not null and is_active;

create index product_relations_source_variant_idx
on public.product_relations(source_variant_id)
where source_variant_id is not null and is_active;

create index product_relations_target_product_idx
on public.product_relations(target_product_id)
where target_product_id is not null and is_active;

create index product_relations_target_variant_idx
on public.product_relations(target_variant_id)
where target_variant_id is not null and is_active;

-- ---------------------------------------------------------------------------
-- Staging de importación
-- ---------------------------------------------------------------------------

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_name text not null,
  original_file_name text,
  status public.import_batch_status not null default 'uploaded',
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  error_rows integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_batches_source_type_not_blank check (length(trim(source_type)) > 0),
  constraint import_batches_source_name_not_blank check (length(trim(source_name)) > 0),
  constraint import_batches_counts_valid check (
    total_rows >= 0
    and processed_rows >= 0
    and error_rows >= 0
    and processed_rows <= total_rows
    and error_rows <= total_rows
  )
);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null,
  normalized_data jsonb,
  proposed_action public.import_proposed_action,
  status public.import_row_status not null default 'pending',
  target_product_id uuid references public.products(id),
  target_variant_id uuid references public.product_variants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_rows_row_number_positive check (row_number > 0),
  constraint import_rows_raw_object check (jsonb_typeof(raw_data) = 'object'),
  constraint import_rows_normalized_object check (
    normalized_data is null or jsonb_typeof(normalized_data) = 'object'
  ),
  constraint import_rows_batch_row_unique unique (batch_id, row_number)
);

create table public.import_issues (
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null references public.import_rows(id) on delete cascade,
  issue_code text not null,
  severity public.import_issue_severity not null,
  field_name text,
  message text not null,
  suggested_value jsonb,
  resolution jsonb,
  status public.import_issue_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint import_issues_code_not_blank check (length(trim(issue_code)) > 0),
  constraint import_issues_message_not_blank check (length(trim(message)) > 0),
  constraint import_issues_resolution_consistent check (
    (status = 'open' and resolved_at is null)
    or (status in ('resolved', 'ignored') and resolved_at is not null)
  )
);

create index import_rows_batch_status_idx on public.import_rows(batch_id, status, row_number);
create index import_issues_row_status_idx on public.import_issues(import_row_id, status, severity);

-- ---------------------------------------------------------------------------
-- PDF V2: parámetros directos, sin catalog_views
-- ---------------------------------------------------------------------------

alter table public.pdf_exports
  add column parameters jsonb not null default '{}'::jsonb,
  add column exported_product_ids uuid[] not null default '{}'::uuid[],
  add column item_count integer not null default 0;

alter table public.pdf_exports
  add constraint pdf_exports_parameters_object check (jsonb_typeof(parameters) = 'object'),
  add constraint pdf_exports_item_count_non_negative check (item_count >= 0);

-- ---------------------------------------------------------------------------
-- Integridad transaccional
-- ---------------------------------------------------------------------------

create or replace function public.prevent_category_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception using
      errcode = '23514',
      message = 'Una categoría no puede ser su propio padre.';
  end if;

  if exists (
    with recursive descendants as (
      select c.id
      from public.categories c
      where c.parent_id = new.id
      union all
      select child.id
      from public.categories child
      join descendants d on child.parent_id = d.id
    )
    select 1 from descendants where id = new.parent_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'La jerarquía de categorías no puede contener ciclos.';
  end if;

  return new;
end;
$$;

create trigger categories_prevent_cycle
before insert or update of parent_id on public.categories
for each row execute function public.prevent_category_cycle();

create or replace function public.assert_active_product_has_default_variant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  affected_product_id uuid;
begin
  if tg_table_name = 'products' then
    affected_product_id := coalesce(new.id, old.id);
  else
    affected_product_id := coalesce(new.product_id, old.product_id);
  end if;

  if exists (
    select 1
    from public.products p
    where p.id = affected_product_id
      and p.is_active
  ) and not exists (
    select 1
    from public.product_variants v
    where v.product_id = affected_product_id
      and v.is_active
      and v.is_default
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'El producto activo %s debe tener una variante predeterminada activa.',
        affected_product_id
      );
  end if;

  return null;
end;
$$;

create constraint trigger products_require_default_variant
after insert or update or delete on public.products
deferrable initially deferred
for each row execute function public.assert_active_product_has_default_variant();

create constraint trigger product_variants_require_default_variant
after insert or update or delete on public.product_variants
deferrable initially deferred
for each row execute function public.assert_active_product_has_default_variant();

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

create trigger product_attribute_values_validate
before insert or update on public.product_attribute_values
for each row execute function public.validate_attribute_value();

create trigger variant_attribute_values_validate
before insert or update on public.variant_attribute_values
for each row execute function public.validate_attribute_value();

create or replace function public.create_product_with_default_variant(
  p_product jsonb,
  p_variant jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  created_product public.products%rowtype;
  created_variant public.product_variants%rowtype;
  variant_availability public.product_availability;
  initial_retail numeric(12, 2);
  initial_wholesale numeric(12, 2);
  initial_wholesale_min integer;
  retail_list_id uuid;
  wholesale_list_id uuid;
begin
  if jsonb_typeof(p_product) <> 'object' or jsonb_typeof(p_variant) <> 'object' then
    raise exception using errcode = '22023', message = 'Producto y variante deben ser objetos JSON.';
  end if;

  variant_availability := coalesce(
    nullif(p_variant ->> 'availability', '')::public.product_availability,
    'consult'::public.product_availability
  );
  initial_retail := coalesce(nullif(p_variant ->> 'retailPrice', '')::numeric, 0);
  initial_wholesale := coalesce(
    nullif(p_variant ->> 'wholesalePrice', '')::numeric,
    initial_retail
  );
  initial_wholesale_min := coalesce(
    nullif(p_variant ->> 'wholesaleMinimum', '')::integer,
    1
  );

  insert into public.products (
    code,
    slug,
    brand_id,
    category_id,
    template_id,
    name,
    presentation,
    product_type,
    requires_lamp,
    lamp_type,
    description,
    short_description,
    unit_price,
    wholesale_price,
    wholesale_min_quantity,
    availability,
    color_chart_status,
    is_active,
    editorial_status,
    is_featured,
    sort_order,
    published_at
  ) values (
    trim(p_product ->> 'code'),
    trim(p_product ->> 'slug'),
    (p_product ->> 'brandId')::uuid,
    (p_product ->> 'categoryId')::uuid,
    (p_product ->> 'templateId')::uuid,
    trim(p_product ->> 'name'),
    coalesce(nullif(trim(p_variant ->> 'name'), ''), 'Presentación única'),
    coalesce(nullif(trim(p_product ->> 'productType'), ''), 'Catálogo V2'),
    coalesce((p_product ->> 'requiresLamp')::boolean, false),
    coalesce(nullif(p_product ->> 'lampType', ''), 'No'),
    nullif(trim(p_product ->> 'description'), ''),
    nullif(trim(p_product ->> 'shortDescription'), ''),
    initial_retail,
    initial_wholesale,
    initial_wholesale_min,
    variant_availability,
    'consult_advisor',
    coalesce((p_product ->> 'isActive')::boolean, true),
    coalesce(
      nullif(p_product ->> 'editorialStatus', '')::public.product_editorial_status,
      'draft'::public.product_editorial_status
    ),
    coalesce((p_product ->> 'isFeatured')::boolean, false),
    coalesce(nullif(p_product ->> 'sortOrder', '')::integer, 0),
    case
      when p_product ->> 'editorialStatus' = 'published' then now()
      else null
    end
  )
  returning * into created_product;

  insert into public.product_variants (
    product_id,
    sku,
    name,
    variant_key,
    barcode,
    availability_status,
    is_default,
    is_active,
    sort_order
  ) values (
    created_product.id,
    coalesce(nullif(trim(p_variant ->> 'sku'), ''), created_product.code),
    coalesce(nullif(trim(p_variant ->> 'name'), ''), 'Presentación única'),
    coalesce(nullif(trim(p_variant ->> 'variantKey'), ''), 'presentation=default'),
    nullif(trim(p_variant ->> 'barcode'), ''),
    variant_availability,
    true,
    coalesce((p_variant ->> 'isActive')::boolean, true),
    coalesce(nullif(p_variant ->> 'sortOrder', '')::integer, 0)
  )
  returning * into created_variant;

  select id into retail_list_id from public.price_lists where code = 'retail-pen';
  select id into wholesale_list_id from public.price_lists where code = 'wholesale-pen';

  insert into public.variant_prices (
    variant_id,
    price_list_id,
    amount,
    minimum_quantity,
    validity
  ) values (
    created_variant.id,
    retail_list_id,
    initial_retail,
    1,
    tstzrange(now(), null, '[)')
  );

  if p_variant ? 'wholesalePrice' then
    insert into public.variant_prices (
      variant_id,
      price_list_id,
      amount,
      minimum_quantity,
      validity
    ) values (
      created_variant.id,
      wholesale_list_id,
      initial_wholesale,
      initial_wholesale_min,
      tstzrange(now(), null, '[)')
    );

    insert into public.wholesale_rules (
      name,
      scope_type,
      product_id,
      minimum_quantity,
      mixing_policy,
      price_list_id,
      priority
    ) values (
      'Mayorista · ' || created_product.name,
      'product',
      created_product.id,
      initial_wholesale_min,
      'same_product',
      wholesale_list_id,
      100
    );
  end if;

  return jsonb_build_object(
    'productId', created_product.id,
    'variantId', created_variant.id
  );
end;
$$;

create or replace function public.replace_default_variant(
  p_product_id uuid,
  p_variant_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.product_variants
    where id = p_variant_id
      and product_id = p_product_id
      and is_active
  ) then
    raise exception using
      errcode = '23514',
      message = 'La variante predeterminada debe estar activa y pertenecer al producto.';
  end if;

  update public.product_variants
  set is_default = false
  where product_id = p_product_id
    and is_default;

  update public.product_variants
  set is_default = true
  where id = p_variant_id
    and product_id = p_product_id;
end;
$$;

create or replace function public.commit_approved_import_row(p_import_row_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  import_row public.import_rows%rowtype;
  result jsonb;
begin
  select * into import_row
  from public.import_rows
  where id = p_import_row_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'La fila de importación no existe.';
  end if;

  if import_row.status <> 'approved' or import_row.proposed_action <> 'create_product' then
    raise exception using
      errcode = '23514',
      message = 'Solo se puede convertir una fila aprobada para crear producto.';
  end if;

  if exists (
    select 1
    from public.import_issues issue
    where issue.import_row_id = import_row.id
      and issue.status = 'open'
      and issue.severity in ('error', 'blocking')
  ) then
    raise exception using errcode = '23514', message = 'La fila contiene incidencias bloqueantes.';
  end if;

  result := public.create_product_with_default_variant(
    import_row.normalized_data -> 'product',
    import_row.normalized_data -> 'variant'
  );

  update public.import_rows
  set status = 'committed',
      target_product_id = (result ->> 'productId')::uuid,
      target_variant_id = (result ->> 'variantId')::uuid,
      updated_at = now()
  where id = import_row.id;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill V1 → V2
-- ---------------------------------------------------------------------------

insert into public.product_variants (
  product_id,
  sku,
  name,
  variant_key,
  availability_status,
  is_default,
  is_active,
  sort_order,
  created_at,
  updated_at
)
select
  p.id,
  p.code,
  coalesce(nullif(p.presentation, ''), 'Presentación única'),
  'presentation=default',
  p.availability,
  true,
  p.is_active,
  0,
  p.created_at,
  p.updated_at
from public.products p
where not exists (
  select 1 from public.product_variants v where v.product_id = p.id
);

insert into public.variant_prices (
  variant_id,
  price_list_id,
  amount,
  minimum_quantity,
  validity,
  created_at,
  updated_at
)
select
  v.id,
  pl.id,
  p.unit_price,
  1,
  tstzrange(p.created_at, null, '[)'),
  p.created_at,
  p.updated_at
from public.products p
join public.product_variants v on v.product_id = p.id and v.is_default
join public.price_lists pl on pl.code = 'retail-pen'
where not exists (
  select 1
  from public.variant_prices vp
  where vp.variant_id = v.id and vp.price_list_id = pl.id
);

insert into public.variant_prices (
  variant_id,
  price_list_id,
  amount,
  minimum_quantity,
  validity,
  created_at,
  updated_at
)
select
  v.id,
  pl.id,
  p.wholesale_price,
  p.wholesale_min_quantity,
  tstzrange(p.created_at, null, '[)'),
  p.created_at,
  p.updated_at
from public.products p
join public.product_variants v on v.product_id = p.id and v.is_default
join public.price_lists pl on pl.code = 'wholesale-pen'
where not exists (
  select 1
  from public.variant_prices vp
  where vp.variant_id = v.id and vp.price_list_id = pl.id
);

insert into public.wholesale_rules (
  name,
  scope_type,
  product_id,
  minimum_quantity,
  mixing_policy,
  price_list_id,
  priority,
  created_at,
  updated_at
)
select
  'Mayorista V1 · ' || p.name,
  'product',
  p.id,
  p.wholesale_min_quantity,
  'same_product',
  pl.id,
  100,
  p.created_at,
  p.updated_at
from public.products p
join public.price_lists pl on pl.code = 'wholesale-pen'
where not exists (
  select 1
  from public.wholesale_rules wr
  where wr.product_id = p.id
    and wr.price_list_id = pl.id
);

insert into public.media_assets (
  bucket,
  storage_path,
  file_name,
  mime_type,
  metadata
)
select distinct
  'catalog-assets',
  source.storage_path,
  regexp_replace(source.storage_path, '^.*/', ''),
  case
    when lower(source.storage_path) ~ '\\.pdf$' then 'application/pdf'
    when lower(source.storage_path) ~ '\\.png$' then 'image/png'
    when lower(source.storage_path) ~ '\\.webp$' then 'image/webp'
    when lower(source.storage_path) ~ '\\.gif$' then 'image/gif'
    else 'image/jpeg'
  end,
  jsonb_build_object('migrated_from_v1', true)
from (
  select main_image_path as storage_path from public.products where main_image_path is not null
  union
  select color_chart_image_path from public.products where color_chart_image_path is not null
  union
  select color_chart_pdf_path from public.products where color_chart_pdf_path is not null
  union
  select path from public.product_images
) source
where length(trim(source.storage_path)) > 0
on conflict (bucket, storage_path) do nothing;

insert into public.product_media (
  product_id,
  media_asset_id,
  media_role,
  sort_order,
  is_primary,
  created_at
)
select p.id, media.id, 'main', 0, true, p.created_at
from public.products p
join public.media_assets media
  on media.bucket = 'catalog-assets' and media.storage_path = p.main_image_path
where p.main_image_path is not null
on conflict do nothing;

insert into public.product_media (
  product_id,
  media_asset_id,
  media_role,
  sort_order,
  is_primary,
  created_at
)
select p.id, media.id, 'color_chart', 0, true, p.created_at
from public.products p
join public.media_assets media
  on media.bucket = 'catalog-assets' and media.storage_path = p.color_chart_image_path
where p.color_chart_image_path is not null
on conflict do nothing;

insert into public.product_media (
  product_id,
  media_asset_id,
  media_role,
  sort_order,
  is_primary,
  created_at
)
select p.id, media.id, 'catalog_pdf', 0, true, p.created_at
from public.products p
join public.media_assets media
  on media.bucket = 'catalog-assets' and media.storage_path = p.color_chart_pdf_path
where p.color_chart_pdf_path is not null
on conflict do nothing;

insert into public.product_media (
  product_id,
  media_asset_id,
  media_role,
  sort_order,
  is_primary,
  created_at
)
select image.product_id, media.id, 'gallery', image.sort_order, false, image.created_at
from public.product_images image
join public.media_assets media
  on media.bucket = 'catalog-assets' and media.storage_path = image.path
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Rutas canónicas y búsqueda
-- ---------------------------------------------------------------------------

create or replace view public.category_paths
with (security_invoker = true)
as
with recursive tree as (
  select
    c.id,
    c.parent_id,
    c.name,
    c.slug,
    c.slug::text as canonical_path,
    0 as depth
  from public.categories c
  where c.parent_id is null

  union all

  select
    child.id,
    child.parent_id,
    child.name,
    child.slug,
    tree.canonical_path || '/' || child.slug,
    tree.depth + 1
  from public.categories child
  join tree on tree.id = child.parent_id
)
select * from tree;

alter table public.products
  add column search_document tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(code, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(short_description, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(product_type, '')
    )
  ) stored;

create index products_search_document_idx on public.products using gin(search_document);
create index products_name_trgm_idx on public.products using gin(name gin_trgm_ops);
create index products_editorial_active_idx
on public.products(editorial_status, is_active, sort_order, name);
create index products_template_idx on public.products(template_id);
create index categories_parent_active_sort_idx
on public.categories(parent_id, is_active, sort_order);

create or replace function public.assert_published_product_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  affected_product_id uuid;
begin
  if tg_table_name = 'products' then
    affected_product_id := coalesce(new.id, old.id);
  elsif tg_table_name = 'product_variants' then
    affected_product_id := coalesce(new.product_id, old.product_id);
  elsif tg_table_name = 'product_attribute_values' then
    affected_product_id := coalesce(new.product_id, old.product_id);
  elsif tg_table_name = 'variant_attribute_values' then
    select v.product_id into affected_product_id
    from public.product_variants v
    where v.id = coalesce(new.variant_id, old.variant_id);
  elsif tg_table_name = 'variant_prices' then
    select v.product_id into affected_product_id
    from public.product_variants v
    where v.id = coalesce(new.variant_id, old.variant_id);
  end if;

  if affected_product_id is null or not exists (
    select 1
    from public.products p
    where p.id = affected_product_id
      and p.editorial_status = 'published'
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.product_variants v
    where v.product_id = affected_product_id
      and v.is_active
      and (v.sku is null or length(trim(v.sku)) = 0)
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar un producto con variantes activas sin SKU.';
  end if;

  if exists (
    select 1
    from public.product_variants v
    where v.product_id = affected_product_id
      and v.is_active
      and v.availability_status = 'available'
      and not exists (
        select 1
        from public.variant_prices vp
        join public.price_lists pl on pl.id = vp.price_list_id
        where vp.variant_id = v.id
          and vp.is_active
          and vp.validity @> now()
          and pl.is_active
          and pl.price_type = 'retail'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar una variante disponible sin precio minorista vigente.';
  end if;

  if exists (
    select 1
    from public.products p
    join public.template_attributes ta on ta.template_id = p.template_id
    join public.attribute_definitions ad on ad.id = ta.attribute_definition_id
    where p.id = affected_product_id
      and ad.is_active
      and coalesce(ta.is_required_override, ad.is_required)
      and coalesce(ta.scope_override, ad.scope) in ('product', 'both')
      and not exists (
        select 1
        from public.product_attribute_values pav
        where pav.product_id = p.id
          and pav.attribute_definition_id = ad.id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar: faltan atributos obligatorios del producto.';
  end if;

  if exists (
    select 1
    from public.products p
    join public.product_variants v on v.product_id = p.id and v.is_active
    join public.template_attributes ta on ta.template_id = p.template_id
    join public.attribute_definitions ad on ad.id = ta.attribute_definition_id
    where p.id = affected_product_id
      and ad.is_active
      and coalesce(ta.is_required_override, ad.is_required)
      and coalesce(ta.scope_override, ad.scope) in ('variant', 'both')
      and not exists (
        select 1
        from public.variant_attribute_values vav
        where vav.variant_id = v.id
          and vav.attribute_definition_id = ad.id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar: faltan atributos obligatorios de una variante.';
  end if;

  return null;
end;
$$;

create constraint trigger products_validate_publication
after insert or update or delete on public.products
deferrable initially deferred
for each row execute function public.assert_published_product_complete();

create constraint trigger product_variants_validate_publication
after insert or update or delete on public.product_variants
deferrable initially deferred
for each row execute function public.assert_published_product_complete();

create constraint trigger product_attribute_values_validate_publication
after insert or update or delete on public.product_attribute_values
deferrable initially deferred
for each row execute function public.assert_published_product_complete();

create constraint trigger variant_attribute_values_validate_publication
after insert or update or delete on public.variant_attribute_values
deferrable initially deferred
for each row execute function public.assert_published_product_complete();

create constraint trigger variant_prices_validate_publication
after insert or update or delete on public.variant_prices
deferrable initially deferred
for each row execute function public.assert_published_product_complete();

-- ---------------------------------------------------------------------------
-- Funciones de visibilidad usadas por RLS
-- ---------------------------------------------------------------------------

create or replace function public.is_public_catalog_product(product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    join public.brands b on b.id = p.brand_id
    join public.categories c on c.id = p.category_id
    where p.id = product_id
      and p.is_active
      and p.editorial_status = 'published'
      and b.is_active
      and c.is_active
  );
$$;

create or replace function public.is_public_catalog_variant(variant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.product_variants v
    where v.id = variant_id
      and v.is_active
      and public.is_public_catalog_product(v.product_id)
  );
$$;

create or replace function public.is_public_catalog_media(media_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.product_media pm
    where pm.media_asset_id = media_id
      and (
        (pm.product_id is not null and public.is_public_catalog_product(pm.product_id))
        or (pm.variant_id is not null and public.is_public_catalog_variant(pm.variant_id))
      )
  );
$$;

-- El backfill genera eventos de constraint triggers diferibles. Se validan
-- explícitamente antes de cualquier ALTER TABLE posterior (como habilitar RLS),
-- porque PostgreSQL no permite alterar una tabla con eventos pendientes.
set constraints all immediate;
set constraints all deferred;

drop policy if exists "public read active products" on public.products;
create policy "public read published active products"
on public.products
for select
to anon, authenticated
using (public.is_public_catalog_product(id));

drop policy if exists "public read active product images" on public.product_images;
create policy "public read images of published products"
on public.product_images
for select
to anon, authenticated
using (public.is_public_catalog_product(product_id));

alter table public.attribute_templates enable row level security;
alter table public.attribute_definitions enable row level security;
alter table public.attribute_options enable row level security;
alter table public.template_attributes enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_attribute_values enable row level security;
alter table public.variant_attribute_values enable row level security;
alter table public.media_assets enable row level security;
alter table public.product_media enable row level security;
alter table public.price_lists enable row level security;
alter table public.variant_prices enable row level security;
alter table public.wholesale_rules enable row level security;
alter table public.product_relations enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_issues enable row level security;

create policy "public read active templates"
on public.attribute_templates for select to anon, authenticated
using (is_active);

create policy "public read active attribute definitions"
on public.attribute_definitions for select to anon, authenticated
using (is_active);

create policy "public read active attribute options"
on public.attribute_options for select to anon, authenticated
using (
  is_active
  and exists (
    select 1 from public.attribute_definitions ad
    where ad.id = attribute_definition_id and ad.is_active
  )
);

create policy "public read active template attributes"
on public.template_attributes for select to anon, authenticated
using (
  exists (
    select 1
    from public.attribute_templates template
    join public.attribute_definitions definition
      on definition.id = attribute_definition_id
    where template.id = template_id
      and template.is_active
      and definition.is_active
  )
);

create policy "public read active catalog variants"
on public.product_variants for select to anon, authenticated
using (public.is_public_catalog_variant(id));

create policy "public read product attributes"
on public.product_attribute_values for select to anon, authenticated
using (public.is_public_catalog_product(product_id));

create policy "public read variant attributes"
on public.variant_attribute_values for select to anon, authenticated
using (public.is_public_catalog_variant(variant_id));

create policy "public read catalog media assets"
on public.media_assets for select to anon, authenticated
using (public.is_public_catalog_media(id));

create policy "public read catalog product media"
on public.product_media for select to anon, authenticated
using (
  (product_id is not null and public.is_public_catalog_product(product_id))
  or (variant_id is not null and public.is_public_catalog_variant(variant_id))
);

create policy "public read active public price lists"
on public.price_lists for select to anon, authenticated
using (
  is_active
  and is_public
  and (valid_from is null or valid_from <= now())
  and (valid_to is null or valid_to > now())
);

create policy "public read current variant prices"
on public.variant_prices for select to anon, authenticated
using (
  is_active
  and validity @> now()
  and public.is_public_catalog_variant(variant_id)
  and exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_id and pl.is_active and pl.is_public
  )
);

create policy "public read applicable wholesale rules"
on public.wholesale_rules for select to anon, authenticated
using (
  is_active
  and (valid_from is null or valid_from <= now())
  and (valid_to is null or valid_to > now())
  and exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_id and pl.is_active and pl.is_public
  )
  and (
    (variant_id is not null and public.is_public_catalog_variant(variant_id))
    or (product_id is not null and public.is_public_catalog_product(product_id))
    or (brand_id is not null and exists (
      select 1 from public.brands b where b.id = brand_id and b.is_active
    ))
    or (category_id is not null and exists (
      select 1 from public.categories c where c.id = category_id and c.is_active
    ))
  )
);

create policy "public read catalog relations"
on public.product_relations for select to anon, authenticated
using (
  is_active
  and (
    (source_product_id is not null and public.is_public_catalog_product(source_product_id))
    or (source_variant_id is not null and public.is_public_catalog_variant(source_variant_id))
  )
  and (
    (target_product_id is not null and public.is_public_catalog_product(target_product_id))
    or (target_variant_id is not null and public.is_public_catalog_variant(target_variant_id))
  )
);

create policy "admins manage attribute templates"
on public.attribute_templates for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage attribute definitions"
on public.attribute_definitions for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage attribute options"
on public.attribute_options for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage template attributes"
on public.template_attributes for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product variants"
on public.product_variants for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product attributes"
on public.product_attribute_values for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage variant attributes"
on public.variant_attribute_values for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage media assets"
on public.media_assets for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product media"
on public.product_media for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage price lists"
on public.price_lists for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage variant prices"
on public.variant_prices for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage wholesale rules"
on public.wholesale_rules for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product relations"
on public.product_relations for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage import batches"
on public.import_batches for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage import rows"
on public.import_rows for all to authenticated
using (public.is_admin()) with check (public.is_admin());
create policy "admins manage import issues"
on public.import_issues for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Privilegios explícitos
-- ---------------------------------------------------------------------------

grant select on
  public.attribute_templates,
  public.attribute_definitions,
  public.attribute_options,
  public.template_attributes,
  public.product_variants,
  public.product_attribute_values,
  public.variant_attribute_values,
  public.media_assets,
  public.product_media,
  public.price_lists,
  public.variant_prices,
  public.wholesale_rules,
  public.product_relations,
  public.category_paths
to anon, authenticated;

grant insert, update, delete on
  public.attribute_templates,
  public.attribute_definitions,
  public.attribute_options,
  public.template_attributes,
  public.product_variants,
  public.product_attribute_values,
  public.variant_attribute_values,
  public.media_assets,
  public.product_media,
  public.price_lists,
  public.variant_prices,
  public.wholesale_rules,
  public.product_relations,
  public.import_batches,
  public.import_rows,
  public.import_issues
to authenticated;

grant select on
  public.import_batches,
  public.import_rows,
  public.import_issues
to authenticated;

revoke all on
  public.import_batches,
  public.import_rows,
  public.import_issues
from anon;

grant all on
  public.attribute_templates,
  public.attribute_definitions,
  public.attribute_options,
  public.template_attributes,
  public.product_variants,
  public.product_attribute_values,
  public.variant_attribute_values,
  public.media_assets,
  public.product_media,
  public.price_lists,
  public.variant_prices,
  public.wholesale_rules,
  public.product_relations,
  public.import_batches,
  public.import_rows,
  public.import_issues
to service_role;

revoke execute on function public.create_product_with_default_variant(jsonb, jsonb)
from public, anon;
revoke execute on function public.replace_default_variant(uuid, uuid)
from public, anon;
revoke execute on function public.commit_approved_import_row(uuid)
from public, anon;

grant execute on function public.create_product_with_default_variant(jsonb, jsonb)
to authenticated, service_role;
grant execute on function public.replace_default_variant(uuid, uuid)
to authenticated, service_role;
grant execute on function public.commit_approved_import_row(uuid)
to authenticated, service_role;

grant execute on function public.is_public_catalog_product(uuid)
to anon, authenticated, service_role;
grant execute on function public.is_public_catalog_variant(uuid)
to anon, authenticated, service_role;
grant execute on function public.is_public_catalog_media(uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- updated_at e invalidación del catálogo
-- ---------------------------------------------------------------------------

create trigger attribute_templates_set_updated_at
before update on public.attribute_templates
for each row execute function public.set_updated_at();
create trigger attribute_definitions_set_updated_at
before update on public.attribute_definitions
for each row execute function public.set_updated_at();
create trigger attribute_options_set_updated_at
before update on public.attribute_options
for each row execute function public.set_updated_at();
create trigger product_variants_set_updated_at
before update on public.product_variants
for each row execute function public.set_updated_at();
create trigger product_attribute_values_set_updated_at
before update on public.product_attribute_values
for each row execute function public.set_updated_at();
create trigger variant_attribute_values_set_updated_at
before update on public.variant_attribute_values
for each row execute function public.set_updated_at();
create trigger media_assets_set_updated_at
before update on public.media_assets
for each row execute function public.set_updated_at();
create trigger price_lists_set_updated_at
before update on public.price_lists
for each row execute function public.set_updated_at();
create trigger variant_prices_set_updated_at
before update on public.variant_prices
for each row execute function public.set_updated_at();
create trigger wholesale_rules_set_updated_at
before update on public.wholesale_rules
for each row execute function public.set_updated_at();
create trigger product_relations_set_updated_at
before update on public.product_relations
for each row execute function public.set_updated_at();
create trigger import_batches_set_updated_at
before update on public.import_batches
for each row execute function public.set_updated_at();
create trigger import_rows_set_updated_at
before update on public.import_rows
for each row execute function public.set_updated_at();

create trigger attribute_templates_touch_catalog
after insert or update or delete on public.attribute_templates
for each statement execute function public.touch_catalog_metadata();
create trigger attribute_definitions_touch_catalog
after insert or update or delete on public.attribute_definitions
for each statement execute function public.touch_catalog_metadata();
create trigger attribute_options_touch_catalog
after insert or update or delete on public.attribute_options
for each statement execute function public.touch_catalog_metadata();
create trigger template_attributes_touch_catalog
after insert or update or delete on public.template_attributes
for each statement execute function public.touch_catalog_metadata();
create trigger product_variants_touch_catalog
after insert or update or delete on public.product_variants
for each statement execute function public.touch_catalog_metadata();
create trigger product_attribute_values_touch_catalog
after insert or update or delete on public.product_attribute_values
for each statement execute function public.touch_catalog_metadata();
create trigger variant_attribute_values_touch_catalog
after insert or update or delete on public.variant_attribute_values
for each statement execute function public.touch_catalog_metadata();
create trigger media_assets_touch_catalog
after insert or update or delete on public.media_assets
for each statement execute function public.touch_catalog_metadata();
create trigger product_media_touch_catalog
after insert or update or delete on public.product_media
for each statement execute function public.touch_catalog_metadata();
create trigger price_lists_touch_catalog
after insert or update or delete on public.price_lists
for each statement execute function public.touch_catalog_metadata();
create trigger variant_prices_touch_catalog
after insert or update or delete on public.variant_prices
for each statement execute function public.touch_catalog_metadata();
create trigger wholesale_rules_touch_catalog
after insert or update or delete on public.wholesale_rules
for each statement execute function public.touch_catalog_metadata();
create trigger product_relations_touch_catalog
after insert or update or delete on public.product_relations
for each statement execute function public.touch_catalog_metadata();

commit;
