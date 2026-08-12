-- 0107 · Etapa 2: campaña por marca/fuente, reconciliación tipada y lectura MCP.
-- PostgreSQL continúa siendo la única autoridad. Estas estructuras no escriben
-- catálogo comercial, inventario, precios internos ni medios publicados.

begin;

alter table public.catalog_reconciliation_cases
  add column case_key text;

alter table public.catalog_reconciliation_cases
  add constraint catalog_reconciliation_cases_key_not_blank check (
    case_key is null or length(trim(case_key)) > 0
  ),
  add constraint catalog_reconciliation_cases_key_unique unique (case_key);

create index catalog_reconciliation_cases_run_status_idx
  on public.catalog_reconciliation_cases(research_run_id, status, score desc)
  where research_run_id is not null;

create or replace function public.stage_catalog_brand_reconciliation_v1(
  p_research_run_id uuid,
  p_brand_id uuid,
  p_source_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  inserted_or_updated bigint := 0;
  contradiction_count bigint := 0;
  candidate_count bigint := 0;
begin
  if not exists (
    select 1
    from public.catalog_research_run_brands run_brand
    where run_brand.research_run_id = p_research_run_id
      and run_brand.brand_id = p_brand_id
  ) then
    raise exception using errcode = '23514', message = 'La marca no pertenece a la corrida indicada.';
  end if;

  if not exists (
    select 1 from public.catalog_sources source
    where source.id = p_source_id and source.brand_id = p_brand_id
  ) then
    raise exception using errcode = '23514', message = 'La fuente no pertenece a la marca indicada.';
  end if;

  update public.catalog_reconciliation_cases reconciliation
  set status = 'superseded',
      decision_reason = 'La corrida oficial más reciente volvió a calcular las señales activas.',
      decided_at = statement_timestamp(),
      updated_at = now()
  where reconciliation.algorithm = 'official_identity_v1'
    and reconciliation.status in ('proposed', 'needs_review')
    and (
      reconciliation.reference_product_id in (
        select reference.id from public.catalog_reference_products reference
        where reference.brand_id = p_brand_id and reference.primary_source_id = p_source_id
      )
      or reconciliation.reference_variant_id in (
        select variant.id
        from public.catalog_reference_variants variant
        join public.catalog_reference_products reference on reference.id = variant.reference_product_id
        where reference.brand_id = p_brand_id and reference.primary_source_id = p_source_id
      )
    );

  with external_items as (
    select
      product.id as reference_product_id,
      variant.id as reference_variant_id,
      coalesce(variant.primary_source_record_id, product.primary_source_record_id) as source_record_id,
      product.normalized_name as official_name,
      coalesce(public.search_normalize(variant.shade_name), '') as official_identity_name,
      public.search_normalize(coalesce(product.product_type, '')) as official_type,
      product.presentation as official_presentation,
      variant.sku as official_sku
    from public.catalog_reference_products product
    join public.catalog_reference_variants variant
      on variant.reference_product_id = product.id
    where product.brand_id = p_brand_id
      and product.primary_source_id = p_source_id
      and product.presence_status = 'present'
      and variant.presence_status = 'present'
  ), internal_variants as (
    select
      variant.id as variant_id,
      variant.product_id,
      public.search_normalize(variant.name) as variant_name,
      public.search_normalize(product.name) as product_name,
      public.search_normalize(product.presentation) as presentation,
      public.search_normalize(category.name) as category_name
    from public.product_variants variant
    join public.products product on product.id = variant.product_id
    join public.categories category on category.id = product.category_id
    where product.brand_id = p_brand_id and product.is_active and variant.is_active
  ), exact_variant_candidates as (
    select distinct on (external.reference_variant_id)
      external.reference_product_id,
      external.reference_variant_id,
      external.source_record_id,
      internal.variant_id,
      internal.product_id,
      internal.variant_name,
      external.official_type,
      internal.category_name,
      external.official_presentation,
      internal.presentation,
      case
        when external.official_type <> ''
         and internal.category_name <> ''
         and rtrim(external.official_type, 's') <> rtrim(internal.category_name, 's')
         and (' ' || internal.category_name || ' ') not like ('% ' || rtrim(external.official_type, 's') || '%')
         and (' ' || internal.product_name || ' ') not like ('% ' || rtrim(external.official_type, 's') || '%')
        then true else false
      end as classification_contradiction
    from external_items external
    join internal_variants internal
      on (
        (external.official_identity_name <> '' and external.official_identity_name = internal.variant_name)
        or (
          external.official_identity_name = ''
          and length(internal.variant_name) >= 8
          and (' ' || external.official_name || ' ') like ('% ' || internal.variant_name || ' %')
        )
      )
    order by external.reference_variant_id, length(internal.variant_name) desc, internal.variant_id
  ), internal_products as (
    select
      product.id as product_id,
      public.search_normalize(product.name) as product_name,
      public.search_normalize(product.product_type) as product_type,
      public.search_normalize(product.presentation) as presentation,
      public.search_normalize(category.name) as category_name
    from public.products product
    join public.categories category on category.id = product.category_id
    where product.brand_id = p_brand_id and product.is_active
  ), direct_product_candidates as (
    select distinct on (external.reference_product_id)
      external.reference_product_id,
      external.source_record_id,
      internal.product_id,
      false as classification_contradiction,
      0.93000::numeric as score,
      'name_exact_phrase'::text as match_basis
    from external_items external
    join internal_products internal
      on length(internal.product_name) >= 5
     and (' ' || external.official_name || ' ') like ('% ' || internal.product_name || ' %')
    where not exists (
      select 1 from exact_variant_candidates candidate
      where candidate.reference_product_id = external.reference_product_id
    )
    order by external.reference_product_id, length(internal.product_name) desc, internal.product_id
  ), family_product_candidates as (
    select distinct on (external.reference_product_id)
      external.reference_product_id,
      external.source_record_id,
      internal.product_id,
      false as classification_contradiction,
      (
        0.70000
        + case when public.search_normalize(coalesce(external.official_presentation, '')) = internal.presentation then 0.08000 else 0 end
      )::numeric as score,
      'classification_and_presentation'::text as match_basis
    from external_items external
    join internal_products internal
      on external.official_type <> ''
     and rtrim(external.official_type, 's') = rtrim(internal.category_name, 's')
     and (' ' || external.official_name || ' ') like ('% ' || rtrim(external.official_type, 's') || '%')
    where not exists (
      select 1 from exact_variant_candidates candidate
      where candidate.reference_product_id = external.reference_product_id
    )
      and not exists (
        select 1 from direct_product_candidates candidate
        where candidate.reference_product_id = external.reference_product_id
      )
    order by external.reference_product_id,
      (public.search_normalize(coalesce(external.official_presentation, '')) = internal.presentation) desc,
      internal.product_id
  ), candidates as (
    select
      'variant'::text as entity_type,
      exact.product_id,
      exact.variant_id,
      exact.source_record_id,
      exact.reference_product_id,
      exact.reference_variant_id,
      0.97000::numeric as score,
      exact.classification_contradiction,
      'name_exact_phrase'::text as match_basis,
      exact.official_type,
      exact.category_name,
      exact.official_presentation,
      exact.presentation as internal_presentation
    from exact_variant_candidates exact
    union all
    select
      'product', direct.product_id, null::uuid, direct.source_record_id,
      direct.reference_product_id, null::uuid, direct.score,
      direct.classification_contradiction, direct.match_basis,
      null::text, null::text, null::text, null::text
    from direct_product_candidates direct
    union all
    select
      'product', family.product_id, null::uuid, family.source_record_id,
      family.reference_product_id, null::uuid, family.score,
      family.classification_contradiction, family.match_basis,
      null::text, null::text, null::text, null::text
    from family_product_candidates family
  ), written as (
    insert into public.catalog_reconciliation_cases as current_case(
      case_key, entity_type, product_id, variant_id, source_record_id,
      algorithm, score, status, evidence, research_run_id,
      reference_product_id, reference_variant_id
    )
    select
      'official-identity-v1:' || candidate.entity_type || ':'
        || coalesce(candidate.reference_variant_id, candidate.reference_product_id)::text
        || ':' || coalesce(candidate.variant_id, candidate.product_id)::text,
      candidate.entity_type,
      case when candidate.entity_type = 'product' then candidate.product_id else null end,
      case when candidate.entity_type = 'variant' then candidate.variant_id else null end,
      candidate.source_record_id,
      'official_identity_v1',
      candidate.score,
      case when candidate.classification_contradiction then 'needs_review' else 'proposed' end,
      jsonb_strip_nulls(jsonb_build_object(
        'matchBasis', candidate.match_basis,
        'classificationContradiction', candidate.classification_contradiction,
        'officialProductType', candidate.official_type,
        'internalCategory', candidate.category_name,
        'officialPresentation', candidate.official_presentation,
        'internalPresentation', candidate.internal_presentation,
        'publicationEffect', 'none'
      )),
      p_research_run_id,
      case when candidate.entity_type = 'product' then candidate.reference_product_id else null end,
      case when candidate.entity_type = 'variant' then candidate.reference_variant_id else null end
    from candidates candidate
    on conflict (case_key) do update set
      source_record_id = excluded.source_record_id,
      score = excluded.score,
      evidence = excluded.evidence,
      research_run_id = excluded.research_run_id,
      status = case
        when current_case.status in ('approved', 'rejected') then current_case.status
        else excluded.status
      end,
      decision_reason = case when current_case.status in ('approved', 'rejected') then current_case.decision_reason else null end,
      decided_at = case when current_case.status in ('approved', 'rejected') then current_case.decided_at else null end,
      updated_at = now()
    returning evidence
  )
  select
    count(*),
    count(*) filter (where coalesce((evidence->>'classificationContradiction')::boolean, false)),
    count(*) filter (where not coalesce((evidence->>'classificationContradiction')::boolean, false))
  into inserted_or_updated, contradiction_count, candidate_count
  from written;

  update public.catalog_reference_products reference
  set knowledge_status = case
        when exists (
          select 1
          from public.catalog_reference_variants variant
          join public.catalog_reconciliation_cases reconciliation
            on reconciliation.reference_variant_id = variant.id
          where variant.reference_product_id = reference.id
            and reconciliation.status = 'needs_review'
            and coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        ) then 'identity_conflict'
        when exists (
          select 1 from public.catalog_reconciliation_cases reconciliation
          where reconciliation.reference_product_id = reference.id
            and reconciliation.status in ('proposed', 'needs_review', 'approved')
        ) or exists (
          select 1
          from public.catalog_reference_variants variant
          join public.catalog_reconciliation_cases reconciliation
            on reconciliation.reference_variant_id = variant.id
          where variant.reference_product_id = reference.id
            and reconciliation.status in ('proposed', 'needs_review', 'approved')
        ) then 'observed'
        else 'candidate_new'
      end,
      enrichment_level = case
        when exists (
          select 1
          from public.catalog_reference_variants variant
          join public.catalog_reconciliation_cases reconciliation
            on reconciliation.reference_variant_id = variant.id
          where variant.reference_product_id = reference.id
            and reconciliation.score >= 0.9
        ) then 'REFERENCE_ENRICHED'
        else reference.enrichment_level
      end,
      updated_at = now()
  where reference.brand_id = p_brand_id
    and reference.primary_source_id = p_source_id;

  update public.catalog_reference_variants variant
  set knowledge_status = case
        when exists (
          select 1 from public.catalog_reconciliation_cases reconciliation
          where reconciliation.reference_variant_id = variant.id
            and reconciliation.status = 'needs_review'
            and coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        ) then 'identity_conflict'
        when exists (
          select 1 from public.catalog_reconciliation_cases reconciliation
          where reconciliation.reference_variant_id = variant.id
            and reconciliation.status in ('proposed', 'needs_review', 'approved')
        ) then 'observed'
        else 'candidate_new'
      end,
      enrichment_level = case
        when exists (
          select 1 from public.catalog_reconciliation_cases reconciliation
          where reconciliation.reference_variant_id = variant.id
            and reconciliation.score >= 0.9
        ) then 'REFERENCE_ENRICHED'
        else variant.enrichment_level
      end,
      updated_at = now()
  from public.catalog_reference_products product
  where product.id = variant.reference_product_id
    and product.brand_id = p_brand_id
    and product.primary_source_id = p_source_id;

  update public.catalog_review_work_items item
  set status = 'superseded',
      resolution_code = 'source_signal_superseded',
      resolution_payload = jsonb_build_object('reason', 'La señal dejó de estar activa en la fuente oficial.'),
      resolved_at = statement_timestamp(),
      updated_at = now()
  from public.catalog_reconciliation_cases reconciliation
  where item.source_type = 'reconciliation_case'
    and item.source_id = reconciliation.id
    and item.status in ('open', 'in_progress')
    and reconciliation.algorithm = 'official_identity_v1'
    and reconciliation.status = 'superseded';

  update public.catalog_review_work_items item
  set purpose = case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
          then 'classification' else 'identity'
      end,
      status = case when item.status = 'superseded' then 'open' else item.status end,
      priority_tier = case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
          then 'high' else 'normal'
      end,
      risk_level = case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
          then 'high' else 'normal'
      end,
      has_contradiction = coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false),
      business_relevance = reconciliation.score * 100,
      question = case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
          then '¿La identidad propuesta sigue siendo válida pese a la contradicción de clasificación oficial?'
        else '¿La referencia oficial y el artículo interno representan la misma identidad comercial?'
      end,
      recommendation = case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
          then 'Revisar clasificación, nombre, código y evidencia antes de decidir.'
        else 'Confirmar con nombre, código, presentación e imagen; no publicar automáticamente.'
      end,
      material_fingerprint = md5(coalesce(reconciliation.case_key, reconciliation.id::text) || '|' || reconciliation.score::text || '|' || reconciliation.evidence::text),
      context = jsonb_build_object(
        'caseKey', reconciliation.case_key,
        'score', reconciliation.score,
        'evidence', reconciliation.evidence,
        'researchRunId', reconciliation.research_run_id,
        'publicationEffect', 'none'
      ),
      resolution_code = case when item.status = 'superseded' then null else item.resolution_code end,
      resolution_payload = case when item.status = 'superseded' then null else item.resolution_payload end,
      resolved_at = case when item.status = 'superseded' then null else item.resolved_at end,
      updated_at = now()
  from public.catalog_reconciliation_cases reconciliation
  where item.source_type = 'reconciliation_case'
    and item.source_id = reconciliation.id
    and item.status in ('open', 'in_progress', 'superseded')
    and reconciliation.algorithm = 'official_identity_v1'
    and reconciliation.status in ('proposed', 'needs_review');

  insert into public.catalog_review_work_items(
    work_family_key, problem_version, source_type, source_id, work_kind,
    purpose, subject_type, subject_id, group_key, status, priority_tier,
    risk_level, has_contradiction, unlock_count, business_relevance,
    estimated_effort, question, recommendation, material_fingerprint, context
  )
  select
    'reconciliation:' || reconciliation.id::text,
    1,
    'reconciliation_case',
    reconciliation.id,
    'decision',
    case
      when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'classification' else 'identity'
    end,
    'source_record',
    reconciliation.source_record_id,
    'brand:' || p_brand_id::text,
    'open',
    case
      when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'high' else 'normal'
    end,
    case
      when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'high' else 'normal'
    end,
    coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false),
    1,
    reconciliation.score * 100,
    2,
    case
      when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then '¿La identidad propuesta sigue siendo válida pese a la contradicción de clasificación oficial?'
      else '¿La referencia oficial y el artículo interno representan la misma identidad comercial?'
    end,
    case
      when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'Revisar clasificación, nombre, código y evidencia antes de decidir.'
      else 'Confirmar con nombre, código, presentación e imagen; no publicar automáticamente.'
    end,
    md5(coalesce(reconciliation.case_key, reconciliation.id::text) || '|' || reconciliation.score::text || '|' || reconciliation.evidence::text),
    jsonb_build_object(
      'caseKey', reconciliation.case_key,
      'score', reconciliation.score,
      'evidence', reconciliation.evidence,
      'researchRunId', reconciliation.research_run_id,
      'publicationEffect', 'none'
    )
  from public.catalog_reconciliation_cases reconciliation
  where reconciliation.algorithm = 'official_identity_v1'
    and reconciliation.status in ('proposed', 'needs_review')
    and (
      reconciliation.reference_product_id in (
        select reference.id from public.catalog_reference_products reference
        where reference.brand_id = p_brand_id and reference.primary_source_id = p_source_id
      )
      or reconciliation.reference_variant_id in (
        select variant.id
        from public.catalog_reference_variants variant
        join public.catalog_reference_products reference on reference.id = variant.reference_product_id
        where reference.brand_id = p_brand_id and reference.primary_source_id = p_source_id
      )
    )
    and not exists (
      select 1 from public.catalog_review_work_items item
      where item.source_type = 'reconciliation_case' and item.source_id = reconciliation.id
    );

  return jsonb_build_object(
    'casesWritten', inserted_or_updated,
    'candidates', candidate_count,
    'contradictions', contradiction_count,
    'publicationEffects', 0
  );
