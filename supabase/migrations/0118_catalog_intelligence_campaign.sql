-- ---------------------------------------------------------------------------
-- 0118 · Etapa 5: campaña manual de Inteligencia de Catálogo
-- ---------------------------------------------------------------------------
-- Persiste la orquestación de contratos ya cerrados. El comando externo
-- investiga y proyecta; PostgreSQL congela el inicio, audita cada paso y
-- certifica que Catálogo, precios, stock y publicación no cambiaron.

begin;

create table public.catalog_intelligence_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null unique,
  source_id uuid not null references public.catalog_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  status text not null default 'previewed',
  options jsonb not null,
  request_fingerprint text not null,
  state_fingerprint text not null,
  preview_fingerprint text not null unique,
  baseline jsonb not null,
  result jsonb,
  error_detail jsonb,
  final_fingerprint text,
  created_by uuid references auth.users(id) on delete set null,
  started_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint catalog_intelligence_campaigns_key_not_blank
    check (length(trim(campaign_key)) between 1 and 180),
  constraint catalog_intelligence_campaigns_status_allowed
    check (status in ('previewed','running','succeeded','failed','cancelled')),
  constraint catalog_intelligence_campaigns_json_shapes check (
    jsonb_typeof(options)='object' and jsonb_typeof(baseline)='object'
    and (result is null or jsonb_typeof(result)='object')
    and (error_detail is null or jsonb_typeof(error_detail)='object')
  ),
  constraint catalog_intelligence_campaigns_fingerprints check (
    length(request_fingerprint)=64 and length(state_fingerprint)=64
    and length(preview_fingerprint)=64
    and (final_fingerprint is null or length(final_fingerprint)=64)
  ),
  constraint catalog_intelligence_campaigns_lifecycle check (
    (status='previewed' and started_at is null and finished_at is null)
    or (status='running' and started_at is not null and finished_at is null)
    or (status in ('succeeded','failed','cancelled')
      and started_at is not null and finished_at is not null)
  )
);

create index catalog_intelligence_campaigns_source_idx
  on public.catalog_intelligence_campaigns(source_id,created_at desc);

create table public.catalog_intelligence_campaign_events (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.catalog_intelligence_campaigns(id) on delete restrict,
  step_code text not null,
  status text not null,
  idempotency_key text not null unique,
  request_fingerprint text not null,
  result jsonb not null default '{}'::jsonb,
  error_detail jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint catalog_intelligence_campaign_events_step_allowed check (step_code in (
    'research_delta','semantic_certification','review_reprocess','relation_reprocess',
    'decisions_sync','controlled_expansion','graph_sync','graph_verify','readiness'
  )),
  constraint catalog_intelligence_campaign_events_status_allowed
    check (status in ('succeeded','skipped','failed')),
  constraint catalog_intelligence_campaign_events_shapes check (
    jsonb_typeof(result)='object'
    and (error_detail is null or jsonb_typeof(error_detail)='object')
    and length(request_fingerprint)=64
  ),
  constraint catalog_intelligence_campaign_events_failure_consistent check (
    (status='failed' and error_detail is not null)
    or (status<>'failed' and error_detail is null)
  )
);

create index catalog_intelligence_campaign_events_campaign_idx
  on public.catalog_intelligence_campaign_events(campaign_id,id);

