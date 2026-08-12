-- 0104 · Contratos transaccionales e indexados de investigación

begin;

create or replace function public.finalize_catalog_research_source_v1(
  p_research_run_source_id uuid,
  p_status text,
  p_result_fingerprint text default null,
  p_metrics jsonb default '{}'::jsonb,
  p_errors jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  scope public.catalog_research_run_sources%rowtype;
  missing_products bigint := 0;
  missing_variants bigint := 0;
  unavailable_events bigint := 0;
begin
  if p_status not in ('succeeded', 'partial', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'Estado final de fuente inválido.';
  end if;
  if jsonb_typeof(p_metrics) <> 'object' or jsonb_typeof(p_errors) <> 'array' then
    raise exception using errcode = '22023', message = 'Métricas o errores con forma inválida.';
  end if;

  select * into scope
  from public.catalog_research_run_sources
  where id = p_research_run_source_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Alcance de investigación inexistente.';
  end if;

  if p_status = 'failed' then
    insert into public.catalog_reference_presence_events(
      research_run_source_id, delta_status, previous_fingerprint, current_fingerprint,
      observed_at, metadata
    ) values (
      scope.id, 'source_unavailable', scope.result_fingerprint, null,
      statement_timestamp(), jsonb_build_object('errors', p_errors)
    ) on conflict (research_run_source_id, target_ref) do nothing;
    get diagnostics unavailable_events = row_count;

    update public.catalog_reference_products
    set presence_status = 'source_unavailable', updated_at = now()
    where primary_source_id = scope.source_id and presence_status <> 'retired';

    update public.catalog_reference_variants
    set presence_status = 'source_unavailable', updated_at = now()
    where primary_source_id = scope.source_id and presence_status <> 'retired';
  else
    insert into public.catalog_reference_presence_events(
      research_run_source_id, reference_product_id, delta_status,
      previous_fingerprint, current_fingerprint, observed_at, metadata
    )
    select
      scope.id, reference.id, 'missing_from_source', reference.content_fingerprint,
      null, statement_timestamp(), '{}'::jsonb
    from public.catalog_reference_products reference
    where reference.primary_source_id = scope.source_id
      and reference.presence_status <> 'retired'
      and not exists (
        select 1 from public.catalog_reference_presence_events event
        where event.research_run_source_id = scope.id
          and event.reference_product_id = reference.id
      )
    on conflict (research_run_source_id, target_ref) do nothing;
    get diagnostics missing_products = row_count;

    insert into public.catalog_reference_presence_events(
      research_run_source_id, reference_variant_id, delta_status,
      previous_fingerprint, current_fingerprint, observed_at, metadata
    )
    select
      scope.id, variant.id, 'missing_from_source', variant.content_fingerprint,
      null, statement_timestamp(), '{}'::jsonb
    from public.catalog_reference_variants variant
    where variant.primary_source_id = scope.source_id
      and variant.presence_status <> 'retired'
      and not exists (
        select 1 from public.catalog_reference_presence_events event
        where event.research_run_source_id = scope.id
          and event.reference_variant_id = variant.id
      )
    on conflict (research_run_source_id, target_ref) do nothing;
    get diagnostics missing_variants = row_count;
  end if;

  update public.catalog_research_run_sources
  set status = p_status,
      source_state = case
        when p_status = 'failed' then 'source_unavailable'
        when scope.source_state = 'source_unavailable' then 'returned'
        else scope.source_state
      end,
      result_fingerprint = p_result_fingerprint,
      metrics = p_metrics || jsonb_build_object(
        'missingProducts', missing_products,
        'missingVariants', missing_variants,
        'sourceUnavailableEvents', unavailable_events
      ),
      errors = p_errors,
      finished_at = statement_timestamp()
  where id = scope.id;

  return jsonb_build_object(
    'researchRunSourceId', scope.id,
    'status', p_status,
    'missingProducts', missing_products,
    'missingVariants', missing_variants,
    'sourceUnavailableEvents', unavailable_events
  );
end;
$function$;

create or replace function public.finalize_catalog_research_run_v1(
  p_research_run_id uuid,
  p_status text,
  p_result_fingerprint text,
  p_result jsonb default '{}'::jsonb,
  p_errors jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  run public.catalog_research_runs%rowtype;
  computed_metrics jsonb;
begin
  if p_status not in ('succeeded', 'partial', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'Estado final de corrida inválido.';
  end if;
  if jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_errors) <> 'array' then
    raise exception using errcode = '22023', message = 'Resultado o errores con forma inválida.';
  end if;

  select * into run from public.catalog_research_runs where id = p_research_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Corrida de investigación inexistente.';
  end if;

  if exists (
    select 1 from public.catalog_research_run_sources scope
    where scope.research_run_id = run.id and scope.status = 'running'
  ) then
    raise exception using errcode = '55000', message = 'No se puede cerrar una corrida con fuentes todavía activas.';
  end if;

  with run_scopes as (
    select scope.* from public.catalog_research_run_sources scope
    where scope.research_run_id = run.id
  ), run_events as (
    select event.*
    from public.catalog_reference_presence_events event
    join run_scopes scope on scope.id = event.research_run_source_id
  ), run_products as (
    select event.reference_product_id as id from run_events event
    where event.reference_product_id is not null
    union
    select variant.reference_product_id
    from run_events event
    join public.catalog_reference_variants variant on variant.id = event.reference_variant_id
  ), matched_products as (
    select reconciliation.reference_product_id as id
    from public.catalog_reconciliation_cases reconciliation
    where reconciliation.status = 'approved'
      and reconciliation.reference_product_id in (select id from run_products)
    union
    select variant.reference_product_id
    from public.catalog_reconciliation_cases reconciliation
    join public.catalog_reference_variants variant on variant.id = reconciliation.reference_variant_id
    where reconciliation.status = 'approved'
      and variant.reference_product_id in (select id from run_products)
  ), attached_brands as (
    select brand_id from public.catalog_research_run_brands where research_run_id = run.id
  ), covered_brands as (
    select distinct reference.brand_id
    from public.catalog_reference_products reference
    where reference.id in (select id from run_products)
  )
  select jsonb_build_object(
    'sources', (select count(*) from run_scopes),
    'referenceItemsKnown', (select count(*) from run_products),
    'referenceVariantsKnown', (select count(distinct reference_variant_id) from run_events where reference_variant_id is not null),
    'referenceItemsNew', (select count(distinct coalesce(event.reference_product_id, variant.reference_product_id)) from run_events event left join public.catalog_reference_variants variant on variant.id = event.reference_variant_id where event.delta_status = 'first_seen'),
    'referenceItemsChanged', (select count(distinct coalesce(event.reference_product_id, variant.reference_product_id)) from run_events event left join public.catalog_reference_variants variant on variant.id = event.reference_variant_id where event.delta_status = 'changed'),
    'referenceItemsMatchedInternal', (select count(*) from matched_products),
    'referenceItemsUnmatched', (select count(*) from run_products) - (select count(*) from matched_products),
    'referenceItemsReadyForCommercialDecision', (select count(*) from public.catalog_reference_products reference where reference.id in (select id from run_products) and reference.knowledge_status = 'ready_for_commercial_decision'),
    'referenceItemsLight', (select count(*) from public.catalog_reference_products reference where reference.id in (select id from run_products) and reference.enrichment_level = 'REFERENCE_LIGHT'),
    'referenceItemsEnriched', (select count(*) from public.catalog_reference_products reference where reference.id in (select id from run_products) and reference.enrichment_level = 'REFERENCE_ENRICHED'),
    'brandsWithReferenceCoverage', (select count(*) from covered_brands),
    'brandsWithoutSource', (select count(*) from attached_brands brand where not exists (select 1 from run_scopes scope where scope.brand_id = brand.brand_id)),
    'coverageRatio', case
      when (select count(*) from attached_brands) = 0 then 0
      else round((select count(*) from covered_brands)::numeric / (select count(*) from attached_brands), 4)
    end,
    'firstSeen', (select count(*) from run_events where delta_status = 'first_seen'),
    'unchanged', (select count(*) from run_events where delta_status = 'unchanged'),
    'changed', (select count(*) from run_events where delta_status = 'changed'),
    'missing', (select count(*) from run_events where delta_status = 'missing_from_source'),
    'returned', (select count(*) from run_events where delta_status = 'returned'),
    'sourceUnavailable', (select count(*) from run_events where delta_status = 'source_unavailable')
  ) into computed_metrics;

  update public.catalog_research_runs
  set status = p_status,
      result_fingerprint = p_result_fingerprint,
      metrics = computed_metrics,
      errors = p_errors,
      result = p_result,
      finished_at = statement_timestamp()
  where id = run.id;

  return jsonb_build_object(
    'researchRunId', run.id,
    'status', p_status,
    'metrics', computed_metrics,
    'result', p_result
  );
end;
$function$;

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
    limit p_limit
  ), name_candidates as (
    select
      'reference_product:' || product.id::text as target_ref,
      product.reference_key,
      'product'::text as entity_kind,
      product.normalized_name,
      'normalized_name'::text as match_basis,
      public.similarity(product.normalized_name, p_normalized_name)::numeric as score
    from public.catalog_reference_products product
    where p_normalized_name is not null
      and product.brand_id = p_brand_id
      and product.normalized_name operator(public.%) p_normalized_name
    order by public.similarity(product.normalized_name, p_normalized_name) desc, product.reference_key
    limit p_limit
  )
  select * from exact_identifier
  union all
  select name.* from name_candidates name
  where not exists (select 1 from exact_identifier)
  order by score desc, reference_key
  limit greatest(1, least(p_limit, 100));
$function$;

create or replace function public.upsert_catalog_reference_product_v1(
  p_research_run_id uuid,
  p_observed_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resolved public.catalog_reference_products%rowtype;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'El producto de referencia debe ser un objeto JSON.';
  end if;

  insert into public.catalog_reference_products as current_reference(
    reference_key, brand_id, primary_source_id, primary_source_record_id,
    primary_external_id, name, normalized_name, family, product_type, line,
    presentation, source_url, primary_image_url, identity_fingerprint,
    content_fingerprint, enrichment_level, first_seen_run_id, last_seen_run_id,
    first_seen_at, last_seen_at, metadata
  ) values (
    p_payload->>'referenceKey', (p_payload->>'brandId')::uuid,
    (p_payload->>'sourceId')::uuid, nullif(p_payload->>'sourceRecordId', '')::uuid,
    p_payload->>'externalId', p_payload->>'name', p_payload->>'normalizedName',
    nullif(p_payload->>'family', ''), nullif(p_payload->>'productType', ''),
    nullif(p_payload->>'line', ''), nullif(p_payload->>'presentation', ''),
    p_payload->>'sourceUrl', nullif(p_payload->>'imageUrl', ''),
    p_payload->>'identityFingerprint', p_payload->>'contentFingerprint',
    coalesce(nullif(p_payload->>'level', ''), 'REFERENCE_LIGHT'),
    p_research_run_id, p_research_run_id, p_observed_at, p_observed_at,
    coalesce(p_payload->'metadata', '{}'::jsonb)
  )
  on conflict (reference_key) do update set
    primary_source_record_id = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.primary_source_record_id else current_reference.primary_source_record_id end,
    name = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.name else current_reference.name end,
    normalized_name = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.normalized_name else current_reference.normalized_name end,
    family = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.family, current_reference.family) else current_reference.family end,
    product_type = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.product_type, current_reference.product_type) else current_reference.product_type end,
    line = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.line, current_reference.line) else current_reference.line end,
    presentation = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.presentation, current_reference.presentation) else current_reference.presentation end,
    source_url = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.source_url else current_reference.source_url end,
    primary_image_url = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.primary_image_url, current_reference.primary_image_url) else current_reference.primary_image_url end,
    content_fingerprint = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.content_fingerprint else current_reference.content_fingerprint end,
    enrichment_level = case when current_reference.enrichment_level = 'REFERENCE_ENRICHED' then current_reference.enrichment_level else excluded.enrichment_level end,
    last_seen_run_id = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.last_seen_run_id else current_reference.last_seen_run_id end,
    last_seen_at = greatest(current_reference.last_seen_at, excluded.last_seen_at),
    metadata = case when excluded.last_seen_at >= current_reference.last_seen_at then current_reference.metadata || excluded.metadata else current_reference.metadata end,
    updated_at = now()
  returning * into resolved;

  return jsonb_build_object(
    'id', resolved.id,
    'reference_key', resolved.reference_key,
    'enrichment_level', resolved.enrichment_level,
    'presence_status', resolved.presence_status
  );