end;
$function$;

create or replace function public.get_catalog_brand_intelligence_report_v1(p_brand_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with brand as (
    select id, name, slug from public.brands where id = p_brand_id
  ), internal_products as (
    select product.* from public.products product where product.brand_id = p_brand_id
  ), internal_variants as (
    select variant.*
    from public.product_variants variant
    join internal_products product on product.id = variant.product_id
  ), sources as (
    select source.* from public.catalog_sources source
    where source.brand_id = p_brand_id and source.is_active
  ), latest_run as (
    select run.*
    from public.catalog_research_runs run
    join public.catalog_research_run_brands link on link.research_run_id = run.id
    where link.brand_id = p_brand_id and run.status in ('succeeded', 'partial')
    order by run.finished_at desc nulls last, run.started_at desc
    limit 1
  ), reference_products as (
    select reference.* from public.catalog_reference_products reference
    where reference.brand_id = p_brand_id and reference.presence_status = 'present'
  ), variants as (
    select variant.*
    from public.catalog_reference_variants variant
    join reference_products product on product.id = variant.reference_product_id
    where variant.presence_status = 'present'
  ), active_cases as (
    select reconciliation.*
    from public.catalog_reconciliation_cases reconciliation
    where reconciliation.status in ('proposed', 'needs_review', 'approved')
      and (
        reconciliation.reference_product_id in (select id from reference_products)
        or reconciliation.reference_variant_id in (select id from variants)
      )
  ), covered_references as (
    select reference_product_id as id from active_cases where reference_product_id is not null
    union
    select variant.reference_product_id
    from active_cases reconciliation
    join variants variant on variant.id = reconciliation.reference_variant_id
  ), latest_events as (
    select event.*
    from public.catalog_reference_presence_events event
    join public.catalog_research_run_sources scope on scope.id = event.research_run_source_id
    where scope.research_run_id = (select id from latest_run)
  ), official_types as (
    select coalesce(product_type, 'Sin tipo') as product_type, count(*) as total
    from reference_products group by coalesce(product_type, 'Sin tipo')
  ), case_rows as (
    select jsonb_build_object(
      'caseKey', reconciliation.case_key,
      'status', reconciliation.status,
      'score', reconciliation.score,
      'signal', case
        when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'contradiction'
        when reconciliation.status = 'approved' then 'match'
        else 'candidate'
      end,
      'referenceKey', coalesce(reference_product.reference_key, reference_variant.reference_key),
      'officialName', coalesce(reference_product.name, variant_product.name),
      'officialSku', reference_variant.sku,
      'internalCode', coalesce(internal_product.code, parent_product.code),
      'internalName', coalesce(internal_product.name, internal_variant.name),
      'evidence', reconciliation.evidence
    ) as item
    from active_cases reconciliation
    left join reference_products reference_product on reference_product.id = reconciliation.reference_product_id
    left join variants reference_variant on reference_variant.id = reconciliation.reference_variant_id
    left join reference_products variant_product on variant_product.id = reference_variant.reference_product_id
    left join public.products internal_product on internal_product.id = reconciliation.product_id
    left join public.product_variants internal_variant on internal_variant.id = reconciliation.variant_id
    left join public.products parent_product on parent_product.id = internal_variant.product_id
    order by
      coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) desc,
      reconciliation.score desc,
      coalesce(reference_product.name, variant_product.name)
  ), unmatched_rows as (
    select jsonb_build_object(
      'referenceKey', reference.reference_key,
      'officialName', reference.name,
      'productType', reference.product_type,
      'presentation', reference.presentation,
      'sourceUrl', reference.source_url
    ) as item
    from reference_products reference
    where reference.id not in (select id from covered_references)
    order by reference.name
  ), internal_gap_rows as (
    select jsonb_build_object(
      'internalCode', product.code,
      'internalName', product.name,
      'kind', 'product'
    ) as item
    from internal_products product
    where not exists (
      select 1 from active_cases reconciliation where reconciliation.product_id = product.id
    )
    union all
    select jsonb_build_object(
      'internalCode', variant.sku,
      'internalName', variant.name,
      'kind', 'variant'
    )
    from internal_variants variant
    where not exists (
      select 1 from active_cases reconciliation where reconciliation.variant_id = variant.id
    )
  )
  select jsonb_build_object(
    'brand', (select jsonb_build_object('id', id, 'name', name, 'slug', slug) from brand),
    'currentCatalog', jsonb_build_object(
      'products', (select count(*) from internal_products),
      'variants', (select count(*) from internal_variants)
    ),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourceKey', source_key,
        'name', name,
        'authority', authority,
        'adapter', adapter,
        'baseUrl', base_url,
        'lastSuccessAt', last_success_at
      ) order by source_key) from sources
    ), '[]'::jsonb),
    'lastResearchRun', (select jsonb_build_object(
      'id', id,
      'runKey', run_key,
      'kind', run_kind,
      'status', status,
      'startedAt', started_at,
      'finishedAt', finished_at,
      'inputFingerprint', input_fingerprint,
      'resultFingerprint', result_fingerprint,
      'metrics', metrics,
      'result', result
    ) from latest_run),
    'referenceUniverse', jsonb_build_object(
      'products', (select count(*) from reference_products),
      'variants', (select count(*) from variants),
      'light', (select count(*) from reference_products where enrichment_level = 'REFERENCE_LIGHT'),
      'enriched', (select count(*) from reference_products where enrichment_level = 'REFERENCE_ENRICHED'),
      'byOfficialType', coalesce((select jsonb_object_agg(product_type, total) from official_types), '{}'::jsonb),
      'externalPrices', (select count(*) from public.catalog_reference_prices price where price.target_ref in (
        select 'reference_product:' || id::text from reference_products
        union all select 'reference_variant:' || id::text from variants
      )),
      'remoteMedia', (select count(*) from public.catalog_reference_media media where media.target_ref in (
        select 'reference_product:' || id::text from reference_products
        union all select 'reference_variant:' || id::text from variants
      ))
    ),
    'reconciliation', jsonb_build_object(
      'confirmedMatches', (select count(*) from active_cases where status = 'approved'),
      'candidates', (select count(*) from active_cases where status in ('proposed', 'needs_review') and not coalesce((evidence->>'classificationContradiction')::boolean, false)),
      'contradictions', (select count(*) from active_cases where coalesce((evidence->>'classificationContradiction')::boolean, false)),
      'unmatchedReferences', (select count(*) from reference_products where id not in (select id from covered_references)),
      'pendingReview', (select count(*) from active_cases where status in ('proposed', 'needs_review')),
      'cases', coalesce((select jsonb_agg(item) from case_rows), '[]'::jsonb),
      'unmatched', coalesce((select jsonb_agg(item) from unmatched_rows), '[]'::jsonb)
    ),
    'knowledgeGaps', jsonb_build_object(
      'internalItemsWithoutOfficialCandidate', (select count(*) from internal_gap_rows),
      'items', coalesce((select jsonb_agg(item) from internal_gap_rows), '[]'::jsonb)
    ),
    'progress', jsonb_build_object(
      'officialCoverageRatio', case when (select count(*) from reference_products) = 0 then 0 else 1 end,
      'reconciledOrCandidateRatio', case
        when (select count(*) from reference_products) = 0 then 0
        else round((select count(*) from covered_references)::numeric / (select count(*) from reference_products), 4)
      end,
      'enrichmentRatio', case
        when (select count(*) from reference_products) = 0 then 0
        else round((select count(*) from reference_products where enrichment_level = 'REFERENCE_ENRICHED')::numeric / (select count(*) from reference_products), 4)
      end
    ),
    'delta', jsonb_build_object(
      'firstSeen', (select count(*) from latest_events where delta_status = 'first_seen'),
      'unchanged', (select count(*) from latest_events where delta_status = 'unchanged'),
      'changed', (select count(*) from latest_events where delta_status = 'changed'),
      'missing', (select count(*) from latest_events where delta_status = 'missing_from_source'),
      'returned', (select count(*) from latest_events where delta_status = 'returned'),
      'sourceUnavailable', (select count(*) from latest_events where delta_status = 'source_unavailable')
    )
  );