create or replace function public.get_catalog_reference_commercial_readiness_v1(
  p_source_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with candidates as (
    select reference.*,
      (select count(*)::integer from public.catalog_reference_variants variant
        where variant.reference_product_id=reference.id
          and variant.presence_status='present') as variant_count,
      (select count(distinct claim.dimension_code)::integer
        from public.catalog_semantic_claims claim
        where claim.subject_ref='reference_product:'||reference.id::text
          and claim.claim_status='ASSERTED') as asserted_dimensions,
      exists (
        select 1 from public.catalog_reconciliation_cases reconciliation
        where reconciliation.status='needs_review'
          and coalesce((reconciliation.evidence->>'classificationContradiction')::boolean,false)
          and (reconciliation.reference_product_id=reference.id or exists (
            select 1 from public.catalog_reference_variants variant
            where variant.reference_product_id=reference.id
              and variant.id=reconciliation.reference_variant_id
          ))
      ) as has_blocking_contradiction,
      (reference.primary_image_url is not null or exists (
        select 1 from public.catalog_reference_media media
        where media.reference_product_id=reference.id
      )) as has_image
    from public.catalog_reference_products reference
    where reference.primary_source_id=p_source_id
      and reference.presence_status='present'
      and reference.knowledge_status in ('candidate_new','ready_for_commercial_decision')
  ), assessed as (
    select candidates.*,
      array_remove(array[
        case when nullif(trim(reference_key),'') is null
          or nullif(trim(primary_external_id),'') is null
          or nullif(trim(identity_fingerprint),'') is null then 'identidad_incompleta' end,
        case when nullif(trim(name),'') is null or brand_id is null then 'nombre_o_marca' end,
        case when nullif(trim(product_type),'') is null then 'tipo_de_producto' end,
        case when nullif(trim(presentation),'') is null then 'presentacion' end,
        case when variant_count<1 then 'producto_variante' end,
        case when primary_source_record_id is null or nullif(trim(source_url),'') is null
          then 'evidencia_de_origen' end,
        case when asserted_dimensions<3 then 'atributos_esenciales' end,
        case when has_blocking_contradiction then 'contradiccion' end,
        case when not has_image then 'imagen_o_deuda_explicita' end
      ],null) as blockers
    from candidates
  ), totals as (
    select
      count(*)::integer candidates,
      count(*) filter(where cardinality(blockers)=0)::integer ready,
      count(*) filter(where cardinality(blockers)>0)::integer blocked,
      count(*) filter(where 'presentacion'=any(blockers))::integer missing_presentation,
      count(*) filter(where 'contradiccion'=any(blockers))::integer contradictions
    from assessed
  )
  select jsonb_build_object(
    'contractVersion','commercial-readiness-v1',
    'sourceId',p_source_id,
    'summary',jsonb_build_object(
      'candidates',totals.candidates,
      'ready',totals.ready,
      'blocked',totals.blocked,
      'missingPresentation',totals.missing_presentation,
      'contradictions',totals.contradictions
    ),
    'criteria',jsonb_build_array(
      'Identidad oficial estable','Marca y tipo definidos','Producto y variante entendidos',
      'Presentación informada','Evidencia y atributos suficientes',
      'Sin contradicción bloqueante','Imagen disponible o deuda explícita'
    ),
    'ready',coalesce((select jsonb_agg(jsonb_build_object(
      'referenceProductId',id,'referenceKey',reference_key,'name',name,
      'productType',product_type,'presentation',presentation,'sourceUrl',source_url,
      'primaryImageUrl',primary_image_url,'variantCount',variant_count,
      'assertedDimensions',asserted_dimensions,'currentStatus',knowledge_status,
      'suggestedStatus','ready_for_commercial_decision'
    ) order by name) from assessed where cardinality(blockers)=0),'[]'::jsonb),
    'blocked',coalesce((select jsonb_agg(jsonb_build_object(
      'referenceProductId',id,'name',name,'blockers',to_jsonb(blockers)
    ) order by name) from assessed where cardinality(blockers)>0),'[]'::jsonb),
    'guards',jsonb_build_object(
      'commercialProductsCreated',0,'priceAssigned',false,'stockAssigned',false,
      'publicationChanged',false,'automaticAdoption',false
    )
  ) from totals;
$function$;

create or replace function public.catalog_intelligence_campaign_snapshot_v1(
  p_source_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with source as (
    select catalog_source.id,catalog_source.source_key,catalog_source.brand_id,
      brand.name brand_name
    from public.catalog_sources catalog_source
    join public.brands brand on brand.id=catalog_source.brand_id
    where catalog_source.id=p_source_id
  ), commercial as (
    select encode(extensions.digest(convert_to(jsonb_build_object(
      'products',coalesce((select jsonb_agg(jsonb_build_array(
        product.id,product.unit_price,product.wholesale_price,product.is_active,
        product.editorial_status,product.published_at
      ) order by product.id) from public.products product),'[]'::jsonb),
      'variantPrices',coalesce((select jsonb_agg(to_jsonb(price) order by price.id)
        from public.variant_prices price),'[]'::jsonb),
      'stock',coalesce((select jsonb_agg(to_jsonb(stock)
        order by stock.variant_id,stock.branch_id) from public.inventory_stock stock),'[]'::jsonb)
    )::text,'UTF8'),'sha256'),'hex') fingerprint
  ), latest_research as (
    select scope.id scope_id,scope.research_run_id,scope.source_state,
      scope.result_fingerprint,scope.finished_at,run.run_key,run.run_kind,run.status
    from public.catalog_research_run_sources scope
    join public.catalog_research_runs run on run.id=scope.research_run_id
    where scope.source_id=p_source_id and scope.scope_key='official-catalog'
    order by scope.finished_at desc nulls last,scope.created_at desc limit 1
  ), latest_review as (
    select run.id,run.status,run.logical_fingerprint,run.applied_at
    from public.catalog_review_reprocess_runs run
    order by run.created_at desc limit 1
  ), latest_relations as (
    select run.id,run.status,run.preview_fingerprint,run.applied_at
    from public.catalog_relation_reprocess_runs run
    order by run.created_at desc limit 1
  )
  select jsonb_build_object(
    'source',coalesce((select to_jsonb(source) from source),'null'::jsonb),
    'commercialFingerprint',(select fingerprint from commercial),
    'commercialCounts',jsonb_build_object(
      'products',(select count(*) from public.products),
      'variants',(select count(*) from public.product_variants),
      'variantPrices',(select count(*) from public.variant_prices),
      'stockRows',(select count(*) from public.inventory_stock)
    ),
    'referenceUniverse',jsonb_build_object(
      'products',(select count(*) from public.catalog_reference_products where primary_source_id=p_source_id),
      'variants',(select count(*) from public.catalog_reference_variants variant
        join public.catalog_reference_products product on product.id=variant.reference_product_id
        where product.primary_source_id=p_source_id),
      'candidateNew',(select count(*) from public.catalog_reference_products
        where primary_source_id=p_source_id and knowledge_status='candidate_new'),
      'identityConflicts',(select count(*) from public.catalog_reference_products
        where primary_source_id=p_source_id and knowledge_status='identity_conflict')
    ),
    'latestResearch',coalesce((select to_jsonb(latest_research) from latest_research),'null'::jsonb),
    'latestReviewReprocess',coalesce((select to_jsonb(latest_review) from latest_review),'null'::jsonb),
    'latestRelationReprocess',coalesce((select to_jsonb(latest_relations) from latest_relations),'null'::jsonb),
    'relationDecisions',jsonb_build_object(
      'pending',(select count(*) from public.catalog_relation_decisions where status='pending'),
      'resolved',(select count(*) from public.catalog_relation_decisions where status<>'pending')
    ),
    'controlledExpansion',public.get_catalog_controlled_expansion_report_v1()
  );
$function$;

create or replace function public.catalog_intelligence_campaign_state_v1(p_source_id uuid)
returns text
language sql
stable
security invoker
set search_path=''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'campaignSnapshot',public.catalog_intelligence_campaign_snapshot_v1(p_source_id),
    'universalSystemState',public.catalog_system_expansion_state_v1()
  )::text,'UTF8'),'sha256'),'hex');
