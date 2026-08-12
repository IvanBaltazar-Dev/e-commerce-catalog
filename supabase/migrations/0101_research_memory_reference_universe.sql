-- 0101 · Memoria de investigación y Universo de Referencia
-- Conocer una referencia externa nunca crea catálogo ni inventario Bellaroshé.

begin;

create table public.catalog_research_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  run_kind text not null,
  previous_run_id uuid references public.catalog_research_runs(id) on delete set null,
  actor_kind text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_label text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input_fingerprint text not null,
  result_fingerprint text,
  scope jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_research_runs_key_not_blank check (length(trim(run_key)) > 0),
  constraint catalog_research_runs_kind_allowed check (run_kind in ('baseline', 'delta', 'targeted')),
  constraint catalog_research_runs_actor_allowed check (actor_kind in ('human', 'codex', 'import', 'system')),
  constraint catalog_research_runs_actor_not_blank check (length(trim(actor_label)) > 0),
  constraint catalog_research_runs_status_allowed check (status in (
    'running', 'succeeded', 'partial', 'failed', 'cancelled'
  )),
  constraint catalog_research_runs_completion_consistent check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  constraint catalog_research_runs_previous_not_self check (previous_run_id is null or previous_run_id <> id),
  constraint catalog_research_runs_json_shapes check (
    jsonb_typeof(scope) = 'object'
    and jsonb_typeof(metrics) = 'object'
    and jsonb_typeof(errors) = 'array'
    and jsonb_typeof(result) = 'object'
  )
);

create index catalog_research_runs_previous_idx
  on public.catalog_research_runs(previous_run_id) where previous_run_id is not null;
create index catalog_research_runs_status_date_idx
  on public.catalog_research_runs(status, started_at desc);
create index catalog_research_runs_fingerprint_idx
  on public.catalog_research_runs(input_fingerprint, started_at desc);

