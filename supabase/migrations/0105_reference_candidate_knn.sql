-- 0105 · Candidatos de identidad acotados por marca e índice KNN

begin;

create index catalog_reference_products_brand_name_knn_idx
  on public.catalog_reference_products
  using gist (brand_id, normalized_name gist_trgm_ops);

create or replace function public.get_catalog_reference_candidates_v1(
  p_brand_id uuid,
  p_source_id uuid,
  p_identifier_kind text default null,
  p_identifier_value text default null,
  p_normalized_name text default null,
  p_limit integer default 20
)
returns table (
  target_ref text,
  reference_key text,
  entity_kind text,
  normalized_name text,
  match_basis text,
  score numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with exact_identifier as (
    select
      identifier.target_ref,
      coalesce(product.reference_key, variant.reference_key) as reference_key,
      case when identifier.reference_product_id is not null then 'product' else 'variant' end as entity_kind,
      coalesce(product.normalized_name, variant.normalized_name) as normalized_name,
      'identifier'::text as match_basis,
      1::numeric as score
    from public.catalog_reference_identifiers identifier
    left join public.catalog_reference_products product on product.id = identifier.reference_product_id
    left join public.catalog_reference_variants variant on variant.id = identifier.reference_variant_id
    left join public.catalog_reference_products variant_product on variant_product.id = variant.reference_product_id
    where p_identifier_kind is not null
      and p_identifier_value is not null
      and identifier.source_id = p_source_id
      and identifier.identifier_kind = p_identifier_kind
      and identifier.normalized_value = p_identifier_value
      and coalesce(product.brand_id, variant_product.brand_id) = p_brand_id
    limit greatest(1, least(p_limit, 100))
  ), exact_name as (
    select
      'reference_product:' || product.id::text as target_ref,
      product.reference_key,
      'product'::text as entity_kind,
      product.normalized_name,
      'exact_normalized_name'::text as match_basis,
      1::numeric as score
    from public.catalog_reference_products product
    where p_normalized_name is not null
      and product.brand_id = p_brand_id
      and product.normalized_name = p_normalized_name
    order by product.reference_key
    limit greatest(1, least(p_limit, 100))
  ), nearest_name as (
    select
      'reference_product:' || product.id::text as target_ref,
      product.reference_key,
      'product'::text as entity_kind,
      product.normalized_name,
      'bounded_name_similarity'::text as match_basis,
      (1 - (product.normalized_name operator(public.<->) p_normalized_name))::numeric as score
    from public.catalog_reference_products product
    where p_normalized_name is not null
      and product.brand_id = p_brand_id
    order by product.normalized_name operator(public.<->) p_normalized_name, product.reference_key
    limit greatest(1, least(p_limit, 100))
  )
  select * from exact_identifier
  union all
  select name.* from exact_name name
  where not exists (select 1 from exact_identifier)
  union all
  select name.* from nearest_name name
  where not exists (select 1 from exact_identifier)
    and not exists (select 1 from exact_name)
  order by score desc, reference_key
  limit greatest(1, least(p_limit, 100));
$function$;

revoke execute on function public.get_catalog_reference_candidates_v1(uuid, uuid, text, text, text, integer)
from public, anon;
grant execute on function public.get_catalog_reference_candidates_v1(uuid, uuid, text, text, text, integer)
to authenticated, service_role;

comment on index public.catalog_reference_products_brand_name_knn_idx is
  'KNN acotado por marca para la última etapa de matching; identificadores y nombre exacto se resuelven antes.';

commit;