$function$;

create or replace function public.preview_catalog_intelligence_campaign_v1(
  p_source_key text,
  p_campaign_key text,
  p_options jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  source public.catalog_sources%rowtype;
  normalized_options jsonb;
  baseline jsonb;
  request_fingerprint text;
  state_fingerprint text;
  preview_fingerprint text;
  existing public.catalog_intelligence_campaigns%rowtype;
  created public.catalog_intelligence_campaigns%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede preparar una campaña de catálogo.';
  end if;
  if nullif(trim(coalesce(p_source_key,'')),'') is null
     or nullif(trim(coalesce(p_campaign_key,'')),'') is null
     or length(trim(p_campaign_key))>180
     or jsonb_typeof(coalesce(p_options,'{}'::jsonb))<>'object' then
    raise exception using errcode='22023', message='La campaña requiere fuente, clave y opciones válidas.';
  end if;
  if exists(select 1 from jsonb_object_keys(coalesce(p_options,'{}'::jsonb)) key
      where key not in ('runResearch','certifySemantics','reprocessReview',
        'reprocessRelations','syncDecisions','applyControlledExpansion','syncGraph',
        'evaluateReadiness','autoApplyDecisions','publishProducts','assignPrices','assignStock'))
     or coalesce((p_options->>'autoApplyDecisions')::boolean,false)
     or coalesce((p_options->>'publishProducts')::boolean,false)
     or coalesce((p_options->>'assignPrices')::boolean,false)
     or coalesce((p_options->>'assignStock')::boolean,false) then
    raise exception using errcode='22023', message='La campaña contiene una capacidad fuera del alcance autorizado.';
  end if;
  select * into source from public.catalog_sources catalog_source
  where catalog_source.source_key=trim(p_source_key)
    and catalog_source.authority='official' and catalog_source.is_active;
  if not found or source.brand_id is null then
    raise exception using errcode='P0002', message='La fuente oficial no existe, está inactiva o no tiene marca.';
  end if;

  normalized_options := jsonb_build_object(
    'runResearch',coalesce((p_options->>'runResearch')::boolean,true),
    'certifySemantics',coalesce((p_options->>'certifySemantics')::boolean,true),
    'reprocessReview',coalesce((p_options->>'reprocessReview')::boolean,true),
    'reprocessRelations',coalesce((p_options->>'reprocessRelations')::boolean,true),
    'syncDecisions',coalesce((p_options->>'syncDecisions')::boolean,true),
    'applyControlledExpansion',coalesce((p_options->>'applyControlledExpansion')::boolean,true),
    'syncGraph',coalesce((p_options->>'syncGraph')::boolean,true),
    'evaluateReadiness',coalesce((p_options->>'evaluateReadiness')::boolean,true),
    'autoApplyDecisions',false,'publishProducts',false,'assignPrices',false,'assignStock',false
  );
  request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'sourceKey',source.source_key,'brandId',source.brand_id,
    'options',normalized_options
  )::text,'UTF8'),'sha256'),'hex');

  select * into existing from public.catalog_intelligence_campaigns campaign
  where campaign.campaign_key=trim(p_campaign_key);
  if found then
    if existing.request_fingerprint<>request_fingerprint then
      raise exception using errcode='23505', message='La clave de campaña ya representa otra solicitud.';
    end if;
    return jsonb_build_object(
      'contractVersion','catalog-intelligence-campaign-v1','campaignId',existing.id,
      'campaignKey',existing.campaign_key,'status',existing.status,
      'previewFingerprint',existing.preview_fingerprint,'baseline',existing.baseline,
      'options',existing.options,'idempotentReplay',true
    );
  end if;

  baseline := public.catalog_intelligence_campaign_snapshot_v1(source.id);
  state_fingerprint := public.catalog_intelligence_campaign_state_v1(source.id);
  preview_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'campaignKey',trim(p_campaign_key),'request',request_fingerprint,
    'state',state_fingerprint,'baseline',baseline
  )::text,'UTF8'),'sha256'),'hex');
  insert into public.catalog_intelligence_campaigns(
    campaign_key,source_id,brand_id,options,request_fingerprint,state_fingerprint,
    preview_fingerprint,baseline,created_by
  ) values (
    trim(p_campaign_key),source.id,source.brand_id,normalized_options,request_fingerprint,
    state_fingerprint,preview_fingerprint,baseline,actor
  ) returning * into created;
  return jsonb_build_object(
    'contractVersion','catalog-intelligence-campaign-v1','campaignId',created.id,
    'campaignKey',created.campaign_key,'status',created.status,
    'previewFingerprint',created.preview_fingerprint,'baseline',created.baseline,
    'options',created.options,'idempotentReplay',false
  );
