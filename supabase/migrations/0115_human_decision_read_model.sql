-- ---------------------------------------------------------------------------
-- 0115 · Casos humanos y contrato comercial de lectura
-- ---------------------------------------------------------------------------
-- Convierte el preview 4B en decisiones agrupadas por causa. No crea trabajos
-- por candidata, no aplica decisiones y no delega explicaciones al frontend.

begin;

alter table public.catalog_relation_endpoint_profiles
  add column display_name text;

update public.catalog_relation_endpoint_profiles
set display_name = case code
  when 'drill' then 'torno o drill de unas'
  when 'drill_bit' then 'broca o punta de drill'
  when 'gel_color' then 'color gel'
  when 'gel_base' then 'base gel'
  when 'gel_top' then 'top o finalizador gel'
  when 'lamp_uv_led' then 'lampara de curado UV/LED'
  when 'lash_extension' then 'extension profesional de pestanas'
  when 'lash_adhesive' then 'adhesivo profesional de pestanas'
  when 'lash_remover' then 'removedor profesional de pestanas'
  when 'polygel' then 'producto constructor polygel'
  when 'slip_solution' then 'solucion de deslizamiento para polygel'
  when 'soft_gel_tips' then 'tip soft gel'
  when 'nail_adhesive' then 'adhesivo para extension de unas'
  when 'wax' then 'cera depilatoria'
  when 'wax_warmer' then 'equipo para calentar cera'
end;

alter table public.catalog_relation_endpoint_profiles
  alter column display_name set not null,
  add constraint catalog_relation_endpoint_profiles_display_not_blank
    check (length(trim(display_name)) > 0);

create or replace view public.catalog_relation_decision_groups_v1
with (security_invoker = true) as
with latest as (
  select run.id, run.preview_fingerprint, run.snapshot_fingerprint,
    run.status, run.created_at
  from public.catalog_relation_reprocess_runs run
  where run.status in ('previewed', 'applied')
  order by run.created_at desc, run.id desc
  limit 1
), detected as (
  select
    item.*,
    latest.preview_fingerprint,
    latest.snapshot_fingerprint,
    latest.status as preview_status,
    case item.classification
      when 'CLASS_RELATION' then 'CLASS_RULE_PROMOTION'
      when 'CLASS_MEMBERSHIP' then 'ENDPOINT_SCOPE_RECLASSIFICATION'
      when 'REJECTED' then 'FALSE_PAIR_RETIREMENT'
    end as family_code,
    case item.classification
      when 'CLASS_RELATION' then
        'relation:' || (item.context_snapshot->'relation'->>'signature')
      when 'CLASS_MEMBERSHIP' then case
        when item.context_snapshot->'source'->>'match' <> 'MATCH'
          then 'source:' || (item.context_snapshot->'source'->>'expectedEndpoint')
        else 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint')
      end
      when 'REJECTED' then case
        when item.context_snapshot->'target'->>'match' = 'EXCLUDED'
          then 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint')
        when item.context_snapshot->'source'->>'match' <> 'MATCH'
          then 'source:' || (item.context_snapshot->'source'->>'expectedEndpoint')
        else 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint')
      end
    end as cause_key
  from public.catalog_relation_reprocess_items item
  join latest on latest.id = item.reprocess_run_id
  where item.classification in ('CLASS_RELATION', 'CLASS_MEMBERSHIP', 'REJECTED')
), grouped as (
  select
    detected.family_code,
    detected.cause_key,
    min(detected.preview_fingerprint) as preview_fingerprint,
    min(detected.snapshot_fingerprint) as snapshot_fingerprint,
    min(detected.preview_status) as preview_status,
    count(*)::integer as affected_count,
    count(distinct detected.source_snapshot->'source'->>'productId')::integer
      + count(distinct detected.source_snapshot->'target'->>'productId')::integer
      as affected_product_count,
    coalesce(jsonb_agg(distinct detected.candidate_rule_code)
      filter (where detected.candidate_rule_code is not null), '[]'::jsonb) as rule_codes,
    coalesce(jsonb_agg(distinct detected.relation_kind_code)
      filter (where detected.relation_kind_code is not null), '[]'::jsonb) as relation_kinds,
    coalesce(jsonb_agg(distinct detected.context_snapshot->>'authority')
      filter (where detected.context_snapshot->>'authority' is not null), '[]'::jsonb) as authorities,
    coalesce(jsonb_agg(distinct detected.source_snapshot->'evidence'->>'validation_required')
      filter (where detected.source_snapshot->'evidence'->>'validation_required' is not null),
      '[]'::jsonb) as evidence_requirements,
    min(detected.source_snapshot->'source'->>'name') as example_source,
    min(detected.source_snapshot->'target'->>'name') as example_target,
    min(detected.context_snapshot->'source'->>'expectedEndpoint') as source_endpoint_code,
    min(detected.context_snapshot->'target'->>'expectedEndpoint') as target_endpoint_code,
    min(detected.context_snapshot->'relation'->>'signature') as relation_signature,
    encode(extensions.digest(convert_to(string_agg(
      detected.item_fingerprint, E'\n' order by detected.item_fingerprint
    ), 'UTF8'), 'sha256'), 'hex') as affected_set_fingerprint
  from detected
  group by detected.family_code, detected.cause_key
)
select
  'stage4c:' || lower(grouped.family_code) || ':' || md5(grouped.cause_key) as group_key,
  grouped.family_code,
  grouped.cause_key,
  grouped.preview_fingerprint,
  grouped.snapshot_fingerprint,
  grouped.preview_status,
  grouped.affected_count,
  grouped.affected_product_count,
  grouped.rule_codes,
  grouped.relation_kinds,
  grouped.authorities,
  grouped.evidence_requirements,
  grouped.example_source,
  grouped.example_target,
  grouped.source_endpoint_code,
  source_endpoint.display_name as source_endpoint_name,
  grouped.target_endpoint_code,
  target_endpoint.display_name as target_endpoint_name,
  grouped.relation_signature,
  grouped.affected_set_fingerprint,
  encode(extensions.digest(convert_to(concat_ws('|',
    grouped.preview_fingerprint, grouped.family_code, grouped.cause_key,
    grouped.affected_set_fingerprint
  ), 'UTF8'), 'sha256'), 'hex') as fingerprint