end;
$function$;

create or replace function public.upsert_catalog_reference_variant_v1(
  p_research_run_id uuid,
  p_observed_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resolved public.catalog_reference_variants%rowtype;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'La variante de referencia debe ser un objeto JSON.';
  end if;

  insert into public.catalog_reference_variants as current_reference(
    reference_product_id, reference_key, primary_source_id,
    primary_source_record_id, primary_external_id, name, normalized_name, sku,
    barcode, shade_name, presentation, source_url, primary_image_url,
    identity_fingerprint, content_fingerprint, enrichment_level,
    first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata
  ) values (
    (p_payload->>'referenceProductId')::uuid, p_payload->>'referenceKey',
    (p_payload->>'sourceId')::uuid, nullif(p_payload->>'sourceRecordId', '')::uuid,
    p_payload->>'externalId', p_payload->>'name', p_payload->>'normalizedName',
    nullif(p_payload->>'sku', ''), nullif(p_payload->>'barcode', ''),
    nullif(p_payload->>'shadeName', ''), nullif(p_payload->>'presentation', ''),
    p_payload->>'sourceUrl', nullif(p_payload->>'imageUrl', ''),
    p_payload->>'identityFingerprint', p_payload->>'contentFingerprint',
    coalesce(nullif(p_payload->>'level', ''), 'REFERENCE_LIGHT'),
    p_research_run_id, p_research_run_id, p_observed_at, p_observed_at,
    coalesce(p_payload->'metadata', '{}'::jsonb)
  )
  on conflict (reference_key) do update set
    primary_source_record_id = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.primary_source_record_id else current_reference.primary_source_record_id end,
    name = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.name else current_reference.name end,
    normalized_name = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.normalized_name else current_reference.normalized_name end,
    sku = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.sku, current_reference.sku) else current_reference.sku end,
    barcode = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.barcode, current_reference.barcode) else current_reference.barcode end,
    shade_name = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.shade_name, current_reference.shade_name) else current_reference.shade_name end,
    presentation = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.presentation, current_reference.presentation) else current_reference.presentation end,
    source_url = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.source_url else current_reference.source_url end,
    primary_image_url = case when excluded.last_seen_at >= current_reference.last_seen_at then coalesce(excluded.primary_image_url, current_reference.primary_image_url) else current_reference.primary_image_url end,
    content_fingerprint = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.content_fingerprint else current_reference.content_fingerprint end,
    enrichment_level = case when current_reference.enrichment_level = 'REFERENCE_ENRICHED' then current_reference.enrichment_level else excluded.enrichment_level end,
    last_seen_run_id = case when excluded.last_seen_at >= current_reference.last_seen_at then excluded.last_seen_run_id else current_reference.last_seen_run_id end,
    last_seen_at = greatest(current_reference.last_seen_at, excluded.last_seen_at),
    metadata = case when excluded.last_seen_at >= current_reference.last_seen_at then current_reference.metadata || excluded.metadata else current_reference.metadata end,
    updated_at = now()
  returning * into resolved;

  return jsonb_build_object(
    'id', resolved.id,
    'reference_key', resolved.reference_key,
    'enrichment_level', resolved.enrichment_level,
    'presence_status', resolved.presence_status
  );