end;
$function$;

create or replace function public.start_catalog_intelligence_campaign_v1(
  p_campaign_id uuid,
  p_preview_fingerprint text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  campaign public.catalog_intelligence_campaigns%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede iniciar una campaña de catálogo.';
  end if;
  select * into campaign from public.catalog_intelligence_campaigns current
  where current.id=p_campaign_id for update;
  if not found then
    raise exception using errcode='P0002', message='La campaña no existe.';
  end if;
  if campaign.preview_fingerprint<>coalesce(p_preview_fingerprint,'') then
    raise exception using errcode='40001', message='La confirmación no coincide con el preview de campaña.';
  end if;
  if campaign.status in ('running','succeeded') then
    return jsonb_build_object('campaignId',campaign.id,'status',campaign.status,
      'idempotentReplay',true);
  end if;
  if campaign.status<>'previewed' then
    raise exception using errcode='55000', message='La campaña ya no puede iniciarse.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-campaign:'||campaign.source_id::text,0));
  if public.catalog_intelligence_campaign_state_v1(campaign.source_id)<>campaign.state_fingerprint then
    raise exception using errcode='40001', message='El catálogo cambió desde el preview; genera una campaña nueva.';
  end if;
  update public.catalog_intelligence_campaigns set
    status='running',started_by=actor,started_at=now(),updated_at=now()
  where id=campaign.id returning * into campaign;
  return jsonb_build_object('campaignId',campaign.id,'status',campaign.status,
    'idempotentReplay',false);
