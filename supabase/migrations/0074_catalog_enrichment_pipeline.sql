-- Permanent, evidence-first catalog enrichment and reconciliation pipeline.
-- External findings are staged here. Nothing in this migration writes unreviewed
-- evidence into products, variants, shades, media or canonical product relations.

create table public.catalog_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  name text not null,
  authority text not null,
  adapter text not null,
  base_url text not null,
  brand_id uuid references public.brands(id) on delete set null,
  refresh_interval interval,
  last_success_at timestamptz,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_sources_key_not_blank check (length(trim(source_key)) > 0),
  constraint catalog_sources_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_sources_url_http check (base_url ~ '^https?://'),
  constraint catalog_sources_authority_allowed check (authority in (
    'official', 'authorized_distributor', 'marketplace', 'internal_document', 'physical_packaging'
  )),
  constraint catalog_sources_adapter_allowed check (adapter in (
    'shopify_products_json', 'woocommerce_store_api', 'html', 'pdf', 'spreadsheet', 'manual_capture'
  )),
  constraint catalog_sources_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  http_status integer,
  content_hash text,
  raw_storage_path text,
  product_count integer not null default 0,
  variant_count integer not null default 0,
  image_count integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint catalog_source_snapshots_status_allowed check (status in (
    'running', 'succeeded', 'partial', 'failed', 'cancelled'
  )),
  constraint catalog_source_snapshots_counts_non_negative check (
    product_count >= 0 and variant_count >= 0 and image_count >= 0
  ),
  constraint catalog_source_snapshots_completion_consistent check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  constraint catalog_source_snapshots_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_source_snapshots_source_date_idx
  on public.catalog_source_snapshots(source_id, started_at desc);
create unique index catalog_source_snapshots_content_unique_idx
  on public.catalog_source_snapshots(source_id, content_hash)
  where content_hash is not null and status in ('succeeded', 'partial');

create table public.catalog_source_records (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.catalog_source_snapshots(id) on delete cascade,
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  entity_type text not null,
  external_id text not null,
  external_parent_id text,
  title text not null,
  normalized_name text,
  sku text,
  barcode text,
  source_url text not null,
  primary_image_url text,
  payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint catalog_source_records_type_allowed check (entity_type in (
    'brand', 'line', 'product', 'variant', 'tone', 'image', 'relation', 'document'
  )),
  constraint catalog_source_records_external_not_blank check (length(trim(external_id)) > 0),
  constraint catalog_source_records_title_not_blank check (length(trim(title)) > 0),
  constraint catalog_source_records_url_http check (source_url ~ '^https?://'),
  constraint catalog_source_records_image_url_http check (
    primary_image_url is null or primary_image_url ~ '^https?://'
  ),
  constraint catalog_source_records_payload_object check (jsonb_typeof(payload) = 'object'),
  unique (snapshot_id, entity_type, external_id)
);

create index catalog_source_records_lookup_idx
  on public.catalog_source_records(source_id, entity_type, normalized_name);
create index catalog_source_records_sku_idx
  on public.catalog_source_records(source_id, sku) where sku is not null;
create index catalog_source_records_barcode_idx
  on public.catalog_source_records(source_id, barcode) where barcode is not null;

create table public.catalog_reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  shade_id uuid references public.color_shades(id) on delete cascade,
  source_record_id uuid not null references public.catalog_source_records(id) on delete cascade,
  algorithm text not null,
  score numeric(6,5) not null,
  status text not null default 'proposed',
  decision_reason text,
  evidence jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_reconciliation_cases_entity_allowed check (entity_type in ('product', 'variant', 'shade')),
  constraint catalog_reconciliation_cases_one_internal_ref check (
    num_nonnulls(product_id, variant_id, shade_id) = 1
  ),
  constraint catalog_reconciliation_cases_entity_consistent check (
    (entity_type = 'product' and product_id is not null)
    or (entity_type = 'variant' and variant_id is not null)
    or (entity_type = 'shade' and shade_id is not null)
  ),
  constraint catalog_reconciliation_cases_score_range check (score >= 0 and score <= 1),
  constraint catalog_reconciliation_cases_status_allowed check (status in (
    'proposed', 'needs_review', 'approved', 'rejected', 'superseded'
  )),
  constraint catalog_reconciliation_cases_decision_consistent check (
    (status in ('proposed', 'needs_review') and decided_at is null)
    or (status in ('approved', 'rejected', 'superseded') and decided_at is not null)
  ),
  constraint catalog_reconciliation_cases_evidence_object check (jsonb_typeof(evidence) = 'object')
);

