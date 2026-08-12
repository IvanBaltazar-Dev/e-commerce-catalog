-- ---------------------------------------------------------------------------
-- 0098 · Proyección de dependencias reales de la Mesa de revisión
-- ---------------------------------------------------------------------------
-- El motor 0097 conoce requires_all/requires_any/invalidated_by. Esta migración
-- conecta esa semántica al catálogo actual: la identidad de producto es una
-- compuerta para variante, tono, imagen, clasificación y relación.

begin;

alter table public.catalog_review_dependencies
  add column origin text not null default 'manual';

alter table public.catalog_review_dependencies
  add constraint catalog_review_dependency_origin_allowed check (
    origin in ('manual', 'projection')
  );

create index catalog_review_dependencies_origin_idx
  on public.catalog_review_dependencies(origin, dependent_work_item_id);

create or replace function public.refresh_catalog_review_dependencies_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  projected_count integer := 0;
  changed_priorities integer := 0;
begin
  delete from public.catalog_review_dependencies
  where origin = 'projection';

  with dependent_products as (
    -- Producto directo.
    select item.id as dependent_id, item.subject_id as product_id
    from public.catalog_review_work_items item
    where item.subject_type = 'product'
      and item.subject_id is not null
      and item.status in ('open', 'in_progress')
      and not (item.purpose = 'identity' and item.source_type = 'reconciliation_case')

    union

    -- Una variante hereda la identidad de su producto padre.
    select item.id, variant.product_id
    from public.catalog_review_work_items item
    join public.product_variants variant on variant.id = item.subject_id
    where item.subject_type = 'variant'
      and item.status in ('open', 'in_progress')

    union

    -- Un tono puede aparecer en varias variantes, pero la unión elimina pares
    -- repetidos por producto.
    select item.id, variant.product_id
    from public.catalog_review_work_items item
    join public.product_variants variant on variant.color_shade_id = item.subject_id
    where item.subject_type = 'shade'
      and item.status in ('open', 'in_progress')

    union

    -- Una candidata técnica exige conocer ambos extremos.
    select item.id, candidate.source_product_id
    from public.catalog_review_work_items item
    join public.catalog_relation_candidates candidate
      on item.source_type = 'relation_candidate' and item.source_id = candidate.id
    where item.status in ('open', 'in_progress')

    union

    select item.id, candidate.target_product_id
    from public.catalog_review_work_items item
    join public.catalog_relation_candidates candidate
      on item.source_type = 'relation_candidate' and item.source_id = candidate.id
    where item.status in ('open', 'in_progress')
  ), identity_prerequisites as (
    select
      item.id as prerequisite_id,
      item.subject_id as product_id
    from public.catalog_review_work_items item
    where item.source_type = 'reconciliation_case'
      and item.purpose = 'identity'
      and item.subject_type = 'product'
  )
  insert into public.catalog_review_dependencies(
    dependent_work_item_id, prerequisite_work_item_id,
    dependency_type, group_key, condition, origin
  )
  select
    dependent.dependent_id,
    prerequisite.prerequisite_id,
    'requires_any',
    'product-identity:' || dependent.product_id::text,
    '{"resolution_codes":["approve","approved"]}'::jsonb,
    'projection'
  from dependent_products dependent
  join identity_prerequisites prerequisite
    on prerequisite.product_id = dependent.product_id
  where dependent.dependent_id <> prerequisite.prerequisite_id
  on conflict (dependent_work_item_id, prerequisite_work_item_id, dependency_type, group_key)
  do nothing;

  get diagnostics projected_count = row_count;

  -- El impacto visible de una identidad es la cantidad real de trabajos que
  -- puede habilitar. Solo se actualiza cuando cambia para no invalidar
  -- expected_version en reejecuciones idénticas.
  with impact as (
    select
      prerequisite.id,
      count(distinct dependency.dependent_work_item_id)::integer as unlock_count
    from public.catalog_review_work_items prerequisite
    left join public.catalog_review_dependencies dependency
      on dependency.prerequisite_work_item_id = prerequisite.id
     and dependency.origin = 'projection'
    where prerequisite.source_type = 'reconciliation_case'
      and prerequisite.purpose = 'identity'
      and prerequisite.subject_type = 'product'
    group by prerequisite.id
  )
  update public.catalog_review_work_items item
  set unlock_count = impact.unlock_count
  from impact
  where item.id = impact.id
    and item.unlock_count is distinct from impact.unlock_count;

  get diagnostics changed_priorities = row_count;

  return jsonb_build_object(
    'projectedDependencies', projected_count,
    'identityImpactsUpdated', changed_priorities,
    'blockedWorkItems', (
      select count(*)
      from public.catalog_review_queue_v1
      where queue_state = 'blocked'
    )
  );
end;
$function$;

revoke all on function public.refresh_catalog_review_dependencies_v1()
from public, anon, authenticated;
grant execute on function public.refresh_catalog_review_dependencies_v1()
to service_role;

comment on function public.refresh_catalog_review_dependencies_v1() is
  'Proyecta dependencias de identidad sin convertir la cola en fuente de verdad; reejecutar conserva decisiones y versiones sin cambios inútiles.';

select public.refresh_catalog_review_dependencies_v1();

commit;