end;
$function$;

create or replace function public.record_catalog_intelligence_campaign_event_v1(
  p_campaign_id uuid,
  p_step_code text,
  p_status text,
  p_result jsonb,
  p_error_detail jsonb,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  request_fingerprint text;
  existing public.catalog_intelligence_campaign_events%rowtype;
  created public.catalog_intelligence_campaign_events%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede registrar pasos de campaña.';
  end if;
  if p_step_code not in (
      'research_delta','semantic_certification','review_reprocess','relation_reprocess',
      'decisions_sync','controlled_expansion','graph_sync','graph_verify','readiness')
     or p_status not in ('succeeded','skipped','failed')
     or jsonb_typeof(coalesce(p_result,'{}'::jsonb))<>'object'
     or (p_status='failed') is distinct from (p_error_detail is not null)
     or nullif(trim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023', message='El evento de campaña no es válido.';
  end if;
  if not exists(select 1 from public.catalog_intelligence_campaigns campaign
      where campaign.id=p_campaign_id and campaign.status='running') then
    raise exception using errcode='55000', message='La campaña no está en ejecución.';
  end if;
  request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'campaignId',p_campaign_id,'step',p_step_code,'status',p_status,
    'result',coalesce(p_result,'{}'::jsonb),'error',p_error_detail
  )::text,'UTF8'),'sha256'),'hex');
  select * into existing from public.catalog_intelligence_campaign_events event
  where event.idempotency_key=p_idempotency_key;
  if found then
    if existing.request_fingerprint<>request_fingerprint then
      raise exception using errcode='23505', message='La clave del paso ya representa otro resultado.';
    end if;
    return jsonb_build_object('eventId',existing.id,'step',existing.step_code,
      'status',existing.status,'idempotentReplay',true);
  end if;
  insert into public.catalog_intelligence_campaign_events(
    campaign_id,step_code,status,idempotency_key,request_fingerprint,result,error_detail,actor_id
  ) values (
    p_campaign_id,p_step_code,p_status,p_idempotency_key,request_fingerprint,
    coalesce(p_result,'{}'::jsonb),p_error_detail,actor
  ) returning * into created;
  return jsonb_build_object('eventId',created.id,'step',created.step_code,
    'status',created.status,'idempotentReplay',false);
end;
$function$;