create table public.catalog_research_run_brands (
  research_run_id uuid not null references public.catalog_research_runs(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (research_run_id, brand_id)
);

create table public.catalog_research_run_sources (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references public.catalog_research_runs(id) on delete cascade,
  source_id uuid not null references public.catalog_sources(id) on delete restrict,
  brand_id uuid references public.brands(id) on delete restrict,
  scope_key text not null,
  previous_run_source_id uuid references public.catalog_research_run_sources(id) on delete set null,
  status text not null default 'running',
  source_state text not null default 'unchanged',
  input_fingerprint text not null,
  result_fingerprint text,
  scope jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (research_run_id, source_id, scope_key),
  constraint catalog_research_run_sources_scope_not_blank check (length(trim(scope_key)) > 0),
  constraint catalog_research_run_sources_status_allowed check (status in (
    'running', 'succeeded', 'partial', 'failed', 'cancelled'
  )),
  constraint catalog_research_run_sources_state_allowed check (source_state in (
    'first_seen', 'unchanged', 'changed', 'source_unavailable', 'returned'
  )),
  constraint catalog_research_run_sources_completion_consistent check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  constraint catalog_research_run_sources_previous_not_self check (
    previous_run_source_id is null or previous_run_source_id <> id
  ),
  constraint catalog_research_run_sources_json_shapes check (
    jsonb_typeof(scope) = 'object'
    and jsonb_typeof(metrics) = 'object'
    and jsonb_typeof(errors) = 'array'
  )
);

create index catalog_research_run_sources_source_date_idx
  on public.catalog_research_run_sources(source_id, started_at desc);
create index catalog_research_run_sources_run_idx
  on public.catalog_research_run_sources(research_run_id, status);

create table public.catalog_research_run_snapshots (
  research_run_source_id uuid not null references public.catalog_research_run_sources(id) on delete cascade,
  snapshot_id uuid not null references public.catalog_source_snapshots(id) on delete restrict,
  snapshot_role text not null default 'captured',
  created_at timestamptz not null default now(),
  primary key (research_run_source_id, snapshot_id),
  constraint catalog_research_run_snapshots_role_allowed check (snapshot_role in ('captured', 'reused', 'baseline'))
);

create table public.catalog_reference_products (
  id uuid primary key default gen_random_uuid(),
  reference_key text not null unique,
  brand_id uuid not null references public.brands(id) on delete restrict,
  primary_source_id uuid not null references public.catalog_sources(id) on delete restrict,
  primary_source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  primary_external_id text not null,
  name text not null,
  normalized_name text not null,
  family text,
  product_type text,
  line text,
  presentation text,
  source_url text not null,
  primary_image_url text,
  identity_fingerprint text not null,
  content_fingerprint text not null,
  enrichment_level text not null default 'REFERENCE_LIGHT',
  knowledge_status text not null default 'discovered',
  presence_status text not null default 'present',
  first_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  last_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (primary_source_id, primary_external_id),
  unique (brand_id, identity_fingerprint),
  constraint catalog_reference_products_key_not_blank check (length(trim(reference_key)) > 0),
  constraint catalog_reference_products_external_not_blank check (length(trim(primary_external_id)) > 0),
  constraint catalog_reference_products_name_not_blank check (length(trim(name)) > 0 and length(trim(normalized_name)) > 0),
  constraint catalog_reference_products_url_http check (source_url ~ '^https?://'),
  constraint catalog_reference_products_image_http check (primary_image_url is null or primary_image_url ~ '^https?://'),
  constraint catalog_reference_products_level_allowed check (enrichment_level in ('REFERENCE_LIGHT', 'REFERENCE_ENRICHED')),
  constraint catalog_reference_products_knowledge_allowed check (knowledge_status in (
    'discovered', 'observed', 'matched_internal', 'candidate_new',
    'ready_for_commercial_decision', 'adopted', 'rejected', 'identity_conflict',
    'needs_research', 'needs_physical_capture'
  )),
  constraint catalog_reference_products_presence_allowed check (presence_status in (
    'present', 'missing_from_source', 'source_unavailable', 'retired'
  )),
  constraint catalog_reference_products_seen_consistent check (
    first_seen_at <= last_seen_at
  ),
  constraint catalog_reference_products_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_reference_products_brand_name_idx
  on public.catalog_reference_products(brand_id, normalized_name);
create index catalog_reference_products_source_presence_idx
  on public.catalog_reference_products(primary_source_id, presence_status, last_seen_at desc);
create index catalog_reference_products_status_level_idx
  on public.catalog_reference_products(knowledge_status, enrichment_level, last_seen_at desc);
create index catalog_reference_products_name_trgm_idx
  on public.catalog_reference_products using gin (normalized_name gin_trgm_ops);

create table public.catalog_reference_variants (
  id uuid primary key default gen_random_uuid(),
  reference_product_id uuid not null references public.catalog_reference_products(id) on delete restrict,
  reference_key text not null unique,
  primary_source_id uuid not null references public.catalog_sources(id) on delete restrict,
  primary_source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  primary_external_id text not null,
  name text not null,
  normalized_name text not null,
  sku text,
  barcode text,
  shade_name text,
  presentation text,
  source_url text not null,
  primary_image_url text,
  identity_fingerprint text not null,
  content_fingerprint text not null,
  enrichment_level text not null default 'REFERENCE_LIGHT',
  knowledge_status text not null default 'discovered',
  presence_status text not null default 'present',
  first_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  last_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (primary_source_id, primary_external_id),
  unique (reference_product_id, identity_fingerprint),
  constraint catalog_reference_variants_key_not_blank check (length(trim(reference_key)) > 0),
  constraint catalog_reference_variants_external_not_blank check (length(trim(primary_external_id)) > 0),
  constraint catalog_reference_variants_name_not_blank check (length(trim(name)) > 0 and length(trim(normalized_name)) > 0),
  constraint catalog_reference_variants_sku_not_blank check (sku is null or length(trim(sku)) > 0),
  constraint catalog_reference_variants_barcode_not_blank check (barcode is null or length(trim(barcode)) > 0),
  constraint catalog_reference_variants_url_http check (source_url ~ '^https?://'),
  constraint catalog_reference_variants_image_http check (primary_image_url is null or primary_image_url ~ '^https?://'),
  constraint catalog_reference_variants_level_allowed check (enrichment_level in ('REFERENCE_LIGHT', 'REFERENCE_ENRICHED')),
  constraint catalog_reference_variants_knowledge_allowed check (knowledge_status in (
    'discovered', 'observed', 'matched_internal', 'candidate_new',
    'ready_for_commercial_decision', 'adopted', 'rejected', 'identity_conflict',
    'needs_research', 'needs_physical_capture'
  )),
  constraint catalog_reference_variants_presence_allowed check (presence_status in (
    'present', 'missing_from_source', 'source_unavailable', 'retired'
  )),
  constraint catalog_reference_variants_seen_consistent check (first_seen_at <= last_seen_at),
  constraint catalog_reference_variants_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_reference_variants_product_idx
  on public.catalog_reference_variants(reference_product_id, normalized_name);
create index catalog_reference_variants_source_presence_idx
  on public.catalog_reference_variants(primary_source_id, presence_status, last_seen_at desc);
create index catalog_reference_variants_sku_idx
  on public.catalog_reference_variants(primary_source_id, lower(sku)) where sku is not null;
create index catalog_reference_variants_barcode_idx
  on public.catalog_reference_variants(primary_source_id, lower(barcode)) where barcode is not null;
create index catalog_reference_variants_name_trgm_idx
  on public.catalog_reference_variants using gin (normalized_name gin_trgm_ops);

create table public.catalog_reference_identifiers (
  id uuid primary key default gen_random_uuid(),
  reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  source_id uuid not null references public.catalog_sources(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  identifier_kind text not null,
  observed_value text not null,
  normalized_value text not null,
  first_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  last_seen_run_id uuid not null references public.catalog_research_runs(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  target_ref text generated always as (
    case
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint catalog_reference_identifiers_one_target check (
    num_nonnulls(reference_product_id, reference_variant_id) = 1
  ),
  constraint catalog_reference_identifiers_kind_allowed check (identifier_kind in (
    'external_id', 'sku', 'barcode', 'mpn', 'source_url', 'handle'
  )),
  constraint catalog_reference_identifiers_values_not_blank check (
    length(trim(observed_value)) > 0 and length(trim(normalized_value)) > 0
  ),
  constraint catalog_reference_identifiers_seen_consistent check (first_seen_at <= last_seen_at)
);

create unique index catalog_reference_identifiers_unique_idx
  on public.catalog_reference_identifiers(target_ref, source_id, identifier_kind, normalized_value);
create index catalog_reference_identifiers_resolution_idx
  on public.catalog_reference_identifiers(source_id, identifier_kind, normalized_value, target_ref);

create table public.catalog_reference_presence_events (
  id uuid primary key default gen_random_uuid(),
  research_run_source_id uuid not null references public.catalog_research_run_sources(id) on delete restrict,
  reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  delta_status text not null,
  previous_fingerprint text,
  current_fingerprint text,
  observed_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  target_ref text generated always as (
    case
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      when reference_variant_id is not null then 'reference_variant:' || reference_variant_id::text
      else 'source_scope:' || research_run_source_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint catalog_reference_presence_events_target_consistent check (
    (delta_status = 'source_unavailable' and num_nonnulls(reference_product_id, reference_variant_id) = 0)
    or (delta_status <> 'source_unavailable' and num_nonnulls(reference_product_id, reference_variant_id) = 1)
  ),
  constraint catalog_reference_presence_events_delta_allowed check (delta_status in (
    'first_seen', 'unchanged', 'changed', 'missing_from_source', 'returned', 'source_unavailable'
  )),
  constraint catalog_reference_presence_events_fingerprint_consistent check (
    (delta_status in ('first_seen', 'unchanged', 'changed', 'returned') and current_fingerprint is not null)
    or (delta_status in ('missing_from_source', 'source_unavailable') and current_fingerprint is null)
  ),
  constraint catalog_reference_presence_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index catalog_reference_presence_events_run_target_idx
  on public.catalog_reference_presence_events(research_run_source_id, target_ref);
create index catalog_reference_presence_events_target_date_idx
  on public.catalog_reference_presence_events(target_ref, observed_at desc);
create index catalog_reference_presence_events_delta_idx
  on public.catalog_reference_presence_events(delta_status, observed_at desc);

create or replace function public.apply_catalog_reference_presence_event()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  run_id uuid;
  next_presence text;
begin
  if new.delta_status = 'source_unavailable' then
    return new;
  end if;

  select scope.research_run_id into run_id
  from public.catalog_research_run_sources scope
  where scope.id = new.research_run_source_id;

  next_presence := case
    when new.delta_status = 'missing_from_source' then 'missing_from_source'
    else 'present'
  end;

  if new.reference_product_id is not null then
    update public.catalog_reference_products
    set last_seen_run_id = case
          when new.delta_status = 'missing_from_source' or new.observed_at < last_seen_at then last_seen_run_id
          else run_id
        end,
        last_seen_at = case when new.delta_status = 'missing_from_source' then last_seen_at else greatest(last_seen_at, new.observed_at) end,
        content_fingerprint = case
          when new.current_fingerprint is not null and new.observed_at >= last_seen_at then new.current_fingerprint
          else content_fingerprint
        end,
        presence_status = case when new.observed_at >= last_seen_at then next_presence else presence_status end,
        updated_at = now()
    where id = new.reference_product_id;
  else
    update public.catalog_reference_variants
    set last_seen_run_id = case
          when new.delta_status = 'missing_from_source' or new.observed_at < last_seen_at then last_seen_run_id
          else run_id
        end,
        last_seen_at = case when new.delta_status = 'missing_from_source' then last_seen_at else greatest(last_seen_at, new.observed_at) end,
        content_fingerprint = case
          when new.current_fingerprint is not null and new.observed_at >= last_seen_at then new.current_fingerprint
          else content_fingerprint
        end,
        presence_status = case when new.observed_at >= last_seen_at then next_presence else presence_status end,
        updated_at = now()
    where id = new.reference_variant_id;
  end if;

  return new;
end;
$function$;

create trigger catalog_reference_presence_events_apply
after insert on public.catalog_reference_presence_events
for each row execute function public.apply_catalog_reference_presence_event();

create or replace function public.prevent_catalog_reference_presence_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '55000', message = 'Los deltas de investigación son inmutables.';
end;
$function$;

create trigger catalog_reference_presence_events_immutable
before update or delete on public.catalog_reference_presence_events
for each row execute function public.prevent_catalog_reference_presence_event_mutation();

create trigger catalog_research_runs_set_updated_at before update on public.catalog_research_runs
for each row execute function public.set_updated_at();
create trigger catalog_research_run_sources_set_updated_at before update on public.catalog_research_run_sources
for each row execute function public.set_updated_at();
create trigger catalog_reference_products_set_updated_at before update on public.catalog_reference_products
for each row execute function public.set_updated_at();
create trigger catalog_reference_variants_set_updated_at before update on public.catalog_reference_variants
for each row execute function public.set_updated_at();

alter table public.catalog_research_runs enable row level security;
alter table public.catalog_research_run_brands enable row level security;
alter table public.catalog_research_run_sources enable row level security;
alter table public.catalog_research_run_snapshots enable row level security;
alter table public.catalog_reference_products enable row level security;
alter table public.catalog_reference_variants enable row level security;
alter table public.catalog_reference_identifiers enable row level security;
alter table public.catalog_reference_presence_events enable row level security;

create policy "admins manage catalog research runs" on public.catalog_research_runs
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog research run brands" on public.catalog_research_run_brands
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog research run sources" on public.catalog_research_run_sources
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog research run snapshots" on public.catalog_research_run_snapshots
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reference products" on public.catalog_reference_products
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reference variants" on public.catalog_reference_variants
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reference identifiers" on public.catalog_reference_identifiers
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reference presence" on public.catalog_reference_presence_events
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on
  public.catalog_research_runs,
  public.catalog_research_run_brands,
  public.catalog_research_run_sources,
  public.catalog_research_run_snapshots,
  public.catalog_reference_products,
  public.catalog_reference_variants,
  public.catalog_reference_identifiers,
  public.catalog_reference_presence_events
to authenticated, service_role;

comment on table public.catalog_reference_products is
  'Identidad externa persistente. Su existencia no implica que Bellaroshé venda, publique o tenga inventario del artículo.';
comment on table public.catalog_reference_presence_events is
  'Delta inmutable por corrida; missing/source_unavailable nunca eliminan la referencia.';

commit;