from grouped
left join public.catalog_relation_endpoint_profiles source_endpoint
  on source_endpoint.code = grouped.source_endpoint_code
left join public.catalog_relation_endpoint_profiles target_endpoint
  on target_endpoint.code = grouped.target_endpoint_code;

create or replace view public.catalog_decision_read_model_v1
with (security_invoker = true) as
select
  'decision:' || substr(decision.fingerprint, 1, 32) as decision_id,
  decision.family_code,
  decision.group_key,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Validar una regla compartida entre ' || decision.source_endpoint_name
        || ' y ' || decision.target_endpoint_name
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'Corregir el alcance compartido de ' || coalesce(
        case when decision.cause_key like 'source:%' then decision.source_endpoint_name
          else decision.target_endpoint_name end,
        replace(split_part(decision.cause_key, ':', 2), '_', ' ')
      )
    else
      'Retirar falsos pares asociados a ' || coalesce(
        case when decision.cause_key like 'source:%' then decision.source_endpoint_name
          else decision.target_endpoint_name end,
        replace(split_part(decision.cause_key, ':', 2), '_', ' ')
      )
  end as title,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      decision.affected_count || ' relaciones historicas pueden expresarse mediante una sola regla entre clases.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      decision.affected_count || ' pares mezclan productos de otra funcion; las membresias utiles pueden conservarse sin afirmar el par.'
    else
      decision.affected_count || ' pares contradicen el significado funcional del extremo esperado y no deben promoverse en bloque.'
  end as business_summary,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'El motor encontro el mismo patron de proceso repetido en varios productos y lo comprimio como ' || decision.relation_signature || '.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'La regla historica alcanzo sujetos que no pertenecen al extremo esperado, aunque varios si expresan otra clase reconocible.'
    else
      'Uno de los extremos cae en una exclusion semantica explicita; por ejemplo «' || decision.example_source || '» → «' || decision.example_target || '».'
  end as what_was_found,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Aceptar la regla cambiaria muchas relaciones directas por una inferencia compartida. La promocion de conocimiento necesita una decision explicita.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'Reinterpretar una relacion como membresia cambia su significado historico y el alcance futuro de la regla; el sistema no debe decidirlo solo.'
    else
      'Retirar en conjunto candidatas historicas es una decision semantica material. La exclusion fue detectada automaticamente, pero no puede aplicarse sin criterio humano.'
  end as why_human_is_needed,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Revisar la firma propuesta una vez y, si representa el proceso real, aceptar la regla de clase manteniendola como inferencia no canonica.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'Aceptar solo las membresias observadas y ajustar el perfil compartido; no promover ninguna relacion producto-producto.'
    else
      'Confirmar la exclusion compartida y retirar los falsos pares del conjunto promovible sin borrar su historia.'
  end as system_recommendation,
  decision.affected_count,
  decision.affected_product_count,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then jsonb_build_array('relation_candidate','product','class_relation')
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then jsonb_build_array('relation_candidate','product','class_membership')
    else jsonb_build_array('relation_candidate','product','endpoint_profile')
  end as affected_entity_types,
  jsonb_build_object(
    'previewFingerprint', decision.preview_fingerprint,
    'snapshotFingerprint', decision.snapshot_fingerprint,
    'affectedSetFingerprint', decision.affected_set_fingerprint,
    'authorityLevels', decision.authorities,
    'validationRequirements', decision.evidence_requirements,
    'ruleCodes', decision.rule_codes,
    'relationKinds', decision.relation_kinds,
    'example', jsonb_build_object(
      'source', decision.example_source,
      'target', decision.example_target
    )
  ) as evidence_summary,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then jsonb_build_object(
      'candidateRelationsAffected', decision.affected_count,
      'classRelationsProposed', 1,
      'directPairRelationsPromoted', 0,
      'canonicalFactsCreated', 0,
      'commercialEffects', 0
    )
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then jsonb_build_object(
      'candidateRelationsAffected', decision.affected_count,
      'membershipScopeChangesProposed', decision.affected_count,
      'pairRelationsPromoted', 0,
      'canonicalFactsCreated', 0,
      'commercialEffects', 0
    )
    else jsonb_build_object(
      'candidateRelationsAffected', decision.affected_count,
      'candidateStatusChangesIfAccepted', decision.affected_count,
      'historyDeleted', 0,
      'canonicalFactsCreated', 0,
      'commercialEffects', 0
    )
  end as impact_preview,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then jsonb_build_array(
      jsonb_build_object('code','ACCEPT_CLASS_RULE','label','Aceptar regla de clase',
        'effect','Prepara una inferencia compartida; no crea un hecho canonico.'),
      jsonb_build_object('code','KEEP_DEFERRED','label','Mantener pendiente',
        'effect','Conserva todas las candidatas sin cambio.'),
      jsonb_build_object('code','REJECT_CLASS_RULE','label','Rechazar regla de clase',
        'effect','Descarta la promocion propuesta y conserva la historia.')
    )
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then jsonb_build_array(
      jsonb_build_object('code','ACCEPT_MEMBERSHIP_SCOPE','label','Aceptar membresias',
        'effect','Conserva clases observadas sin afirmar relaciones entre productos.'),
      jsonb_build_object('code','ADJUST_ENDPOINT_PROFILE','label','Ajustar alcance',
        'effect','Solicita corregir la regla compartida antes de un nuevo preview.'),
      jsonb_build_object('code','KEEP_DEFERRED','label','Mantener pendiente',
        'effect','No cambia candidatas ni conocimiento.')
    )
    else jsonb_build_array(
      jsonb_build_object('code','ACCEPT_FALSE_PAIR_RETIREMENT','label','Retirar falsos pares',
        'effect','Los excluye del conjunto promovible sin borrar historia.'),
      jsonb_build_object('code','ADJUST_ENDPOINT_PROFILE','label','Corregir perfil',
        'effect','Modifica la causa compartida y exige generar otro preview.'),
      jsonb_build_object('code','KEEP_DEFERRED','label','Mantener pendiente',
        'effect','No cambia candidatas ni conocimiento.')
    )
  end as available_actions,
  case when jsonb_array_length(decision.rule_codes) = 1
    then decision.rule_codes->>0 else null end as rule_code,
  decision.rule_codes,
  decision.fingerprint,
  decision.preview_status,
  false as decision_applied,
  false as canonical_promotion,
  false as commercial_effect