create or replace function public.complete_catalog_intelligence_campaign_v1(
  p_campaign_id uuid,
  p_result jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  campaign public.catalog_intelligence_campaigns%rowtype;
  final_snapshot jsonb;
  readiness jsonb;
  final_result jsonb;
  computed_final_fingerprint text;
  missing_steps integer;
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede cerrar una campaña.';
  end if;
  select * into campaign from public.catalog_intelligence_campaigns current
  where current.id=p_campaign_id for update;
  if not found then raise exception using errcode='P0002', message='La campaña no existe.'; end if;
  if campaign.status='succeeded' then
    return jsonb_build_object('campaignId',campaign.id,'status','succeeded',
      'finalFingerprint',campaign.final_fingerprint,'idempotentReplay',true);
  end if;
  if campaign.status<>'running' or jsonb_typeof(coalesce(p_result,'{}'::jsonb))<>'object' then
    raise exception using errcode='55000', message='La campaña no puede cerrarse en su estado actual.';
  end if;
  select count(*) into missing_steps from (values
    ('research_delta'),('semantic_certification'),('review_reprocess'),
    ('relation_reprocess'),('decisions_sync'),('controlled_expansion'),
    ('graph_sync'),('graph_verify'),('readiness')
  ) required(step_code)
  where not exists (
    select 1 from public.catalog_intelligence_campaign_events event
    where event.campaign_id=campaign.id and event.step_code=required.step_code
      and event.status in ('succeeded','skipped')
  );
  if missing_steps>0 then
    raise exception using errcode='55000', message='La campaña todavía tiene pasos obligatorios sin cerrar.';
  end if;
  if not coalesce((p_result->'graphVerification'->>'ok')::boolean,false) then
    raise exception using errcode='23514', message='La campaña no puede cerrar con divergencias en el grafo.';
  end if;
  final_snapshot := public.catalog_intelligence_campaign_snapshot_v1(campaign.source_id);
  if final_snapshot->>'commercialFingerprint'<>campaign.baseline->>'commercialFingerprint' then
    raise exception using errcode='23514', message='La campaña detectó un cambio comercial fuera de alcance.';
  end if;
  readiness := public.get_catalog_reference_commercial_readiness_v1(campaign.source_id);
  final_result := coalesce(p_result,'{}'::jsonb)||jsonb_build_object(
    'readiness',readiness,'finalSnapshot',final_snapshot,
    'guards',jsonb_build_object(
      'commercialFingerprintUnchanged',true,'humanDecisionsApplied',0,
      'productsPublished',0,'pricesAssigned',0,'stockAssigned',0,
      'canonicalFactsAutomaticallyCreated',0
    )
  );
  computed_final_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'campaignId',campaign.id,'result',final_result
  )::text,'UTF8'),'sha256'),'hex');
  update public.catalog_intelligence_campaigns set
    status='succeeded',result=final_result,error_detail=null,
    final_fingerprint=computed_final_fingerprint,finished_at=now(),updated_at=now()
  where id=campaign.id returning * into campaign;
  return jsonb_build_object('campaignId',campaign.id,'status','succeeded',
    'finalFingerprint',campaign.final_fingerprint,'readiness',readiness,
    'idempotentReplay',false);
end;
$function$;

