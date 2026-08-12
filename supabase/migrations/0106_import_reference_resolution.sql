-- 0106 · El staging existente resuelve también contra el Universo de Referencia

begin;

alter table public.import_rows
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete restrict,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete restrict,
  add column reference_match_status text,
  add column reference_resolution jsonb,
  add column reference_resolved_at timestamptz,
  add constraint import_rows_reference_target_consistent check (
    num_nonnulls(reference_product_id, reference_variant_id) <= 1
  ),
  add constraint import_rows_reference_match_allowed check (
    reference_match_status is null or reference_match_status in (
      'exact', 'probable', 'unmatched', 'brand_unknown'
    )
  ),
  add constraint import_rows_reference_resolution_object check (
    reference_resolution is null or jsonb_typeof(reference_resolution) = 'object'
  );

create index import_rows_reference_product_idx
  on public.import_rows(reference_product_id, batch_id)
  where reference_product_id is not null;
create index import_rows_reference_variant_idx
  on public.import_rows(reference_variant_id, batch_id)
  where reference_variant_id is not null;
create index import_rows_reference_status_idx
  on public.import_rows(batch_id, reference_match_status, row_number)
  where reference_match_status is not null;

create or replace function public.resolve_catalog_import_reference_v1(
  p_import_row_id uuid,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  staging public.import_rows%rowtype;
  resolved_brand_id uuid;
  v_normalized_name text;
  v_internal_code text;
  v_supplier_code text;
  candidates jsonb := '[]'::jsonb;
  candidate_count integer := 0;
  exact_count integer := 0;
  best_target_ref text;
  next_status text;
begin
  p_limit := greatest(1, least(coalesce(p_limit, 10), 100));

  select * into staging from public.import_rows where id = p_import_row_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Fila de staging inexistente.';
  end if;

  select brand.id into resolved_brand_id
  from public.brands brand
  where brand.slug = lower(staging.normalized_data#>>'{identity,brandSlug}')
     or public.search_normalize(brand.name) = public.search_normalize(staging.normalized_data#>>'{identity,brandName}')
  order by (brand.slug = lower(staging.normalized_data#>>'{identity,brandSlug}')) desc, brand.id
  limit 1;

  v_normalized_name := public.search_normalize(staging.normalized_data#>>'{naming,normalizedName}');
  v_internal_code := lower(nullif(btrim(staging.normalized_data#>>'{identity,internalCode}'), ''));
  v_supplier_code := lower(nullif(btrim(staging.normalized_data#>>'{identity,supplierCode}'), ''));

  if resolved_brand_id is null then
    next_status := 'brand_unknown';
  else
    with exact_identifier as (
      select distinct
        identifier.target_ref,
        coalesce(product.reference_key, variant.reference_key) as reference_key,
        case when identifier.reference_product_id is not null then 'product' else 'variant' end as entity_kind,
        coalesce(product.normalized_name, variant.normalized_name) as candidate_name,
        'identifier'::text as match_basis,
        1::numeric as score
      from public.catalog_reference_identifiers identifier
      left join public.catalog_reference_products product on product.id = identifier.reference_product_id
      left join public.catalog_reference_variants variant on variant.id = identifier.reference_variant_id
      left join public.catalog_reference_products variant_product on variant_product.id = variant.reference_product_id
      where coalesce(product.brand_id, variant_product.brand_id) = resolved_brand_id
        and identifier.normalized_value in (v_internal_code, v_supplier_code)
        and (v_internal_code is not null or v_supplier_code is not null)
    ), exact_name as (
      select
        'reference_product:' || product.id::text as target_ref,
        product.reference_key,
        'product'::text as entity_kind,
        product.normalized_name as candidate_name,
        'exact_normalized_name'::text as match_basis,
        1::numeric as score
      from public.catalog_reference_products product
      where v_normalized_name is not null
        and product.brand_id = resolved_brand_id
        and product.normalized_name = v_normalized_name
    ), nearest_name as (
      select
        'reference_product:' || product.id::text as target_ref,
        product.reference_key,
        'product'::text as entity_kind,
        product.normalized_name as candidate_name,
        'bounded_name_similarity'::text as match_basis,
        (1 - (product.normalized_name operator(public.<->) v_normalized_name))::numeric as score
      from public.catalog_reference_products product
      where v_normalized_name is not null and product.brand_id = resolved_brand_id
      order by product.normalized_name operator(public.<->) v_normalized_name, product.reference_key
      limit p_limit
    ), selected as (
      select * from exact_identifier
      union all
      select * from exact_name where not exists (select 1 from exact_identifier)
      union all
      select * from nearest_name
      where not exists (select 1 from exact_identifier) and not exists (select 1 from exact_name)
      order by score desc, reference_key
      limit p_limit
    )
    select
      coalesce(jsonb_agg(to_jsonb(selected) order by score desc, reference_key), '[]'::jsonb),
      count(*),
      count(*) filter (where match_basis in ('identifier', 'exact_normalized_name')),
      min(target_ref) filter (where match_basis in ('identifier', 'exact_normalized_name'))
    into candidates, candidate_count, exact_count, best_target_ref
    from selected;

    next_status := case
      when exact_count = 1 then 'exact'
      when candidate_count > 0 then 'probable'
      else 'unmatched'
    end;
  end if;

  update public.import_rows
  set reference_product_id = case
        when next_status = 'exact' and best_target_ref like 'reference_product:%'
          then split_part(best_target_ref, ':', 2)::uuid
        else null
      end,
      reference_variant_id = case
        when next_status = 'exact' and best_target_ref like 'reference_variant:%'
          then split_part(best_target_ref, ':', 2)::uuid
        else null
      end,
      reference_match_status = next_status,
      reference_resolution = jsonb_build_object(
        'version', 1,
        'brandId', resolved_brand_id,
        'normalizedName', v_normalized_name,
        'candidates', candidates,
        'resolvedWithoutCommercialCreation', true
      ),
      reference_resolved_at = statement_timestamp()
  where id = staging.id;

  return jsonb_build_object(
    'importRowId', staging.id,
    'status', next_status,
    'referenceTarget', case when next_status = 'exact' then best_target_ref else null end,
    'candidates', candidates
  );
end;
$function$;

create or replace function public.get_catalog_import_reference_metrics_v1(p_batch_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'matchInternal', count(*) filter (where row.target_product_id is not null or row.target_variant_id is not null),
    'matchReference', count(*) filter (where row.reference_match_status = 'exact'),
    'newReference', count(*) filter (where row.reference_match_status = 'unmatched'),
    'needsResearch', count(*) filter (where row.reference_match_status in ('probable', 'unmatched', 'brand_unknown')),
    'needsPhysicalCapture', count(*) filter (where exists (
      select 1 from public.import_issues issue
      where issue.import_row_id = row.id and issue.status = 'open'
        and issue.issue_code in ('needs_physical_capture', 'physical_capture_required')
    ))
  )
  from public.import_rows row
  where row.batch_id = p_batch_id;
$function$;

revoke execute on function public.resolve_catalog_import_reference_v1(uuid, integer)
from public, anon;
grant execute on function public.resolve_catalog_import_reference_v1(uuid, integer)
to authenticated, service_role;
revoke execute on function public.get_catalog_import_reference_metrics_v1(uuid)
from public, anon;
grant execute on function public.get_catalog_import_reference_metrics_v1(uuid)
to authenticated, service_role;

comment on function public.resolve_catalog_import_reference_v1(uuid, integer) is
  'Resuelve una fila del staging existente contra referencias indexadas. Nunca crea products, variantes, precios ni inventario.';

commit;