$function$;

create or replace view public.graph_identity_case_nodes_v1
with (security_invoker = true) as
select
  'identity_case:' || reconciliation.id::text as node_key,
  case
    when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'IdentityContradiction'
    when reconciliation.status = 'approved' then 'IdentityMatch'
    else 'IdentityCandidate'
  end as node_type,
  reconciliation.id as entity_id,
  coalesce(reconciliation.case_key, reconciliation.algorithm || ':' || reconciliation.id::text) as label,
  case
    when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'evidence'
    when reconciliation.status = 'approved' then 'reference'
    else 'candidate'
  end as layer,
  jsonb_build_object(
    'caseKey', reconciliation.case_key,
    'algorithm', reconciliation.algorithm,
    'score', reconciliation.score,
    'status', reconciliation.status,
    'evidence', reconciliation.evidence,
    'researchRunId', reconciliation.research_run_id
  ) as properties
from public.catalog_reconciliation_cases reconciliation
where num_nonnulls(reconciliation.reference_product_id, reconciliation.reference_variant_id) = 1
  and reconciliation.status in ('proposed', 'needs_review', 'approved');

create or replace view public.graph_identity_case_edges_v1
with (security_invoker = true) as
select
  'identity-case-reference:' || reconciliation.id::text as edge_key,
  'identity_case:' || reconciliation.id::text as source_key,
  'ABOUT_REFERENCE'::text as predicate,
  case
    when reconciliation.reference_product_id is not null then 'reference_product:' || reconciliation.reference_product_id::text
    else 'reference_variant:' || reconciliation.reference_variant_id::text
  end as target_key,
  case
    when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'evidence'
    when reconciliation.status = 'approved' then 'reference'
    else 'candidate'
  end as layer,
  '{}'::jsonb as properties