from public.catalog_relation_decision_groups_v1 decision;

create or replace function public.get_catalog_decision_queue_v1(
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare result jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100
     or p_offset is null or p_offset < 0 then
    raise exception using errcode = '22023', message = 'Limit debe estar entre 1 y 100 y offset no puede ser negativo.';
  end if;

  select jsonb_build_object(
    'contractVersion', 'stage4c-v1',
    'total', (select count(*)::integer from public.catalog_decision_read_model_v1),
    'limit', p_limit,
    'offset', p_offset,
    'decisions', coalesce((
      select jsonb_agg(to_jsonb(page) order by page.family_code, page.affected_count desc, page.decision_id)
      from (
        select * from public.catalog_decision_read_model_v1 decision
        order by decision.family_code, decision.affected_count desc, decision.decision_id
        limit p_limit offset p_offset
      ) page
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

create or replace function public.get_catalog_stage4c_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with decisions as (
    select * from public.catalog_decision_read_model_v1
  ), family_counts as (
    select coalesce(jsonb_object_agg(family_code, total order by family_code), '{}'::jsonb) as value
    from (
      select family_code, count(*)::integer as total
      from decisions group by family_code
    ) grouped
  ), totals as (
    select
      count(*)::integer as decision_count,
      count(distinct family_code)::integer as family_count,
      coalesce(sum(affected_count), 0)::integer as affected_detections,
      coalesce(sum(affected_product_count), 0)::integer as affected_products
    from decisions
  )
  select jsonb_build_object(
    'contractVersion', 'stage4c-v1',
    'stage4Authorized', false,
    'families', family_counts.value,
    'metrics', jsonb_build_object(
      'familyCount', totals.family_count,
      'decisionCount', totals.decision_count,
      'affectedDetections', totals.affected_detections,
      'affectedProductsAcrossDecisions', totals.affected_products,
      'individualReviewAvoided', case when totals.affected_detections = 0 then 0
        else round(1 - totals.decision_count::numeric / totals.affected_detections, 4) end,
      'automaticEvidenceDebtExcluded', (
        select count(*)::integer
        from public.catalog_relation_reprocess_items item
        join public.catalog_relation_reprocess_runs run on run.id = item.reprocess_run_id
        where run.id = (select id from public.catalog_relation_reprocess_runs
          where status in ('previewed','applied') order by created_at desc, id desc limit 1)
          and item.classification = 'NEEDS_EVIDENCE'
      )
    ),
    'guards', jsonb_build_object(
      'oneDecisionPerSharedCause', true,
      'reactInterpretsRuleCode', false,
      'humanWorkPerCandidateCreated', (
        select count(*)::integer from public.catalog_review_work_items item
        where item.context->>'decisionReadModelOrigin' = 'stage4c'
      ),
      'canonicalFactsCreated', (
        select count(*)::integer from public.catalog_semantic_claims claim
        where claim.claim_key like 'stage4c:%' and claim.epistemic_class = 'CANONICAL_FACT'
      ),
      'decisionApplied', false,
      'commercialEffects', 0,
      'priceChanged', false,
      'stockChanged', false,
      'publicationChanged', false
    )
  )
  from totals cross join family_counts;
$function$;

grant select on public.catalog_relation_decision_groups_v1,
  public.catalog_decision_read_model_v1 to authenticated, service_role;
revoke execute on function public.get_catalog_decision_queue_v1(integer,integer)
from public, anon;
revoke execute on function public.get_catalog_stage4c_report_v1()
from public, anon;
grant execute on function public.get_catalog_decision_queue_v1(integer,integer),
  public.get_catalog_stage4c_report_v1() to authenticated, service_role;

comment on view public.catalog_decision_read_model_v1 is
  'Contrato comercial listo para frontend: el backend explica hallazgo, criterio humano, recomendacion, evidencia, afectados, impacto y acciones.';
comment on function public.get_catalog_decision_queue_v1(integer,integer) is
  'Pagina decisiones humanas agrupadas; no aplica acciones ni interpreta reglas en React.';

commit;
