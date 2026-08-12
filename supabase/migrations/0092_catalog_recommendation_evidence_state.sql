-- ---------------------------------------------------------------------------
-- 0092 · Una recomendación de rol no equivale a compatibilidad
-- ---------------------------------------------------------------------------
-- El motor puede sugerir candidatos aunque no tengan precio, pero debe separar
-- con claridad “cubre este rol” de “está confirmado con lo que seleccionaste”.

begin;

drop function public.get_catalog_system_recommendations_v1(text, uuid[]);

create function public.get_catalog_system_recommendations_v1(
  p_system_code text,
  p_product_ids uuid[] default '{}'::uuid[]
)
returns table (
  stage_code text,
  stage_name text,
  role_code text,
  role_name text,
  necessity text,
  product_id uuid,
  product_code text,
  product_name text,
  brand_name text,
  same_brand boolean,
  compatibility_state text,
  verification_required boolean,
  price_state text,
  displayed_price numeric,
  availability text,
  recommendation_reason text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with selected_products as (
    select product.id, product.brand_id
    from public.products product
    where product.id = any(coalesce(p_product_ids, '{}'::uuid[]))
  ), selected_brands as (
    select distinct brand_id from selected_products
  ), selected_roles as (
    select distinct assignment.product_id, role.code as role_code
    from public.product_system_roles assignment
    join public.catalog_systems system on system.id = assignment.system_id
    join public.catalog_roles role on role.id = assignment.role_id
    where system.code = upper(trim(p_system_code))
      and assignment.product_id = any(coalesce(p_product_ids, '{}'::uuid[]))
      and assignment.decision_status = 'approved'
  ), coverage as (
    select *
    from public.get_catalog_system_coverage_v1(p_system_code, p_product_ids)
    where not is_satisfied and minimum_selections > 0
  ), candidates as (
    select
      coverage.stage_code,
      coverage.stage_name,
      coverage.role_code,
      coverage.role_name,
      coverage.necessity,
      product.id as product_id,
      product.code as product_code,
      product.name as product_name,
      brand.name as brand_name,
      exists (
        select 1 from selected_brands selected where selected.brand_id = product.brand_id
      ) as same_brand,
      exists (
        select 1
        from selected_roles selected_role
        where (coverage.role_code = 'LIQUID_COMPONENT' and selected_role.role_code = 'POLYMER_COMPONENT')
           or (coverage.role_code = 'POLYMER_COMPONENT' and selected_role.role_code = 'LIQUID_COMPONENT')
      ) as has_complementary_component,
      exists (
        select 1
        from public.product_relations relation
        join selected_products selected
          on (
            relation.source_product_id = selected.id and relation.target_product_id = product.id
          ) or (
            relation.target_product_id = selected.id and relation.source_product_id = product.id
          )
        where relation.knowledge_status = 'approved'
          and relation.is_active
          and relation.compatibility_status in ('confirmed', 'conditional')
          and relation.relation_type in ('requires', 'compatible_with', 'recommended_with')
      ) as has_approved_pair_evidence,
      case
        when coalesce(nullif(projection.starting_price, 0), nullif(product.unit_price, 0)) is null then 'consult'
        else 'priced'
      end as price_state,
      coalesce(nullif(projection.starting_price, 0), nullif(product.unit_price, 0)) as displayed_price,
      product.availability::text as availability,
      product.sort_order
    from coverage
    join public.catalog_systems system on system.code = upper(trim(p_system_code))
    join public.catalog_stages stage
      on stage.system_id = system.id and stage.code = coverage.stage_code
    join public.catalog_roles role on role.code = coverage.role_code
    join public.product_system_roles assignment
      on assignment.system_id = system.id
     and assignment.stage_id = stage.id
     and assignment.role_id = role.id
     and assignment.decision_status = 'approved'
    join public.products product
      on product.id = assignment.product_id
     and product.is_active
     and not (product.id = any(coalesce(p_product_ids, '{}'::uuid[])))
    left join public.product_catalog_projection projection on projection.product_id = product.id
    join public.brands brand on brand.id = product.brand_id and brand.is_active
  )
  select
    candidate.stage_code,
    candidate.stage_name,
    candidate.role_code,
    candidate.role_name,
    candidate.necessity,
    candidate.product_id,
    candidate.product_code,
    candidate.product_name,
    candidate.brand_name,
    candidate.same_brand,
    case
      when candidate.has_complementary_component and candidate.has_approved_pair_evidence then 'confirmed_pair'
      when candidate.has_complementary_component then 'unknown_pair'
      else 'role_supported'
    end as compatibility_state,
    candidate.has_complementary_component and not candidate.has_approved_pair_evidence as verification_required,
    candidate.price_state,
    candidate.displayed_price,
    candidate.availability,
    case
      when candidate.has_complementary_component and not candidate.has_approved_pair_evidence then
        'Cubre el rol ' || candidate.role_name ||
        ', pero la compatibilidad con el componente seleccionado sigue pendiente de evidencia.'
      when candidate.necessity = 'required' then
        'Falta para completar el rol ' || candidate.role_name || ' del sistema.'
      else
        'Recomendado para cubrir el rol ' || candidate.role_name || ' del sistema.'
    end as recommendation_reason
  from candidates candidate
  order by
    case candidate.necessity when 'required' then 0 else 1 end,
    candidate.stage_code,
    candidate.has_approved_pair_evidence desc,
    candidate.same_brand desc,
    candidate.sort_order,
    candidate.product_name;
$function$;

grant execute on function public.get_catalog_system_recommendations_v1(text, uuid[])
to anon, authenticated, service_role;

comment on function public.get_catalog_system_recommendations_v1(text, uuid[]) is
  'Devuelve candidatos por rol faltante. same_brand solo ordena; no prueba compatibilidad. Pares sin relación específica aprobada quedan unknown_pair y verification_required=true.';

commit;