from public.catalog_reconciliation_cases reconciliation
where num_nonnulls(reconciliation.reference_product_id, reconciliation.reference_variant_id) = 1
  and reconciliation.status in ('proposed', 'needs_review', 'approved')
union all
select
  'identity-case-internal:' || reconciliation.id::text,
  'identity_case:' || reconciliation.id::text,
  case
    when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'CONTRADICTS_CLASSIFICATION_OF'
    when reconciliation.status = 'approved' then 'CONFIRMED_MATCH'
    else 'CANDIDATE_FOR'
  end,
  case
    when reconciliation.product_id is not null then 'product:' || reconciliation.product_id::text
    else 'variant:' || reconciliation.variant_id::text
  end,
  case
    when coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false) then 'evidence'
    when reconciliation.status = 'approved' then 'reference'
    else 'candidate'
  end,
  jsonb_build_object('algorithm', reconciliation.algorithm, 'score', reconciliation.score)
from public.catalog_reconciliation_cases reconciliation
where num_nonnulls(reconciliation.reference_product_id, reconciliation.reference_variant_id) = 1
  and reconciliation.status in ('proposed', 'needs_review', 'approved');

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select
  node.node_key,
  node.node_type,
  node.entity_id,
  node.label,
  node.layer,
  node.properties,
  md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|' || node.label || '|' || node.properties::text) as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all
  select * from public.graph_identity_case_nodes_v1
) node;

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select
  edge.edge_key,
  edge.source_key,
  edge.predicate,
  edge.target_key,
  edge.layer,
  edge.properties,
  md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|' || edge.target_key || '|' || edge.layer || '|' || edge.properties::text) as projection_fingerprint
from (
  select * from public.graph_edges_v2_base where edge_key not like 'reference-match:%'
  union all
  select * from public.graph_identity_case_edges_v1
) edge;

revoke execute on function public.stage_catalog_brand_reconciliation_v1(uuid, uuid, uuid) from public, anon;
revoke execute on function public.get_catalog_brand_intelligence_report_v1(uuid) from public, anon;
grant execute on function public.stage_catalog_brand_reconciliation_v1(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.get_catalog_brand_intelligence_report_v1(uuid) to authenticated, service_role;
grant select on public.graph_identity_case_nodes_v1, public.graph_identity_case_edges_v1 to authenticated, service_role;

comment on function public.stage_catalog_brand_reconciliation_v1(uuid, uuid, uuid) is
  'Genera señales de identidad por reglas genéricas de nombre, clasificación y presentación; nunca decide ni publica.';
comment on function public.get_catalog_brand_intelligence_report_v1(uuid) is
  'Contrato agregado, respaldado por PostgreSQL, para campañas, operación y MCP local.';

commit;