create unique index catalog_reconciliation_cases_active_unique_idx
  on public.catalog_reconciliation_cases(
    entity_type,
    coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(shade_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_record_id
  )
  where status in ('proposed', 'needs_review', 'approved');

create index catalog_reconciliation_cases_review_idx
  on public.catalog_reconciliation_cases(status, score desc, created_at);

create table public.catalog_enrichment_exceptions (
  id uuid primary key default gen_random_uuid(),
  exception_key text not null unique,
  brand_id uuid references public.brands(id) on delete set null,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  shade_id uuid references public.color_shades(id) on delete cascade,
  source_id uuid references public.catalog_sources(id) on delete set null,
  exception_type text not null,
  severity text not null default 'medium',
  status text not null default 'open',
  title text not null,
  details jsonb not null default '{}'::jsonb,
  resolution_notes text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_enrichment_exceptions_type_allowed check (exception_type in (
    'identity_ambiguous', 'line_missing', 'tone_missing', 'image_missing', 'image_ambiguous',
    'sku_conflict', 'barcode_conflict', 'product_not_in_current_source', 'physical_capture_required',
    'relation_requires_evidence', 'source_fetch_failed', 'other'
  )),
  constraint catalog_enrichment_exceptions_severity_allowed check (severity in ('low', 'medium', 'high', 'critical')),
  constraint catalog_enrichment_exceptions_status_allowed check (status in ('open', 'in_review', 'resolved', 'waived')),
  constraint catalog_enrichment_exceptions_title_not_blank check (length(trim(title)) > 0),
  constraint catalog_enrichment_exceptions_key_not_blank check (length(trim(exception_key)) > 0),
  constraint catalog_enrichment_exceptions_resolution_consistent check (
    (status in ('open', 'in_review') and resolved_at is null)
    or (status in ('resolved', 'waived') and resolved_at is not null)
  ),
  constraint catalog_enrichment_exceptions_details_object check (jsonb_typeof(details) = 'object')
);

create index catalog_enrichment_exceptions_queue_idx
  on public.catalog_enrichment_exceptions(status, severity, created_at);
create index catalog_enrichment_exceptions_product_idx
  on public.catalog_enrichment_exceptions(product_id) where product_id is not null;
create index catalog_enrichment_exceptions_variant_idx
  on public.catalog_enrichment_exceptions(variant_id) where variant_id is not null;
create index catalog_enrichment_exceptions_shade_idx
  on public.catalog_enrichment_exceptions(shade_id) where shade_id is not null;

create table public.catalog_relation_candidates (
  id uuid primary key default gen_random_uuid(),
  source_product_id uuid not null references public.products(id) on delete cascade,
  target_product_id uuid not null references public.products(id) on delete cascade,
  relation_type public.product_relation_type not null,
  confidence text not null,
  status text not null default 'proposed',
  rule_code text not null,
  rationale text not null,
  evidence jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_relation_candidates_not_self check (source_product_id <> target_product_id),
  constraint catalog_relation_candidates_confidence_allowed check (confidence in (
    'official', 'packaging', 'same_brand_rule', 'category_rule'
  )),
  constraint catalog_relation_candidates_status_allowed check (status in (
    'proposed', 'needs_evidence', 'approved', 'rejected', 'promoted'
  )),
  constraint catalog_relation_candidates_decision_consistent check (
    (status in ('proposed', 'needs_evidence') and decided_at is null)
    or (status in ('approved', 'rejected', 'promoted') and decided_at is not null)
  ),
  constraint catalog_relation_candidates_evidence_object check (jsonb_typeof(evidence) = 'object'),
  unique (source_product_id, target_product_id, relation_type, rule_code)
);

create index catalog_relation_candidates_review_idx
  on public.catalog_relation_candidates(status, confidence, created_at);

-- `security_invoker` no es opcional: sin él la vista se ejecuta con los
-- privilegios de quien la creó y salta la RLS de las tablas que lee. Hay dos
-- baterías pgTAP —0029 y 0032— que comprueban que TODA vista de `public` lo
-- declara, precisamente para que nadie abra ese agujero sin querer.
create or replace view public.catalog_enrichment_coverage
with (security_invoker = true) as
select
  brand.id as brand_id,
  brand.name as brand,
  count(distinct product.id) as products,
  count(distinct variant.id) as variants,
  count(distinct shade.id) as shades,
  count(distinct variant.id) filter (
    where variant.id is not null
      and not exists (
        select 1 from public.product_media media
        where media.variant_id = variant.id
      )
  ) as variants_without_media,
  count(distinct exception.id) filter (where exception.status in ('open', 'in_review')) as open_exceptions,
  count(distinct reconciliation.id) filter (where reconciliation.status in ('proposed', 'needs_review')) as pending_reconciliations,
  max(source.last_success_at) as last_official_refresh
from public.brands brand
left join public.products product on product.brand_id = brand.id
left join public.product_variants variant on variant.product_id = product.id
left join public.color_shades shade on shade.brand_id = brand.id
left join public.catalog_enrichment_exceptions exception on exception.brand_id = brand.id
left join public.catalog_reconciliation_cases reconciliation
  on reconciliation.product_id = product.id
  or reconciliation.variant_id = variant.id
  or reconciliation.shade_id = shade.id
left join public.catalog_sources source on source.brand_id = brand.id and source.is_active
group by brand.id, brand.name;

insert into public.catalog_sources(source_key, name, authority, adapter, base_url, brand_id, refresh_interval)
select source.source_key, source.name, 'official', source.adapter, source.base_url, brand.id, interval '7 days'
from (values
  ('masglo-es-official', 'Masglo España — catálogo oficial', 'shopify_products_json', 'https://masglo.com.es', 'Masglo'),
  ('admiss-co-official', 'Admiss Colombia — catálogo oficial', 'shopify_products_json', 'https://admiss.com.co', 'Admiss'),
  ('acrylove-official', 'AcryLove — catálogo oficial', 'shopify_products_json', 'https://acrylove.com', 'ACRYLOVE'),
  ('mc-nails-mx-official', 'MC Nails México — catálogo oficial', 'shopify_products_json', 'https://mcnails.mx', 'MC NAILS'),
  ('cherimoya-pe-official', 'Cherimoya Perú — catálogo oficial', 'woocommerce_store_api', 'https://cherimoya.pe', 'Cherimoya'),
  ('bigen-usa-official', 'Bigen USA — catálogo oficial', 'shopify_products_json', 'https://www.bigen-usa.com', 'BIGEN')
) as source(source_key, name, adapter, base_url, brand_name)
left join public.brands brand on lower(brand.name) = lower(source.brand_name)
on conflict (source_key) do update set
  name = excluded.name,
  adapter = excluded.adapter,
  base_url = excluded.base_url,
  brand_id = excluded.brand_id,
  refresh_interval = excluded.refresh_interval,
  is_active = true;

create trigger catalog_sources_set_updated_at
before update on public.catalog_sources
for each row execute function public.set_updated_at();

create trigger catalog_reconciliation_cases_set_updated_at
before update on public.catalog_reconciliation_cases
for each row execute function public.set_updated_at();

create trigger catalog_enrichment_exceptions_set_updated_at
before update on public.catalog_enrichment_exceptions
for each row execute function public.set_updated_at();

create trigger catalog_relation_candidates_set_updated_at
before update on public.catalog_relation_candidates
for each row execute function public.set_updated_at();

alter table public.catalog_sources enable row level security;
alter table public.catalog_source_snapshots enable row level security;
alter table public.catalog_source_records enable row level security;
alter table public.catalog_reconciliation_cases enable row level security;
alter table public.catalog_enrichment_exceptions enable row level security;
alter table public.catalog_relation_candidates enable row level security;

create policy "admins manage catalog sources" on public.catalog_sources
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog source snapshots" on public.catalog_source_snapshots
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog source records" on public.catalog_source_records
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog reconciliation cases" on public.catalog_reconciliation_cases
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog enrichment exceptions" on public.catalog_enrichment_exceptions
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog relation candidates" on public.catalog_relation_candidates
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on
  public.catalog_sources,
  public.catalog_source_snapshots,
  public.catalog_source_records,
  public.catalog_reconciliation_cases,
  public.catalog_enrichment_exceptions,
  public.catalog_relation_candidates
to authenticated, service_role;

grant select on public.catalog_enrichment_coverage to authenticated, service_role;