create or replace function public.fail_catalog_intelligence_campaign_v1(
  p_campaign_id uuid,
  p_error_detail jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare actor uuid := coalesce(auth.uid(),p_actor_id);
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede cerrar una campaña fallida.';
  end if;
  if jsonb_typeof(p_error_detail)<>'object' then
    raise exception using errcode='22023', message='El error de campaña debe ser un objeto.';
  end if;
  update public.catalog_intelligence_campaigns set
    status='failed',error_detail=p_error_detail,finished_at=now(),updated_at=now()
  where id=p_campaign_id and status='running';
  if not found then
    raise exception using errcode='55000', message='La campaña no está en ejecución.';
  end if;
  return jsonb_build_object('campaignId',p_campaign_id,'status','failed');
end;
$function$;

create or replace function public.get_catalog_intelligence_campaign_report_v1(
  p_campaign_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with campaign as (
    select current.* from public.catalog_intelligence_campaigns current
    where p_campaign_id is null or current.id=p_campaign_id
    order by current.created_at desc limit 1
  ), events as (
    select event.* from public.catalog_intelligence_campaign_events event
    join campaign on campaign.id=event.campaign_id
    order by event.id
  ), owner_queue as (
    select count(*)::integer active_human_exceptions
    from public.catalog_review_operational_queue_v1 queue
    where queue.human_actionable and queue.status in ('open','in_progress')
  )
  select jsonb_build_object(
    'contractVersion','catalog-intelligence-campaign-v1',
    'campaignId',campaign.id,'campaignKey',campaign.campaign_key,
    'status',campaign.status,'sourceKey',source.source_key,'brand',brand.name,
    'createdAt',campaign.created_at,'startedAt',campaign.started_at,
    'finishedAt',campaign.finished_at,'previewFingerprint',campaign.preview_fingerprint,
    'finalFingerprint',campaign.final_fingerprint,'options',campaign.options,
    'steps',coalesce((select jsonb_agg(jsonb_build_object(
      'step',event.step_code,'status',event.status,'result',event.result,
      'error',event.error_detail,'createdAt',event.created_at
    ) order by event.id) from events event),'[]'::jsonb),
    'delta',coalesce(campaign.result->'delta','{}'::jsonb),
    'ownerSummary',jsonb_build_object(
      'newProductsReady',coalesce((campaign.result->'readiness'->'summary'->>'ready')::integer,0),
      'newProductsBlocked',coalesce((campaign.result->'readiness'->'summary'->>'blocked')::integer,0),
      'activeHumanExceptions',(select active_human_exceptions from owner_queue),
      'pendingRelationDecisions',(select count(*) from public.catalog_relation_decisions where status='pending')
    ),
    'readyForCommercialDecision',coalesce(campaign.result->'readiness'->'ready','[]'::jsonb),
    'blockedReadiness',coalesce(campaign.result->'readiness'->'blocked','[]'::jsonb),
    'guards',coalesce(campaign.result->'guards',jsonb_build_object(
      'commercialFingerprintUnchanged',campaign.baseline->>'commercialFingerprint'=
        public.catalog_intelligence_campaign_snapshot_v1(campaign.source_id)->>'commercialFingerprint',
      'humanDecisionsApplied',0,'productsPublished',0,'pricesAssigned',0,'stockAssigned',0
    )),
    'graphVerification',coalesce(campaign.result->'graphVerification','{}'::jsonb),
    'error',campaign.error_detail,
    'passes',campaign.status='succeeded'
      and (campaign.result->'guards'->>'commercialFingerprintUnchanged')::boolean
      and coalesce((campaign.result->'graphVerification'->>'ok')::boolean,false)
  )
  from campaign
  join public.catalog_sources source on source.id=campaign.source_id
  join public.brands brand on brand.id=campaign.brand_id;
$function$;

alter table public.catalog_intelligence_campaigns enable row level security;
alter table public.catalog_intelligence_campaign_events enable row level security;
create policy "admins read intelligence campaigns"
on public.catalog_intelligence_campaigns for select to authenticated using (public.is_admin());
create policy "admins read intelligence campaign events"
on public.catalog_intelligence_campaign_events for select to authenticated using (public.is_admin());

grant select on public.catalog_intelligence_campaigns,
  public.catalog_intelligence_campaign_events to authenticated,service_role;
revoke all on function public.get_catalog_reference_commercial_readiness_v1(uuid) from public,anon,authenticated;
revoke all on function public.catalog_intelligence_campaign_snapshot_v1(uuid) from public,anon,authenticated;
revoke all on function public.catalog_intelligence_campaign_state_v1(uuid) from public,anon,authenticated;
revoke all on function public.preview_catalog_intelligence_campaign_v1(text,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.start_catalog_intelligence_campaign_v1(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.record_catalog_intelligence_campaign_event_v1(uuid,text,text,jsonb,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.complete_catalog_intelligence_campaign_v1(uuid,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.fail_catalog_intelligence_campaign_v1(uuid,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.get_catalog_intelligence_campaign_report_v1(uuid) from public,anon;
grant execute on function public.get_catalog_reference_commercial_readiness_v1(uuid),
  public.catalog_intelligence_campaign_snapshot_v1(uuid),
  public.catalog_intelligence_campaign_state_v1(uuid),
  public.preview_catalog_intelligence_campaign_v1(text,text,jsonb,uuid),
  public.start_catalog_intelligence_campaign_v1(uuid,text,uuid),
  public.record_catalog_intelligence_campaign_event_v1(uuid,text,text,jsonb,jsonb,text,uuid),
  public.complete_catalog_intelligence_campaign_v1(uuid,jsonb,uuid),
  public.fail_catalog_intelligence_campaign_v1(uuid,jsonb,uuid)
to service_role;
grant execute on function public.get_catalog_intelligence_campaign_report_v1(uuid)
to authenticated,service_role;

commit;