end;
$function$;

create or replace function public.upsert_catalog_reference_identifier_v1(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resolved public.catalog_reference_identifiers%rowtype;
  product_id uuid := nullif(p_payload#>>'{subject,id}', '')::uuid;
  variant_id uuid := nullif(p_payload#>>'{subject,id}', '')::uuid;
begin
  if jsonb_typeof(p_payload) <> 'object' or p_payload#>>'{subject,kind}' not in ('reference_product', 'reference_variant') then
    raise exception using errcode = '22023', message = 'El identificador requiere un sujeto de referencia tipado.';
  end if;

  if p_payload#>>'{subject,kind}' = 'reference_product' then
    variant_id := null;
  else
    product_id := null;
  end if;

  insert into public.catalog_reference_identifiers as current_identifier(
    reference_product_id, reference_variant_id, source_id, source_record_id,
    identifier_kind, observed_value, normalized_value, first_seen_run_id,
    last_seen_run_id, first_seen_at, last_seen_at
  ) values (
    product_id, variant_id, (p_payload->>'sourceId')::uuid,
    nullif(p_payload->>'sourceRecordId', '')::uuid, p_payload->>'kind',
    p_payload->>'observedValue', p_payload->>'normalizedValue',
    (p_payload->>'researchRunId')::uuid, (p_payload->>'researchRunId')::uuid,
    (p_payload->>'observedAt')::timestamptz, (p_payload->>'observedAt')::timestamptz
  )
  on conflict (target_ref, source_id, identifier_kind, normalized_value) do update set
    source_record_id = case when excluded.last_seen_at >= current_identifier.last_seen_at then excluded.source_record_id else current_identifier.source_record_id end,
    observed_value = case when excluded.last_seen_at >= current_identifier.last_seen_at then excluded.observed_value else current_identifier.observed_value end,
    last_seen_run_id = case when excluded.last_seen_at >= current_identifier.last_seen_at then excluded.last_seen_run_id else current_identifier.last_seen_run_id end,
    last_seen_at = greatest(current_identifier.last_seen_at, excluded.last_seen_at)
  returning * into resolved;

  return jsonb_build_object(
    'id', resolved.id,
    'target_ref', resolved.target_ref,
    'identifier_kind', resolved.identifier_kind,
    'normalized_value', resolved.normalized_value
  );
end;
$function$;

revoke execute on function public.finalize_catalog_research_source_v1(uuid, text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.finalize_catalog_research_run_v1(uuid, text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.get_catalog_reference_candidates_v1(uuid, uuid, text, text, text, integer) from public, anon;
revoke execute on function public.upsert_catalog_reference_product_v1(uuid, timestamptz, jsonb) from public, anon;
revoke execute on function public.upsert_catalog_reference_variant_v1(uuid, timestamptz, jsonb) from public, anon;
revoke execute on function public.upsert_catalog_reference_identifier_v1(jsonb) from public, anon;
revoke execute on function public.validate_catalog_observation() from public, anon, authenticated;
revoke execute on function public.apply_catalog_reference_presence_event() from public, anon, authenticated;
revoke execute on function public.prevent_catalog_reference_presence_event_mutation() from public, anon, authenticated;
grant execute on function public.finalize_catalog_research_source_v1(uuid, text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.finalize_catalog_research_run_v1(uuid, text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.get_catalog_reference_candidates_v1(uuid, uuid, text, text, text, integer) to authenticated, service_role;
grant execute on function public.upsert_catalog_reference_product_v1(uuid, timestamptz, jsonb) to authenticated, service_role;
grant execute on function public.upsert_catalog_reference_variant_v1(uuid, timestamptz, jsonb) to authenticated, service_role;
grant execute on function public.upsert_catalog_reference_identifier_v1(jsonb) to authenticated, service_role;

comment on function public.get_catalog_reference_candidates_v1(uuid, uuid, text, text, text, integer) is
  'Matching indexado y acotado. Nunca carga ni cruza lote por universo completo en memoria.';

commit;
