-- ---------------------------------------------------------------------------
-- 0116 · Contrato de decision y apply exacto para relaciones agrupadas
-- ---------------------------------------------------------------------------
-- Integra las 18 decisiones 4C con la Mesa existente. El backend congela el
-- detalle, genera un preview de mutaciones, exige la misma huella al aplicar,
-- conserva comentarios/aplazamientos y nunca produce efectos comerciales.

begin;

-- La Mesa sigue siendo unica. Las decisiones agrupadas son un nuevo origen y
-- su sujeto es la regla compartida, nunca cada producto afectado.
alter table public.catalog_review_work_items
  drop constraint catalog_review_source_type_allowed,
  add constraint catalog_review_source_type_allowed check (source_type in (
    'reconciliation_case', 'enrichment_exception', 'relation_candidate',
    'knowledge_gap', 'relation_decision', 'manual'
  )),
  drop constraint catalog_review_subject_type_allowed,
  add constraint catalog_review_subject_type_allowed check (subject_type in (
    'product', 'variant', 'shade', 'brand', 'class', 'system', 'rule',
    'relation', 'source_record', 'other'
  ));

create or replace function public.catalog_relation_human_endpoint_v1(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path=''
as $function$
  select case p_value
    when 'adhesivo para extension de unas' then 'adhesivo para extensión de uñas'
    when 'adhesivo profesional de pestanas' then 'adhesivo profesional de pestañas'
    when 'extension profesional de pestanas' then 'extensión profesional de pestañas'
    when 'lampara de curado UV/LED' then 'lámpara de curado UV/LED'
    when 'removedor profesional de pestanas' then 'removedor profesional de pestañas'
    when 'solucion de deslizamiento para polygel' then 'solución de deslizamiento para polygel'
    when 'torno o drill de unas' then 'torno o drill de uñas'
    else p_value
  end;
$function$;

create or replace view public.catalog_decision_read_model_v2
with (security_invoker = true) as
select
  decision.*,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      case when decision.affected_count=1
        then 'Una relación podría convertirse en regla'
        else 'La misma relación se repite ' || decision.affected_count || ' veces' end
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'La relación está definida en el nivel equivocado'
    else
      case when decision.affected_count=1
        then 'Hay una asociación que no corresponde'
        else 'Hay productos que no deberían estar en este grupo' end
  end as product_title,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Los productos de ' || public.catalog_relation_human_endpoint_v1(grouped.source_endpoint_name)
        || ' están vinculados por separado con '
        || public.catalog_relation_human_endpoint_v1(grouped.target_endpoint_name)
        || ', aunque todos siguen el mismo patrón.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      case when decision.affected_count=1
        then 'Una relación está guardada entre productos, pero describe cómo se conectan sus tipos.'
        else decision.affected_count || ' relaciones están repetidas entre productos, pero describen cómo se conectan sus tipos.' end
    else
      case when decision.affected_count=1
        then 'Una asociación incluye un producto con una función distinta.'
        else decision.affected_count || ' asociaciones incluyen productos con una función distinta.' end
  end as problem,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Reunir esas relaciones en una regla para '
        || public.catalog_relation_human_endpoint_v1(grouped.source_endpoint_name) || ' y '
        || public.catalog_relation_human_endpoint_v1(grouped.target_endpoint_name)
        || ', solo con productos cuyo tipo ya está confirmado.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'Confirmar los productos bien clasificados y guardar la relación entre sus tipos, sin crear pares nuevos.'
    else
      'Retirar únicamente las asociaciones cuyo tipo incorrecto ya está confirmado.'
  end as recommendation_text,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      'Así, un producto nuevo podrá recibir la relación correcta al confirmar su tipo, sin revisar cada par por separado.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'El catálogo podrá ubicar cada producto confirmado en el alcance correcto sin duplicar relaciones.'
    else
      'Los accesorios dejarán de aparecer como equipos o componentes compatibles, sin borrar el historial.'
  end as solves,
  case decision.family_code
    when 'FALSE_PAIR_RETIREMENT' then
      'Si la función no está clara, ese producto queda pendiente y la asociación no se retira.'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      'Si el tipo no está claro, ese producto queda pendiente: no entra al grupo ni recibe el cambio.'
    else
      'Si el tipo no está claro, ese producto queda pendiente: no entra al grupo ni hereda la regla.'
  end as uncertain_behavior,
  'No cambia precio, stock ni publicación.'::text as unchanged_business_effects,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then
      '¿Quieres convertir estas relaciones en una regla solo para los productos confirmados?'
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then
      '¿Quieres confirmar estos productos y corregir el nivel de la relación?'
    else
      '¿Quieres retirar únicamente las asociaciones confirmadas en este caso?'
  end as decision_question,
  case decision.family_code
    when 'CLASS_RULE_PROMOTION' then jsonb_build_array(
      jsonb_build_object('code','ACCEPT_CLASS_RULE','label','Sí, convertirlas en una regla',
        'effect','Aplica la regla solo a los productos confirmados de este caso.',
        'requiresComment',false,'requiresPreview',true),
      jsonb_build_object('code','REJECT_CLASS_RULE','label','No crear esta regla',
        'effect','Cierra esta propuesta y conserva las relaciones actuales para futuras revisiones.',
        'requiresComment',true,'requiresPreview',true),
      jsonb_build_object('code','KEEP_DEFERRED','label','Anotar y guardar pendiente',
        'effect','Conserva el caso abierto con una nota y fecha para volver.',
        'requiresComment',true,'requiresPreview',false)
    )
    when 'ENDPOINT_SCOPE_RECLASSIFICATION' then jsonb_build_array(
      jsonb_build_object('code','ACCEPT_MEMBERSHIP_SCOPE','label','Sí, corregir el nivel',
        'effect','Confirma los productos del caso y guarda la relación en el nivel de sus tipos.',
        'requiresComment',false,'requiresPreview',true),
      jsonb_build_object('code','ADJUST_ENDPOINT_PROFILE','label','Quiero corregir la propuesta',
        'effect','Guarda tu comentario para preparar una propuesta corregida.',
        'requiresComment',true,'requiresPreview',true),
      jsonb_build_object('code','KEEP_DEFERRED','label','Anotar y guardar pendiente',
        'effect','Conserva el caso abierto con una nota y fecha para volver.',
        'requiresComment',true,'requiresPreview',false)
    )
    else jsonb_build_array(
      jsonb_build_object('code','ACCEPT_FALSE_PAIR_RETIREMENT','label','Sí, retirar las asociaciones confirmadas',
        'effect','Dejan de considerarse posibles relaciones; el historial permanece.',
        'requiresComment',false,'requiresPreview',true),
      jsonb_build_object('code','ADJUST_ENDPOINT_PROFILE','label','Quiero corregir la propuesta',
        'effect','Guarda tu comentario para preparar una propuesta corregida.',
        'requiresComment',true,'requiresPreview',true),
      jsonb_build_object('code','KEEP_DEFERRED','label','Anotar y guardar pendiente',
        'effect','Conserva el caso abierto con una nota y fecha para volver.',
        'requiresComment',true,'requiresPreview',false)
    )
  end as product_actions
from public.catalog_decision_read_model_v1 decision
join public.catalog_relation_decision_groups_v1 grouped
  on grouped.group_key = decision.group_key;

-- La expresion anterior conserva compatibilidad con 4C; los nombres reales
-- provienen del grupo porque evidence_summary v1 no exponia los endpoints.
create or replace view public.catalog_decision_product_v1
with (security_invoker = true) as
select
  decision.decision_id,
  decision.family_code,
  decision.group_key,
  decision.title,
  decision.business_summary,
  decision.what_was_found,
  decision.why_human_is_needed,
  decision.system_recommendation,
  decision.affected_count,
  decision.affected_product_count,
  decision.affected_entity_types,
  decision.evidence_summary,
  decision.impact_preview,
  decision.rule_code,
  decision.rule_codes,
  decision.fingerprint,
  decision.preview_status,
  product.product_title,
  product.problem,
  product.recommendation_text,
  product.solves,
  product.uncertain_behavior,
  product.unchanged_business_effects,
  product.decision_question,
  product.product_actions
from public.catalog_decision_read_model_v1 decision
join public.catalog_decision_read_model_v2 product on product.decision_id = decision.decision_id;

create or replace view public.catalog_relation_decision_item_source_v1
with (security_invoker = true) as
with latest as (
  select run.id
  from public.catalog_relation_reprocess_runs run
  where run.status in ('previewed','applied')
  order by run.created_at desc, run.id desc limit 1
), detected as (
  select item.*,
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
        else 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint') end
      when 'REJECTED' then case
        when item.context_snapshot->'target'->>'match' = 'EXCLUDED'
          then 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint')
        when item.context_snapshot->'source'->>'match' <> 'MATCH'
          then 'source:' || (item.context_snapshot->'source'->>'expectedEndpoint')
        else 'target:' || (item.context_snapshot->'target'->>'expectedEndpoint') end
    end as cause_key
  from public.catalog_relation_reprocess_items item
  join latest on latest.id = item.reprocess_run_id
  where item.classification in ('CLASS_RELATION','CLASS_MEMBERSHIP','REJECTED')
)
select detected.*,
  'stage4c:' || lower(detected.family_code) || ':' || md5(detected.cause_key) as group_key
from detected;

create table public.catalog_relation_decisions (
  id uuid primary key default gen_random_uuid(),
  decision_key text not null,
  public_decision_id text not null unique,
  group_key text not null,
  family_code text not null,
  source_reprocess_run_id uuid not null references public.catalog_relation_reprocess_runs(id) on delete restrict,
  work_item_id uuid unique references public.catalog_review_work_items(id) on delete restrict,
  status text not null default 'pending',
  decision_fingerprint text not null,
  affected_set_fingerprint text not null,
  source_preview_fingerprint text not null,
  source_snapshot_fingerprint text not null,
  read_model jsonb not null,
  resolved_action text,
  resolution_comment text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (decision_key, decision_fingerprint),
  constraint catalog_relation_decisions_key_not_blank check (length(trim(decision_key)) > 0),
  constraint catalog_relation_decisions_group_not_blank check (length(trim(group_key)) > 0),
  constraint catalog_relation_decisions_family_allowed check (family_code in (
    'CLASS_RULE_PROMOTION','ENDPOINT_SCOPE_RECLASSIFICATION','FALSE_PAIR_RETIREMENT'
  )),
  constraint catalog_relation_decisions_status_allowed check (status in (
    'pending','applied','rejected','adjustment_requested','superseded'
  )),
  constraint catalog_relation_decisions_fingerprints check (
    length(decision_fingerprint)=64 and length(affected_set_fingerprint)=64
    and length(source_preview_fingerprint)=64 and length(source_snapshot_fingerprint)=64
  ),
  constraint catalog_relation_decisions_read_model_object check (jsonb_typeof(read_model)='object'),
  constraint catalog_relation_decisions_resolution_consistent check (
    (status='pending' and resolved_action is null and resolved_at is null)
    or (status='superseded' and resolved_at is not null)
    or (status in ('applied','rejected','adjustment_requested')
      and resolved_action is not null and resolved_at is not null)
  )
);

create unique index catalog_relation_decisions_active_key_idx
  on public.catalog_relation_decisions(decision_key) where status='pending';
create index catalog_relation_decisions_queue_idx
  on public.catalog_relation_decisions(status, family_code, created_at);

create table public.catalog_relation_decision_items (
  decision_id uuid not null references public.catalog_relation_decisions(id) on delete restrict,
  reprocess_item_id bigint not null references public.catalog_relation_reprocess_items(id) on delete restrict,
  candidate_id uuid not null references public.catalog_relation_candidates(id) on delete restrict,
  ordinal integer not null,
  classification text not null,
  item_fingerprint text not null,
  source_snapshot jsonb not null,
  context_snapshot jsonb not null,
  proposed_resolution jsonb not null,
  explanation jsonb not null,
  primary key (decision_id, reprocess_item_id),
  unique (decision_id, ordinal),
  constraint catalog_relation_decision_items_ordinal_positive check (ordinal > 0),
  constraint catalog_relation_decision_items_fingerprint check (length(item_fingerprint)=64),
  constraint catalog_relation_decision_items_json_objects check (
    jsonb_typeof(source_snapshot)='object' and jsonb_typeof(context_snapshot)='object'
    and jsonb_typeof(proposed_resolution)='object' and jsonb_typeof(explanation)='object'
  )
);

create table public.catalog_relation_decision_previews (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.catalog_relation_decisions(id) on delete restrict,
  work_item_id uuid not null references public.catalog_review_work_items(id) on delete restrict,
  status text not null default 'previewed',
  action_code text not null,
  decision_comment text,
  expected_work_version bigint not null,
  decision_fingerprint text not null,
  state_fingerprint text not null,
  mutation_plan jsonb not null,
  preview_fingerprint text not null unique,
  preview_idempotency_key text not null unique,
  preview_request_fingerprint text not null,
  application_idempotency_key text unique,
  created_by uuid references auth.users(id) on delete set null,
  applied_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint catalog_relation_decision_previews_status_allowed check (
    status in ('previewed','applied','expired','cancelled')
  ),
  constraint catalog_relation_decision_previews_action_not_blank check (length(trim(action_code)) > 0),
  constraint catalog_relation_decision_previews_comment_not_blank check (
    decision_comment is null or length(trim(decision_comment)) > 0
  ),
  constraint catalog_relation_decision_previews_version_positive check (expected_work_version > 0),
  constraint catalog_relation_decision_previews_fingerprints check (
    length(decision_fingerprint)=64 and length(state_fingerprint)=64
    and length(preview_fingerprint)=64 and length(preview_request_fingerprint)>=16
  ),
  constraint catalog_relation_decision_previews_plan_object check (jsonb_typeof(mutation_plan)='object'),
  constraint catalog_relation_decision_previews_apply_consistent check (
    (status='applied' and applied_at is not null and application_idempotency_key is not null)
    or (status<>'applied' and applied_at is null)
  )
);

create index catalog_relation_decision_previews_decision_idx
  on public.catalog_relation_decision_previews(decision_id, created_at desc);

create or replace function public.prevent_catalog_relation_decision_item_mutation()
returns trigger language plpgsql set search_path='' as $function$
begin
  raise exception using errcode='55000',
    message='Los elementos congelados de una decision no se pueden reescribir.';
end;
$function$;

-- Cola de producto: une la explicacion humana de 4D con el estado operativo
-- real de la Mesa. React recibe texto y acciones; no interpreta rule_code.
create or replace view public.catalog_relation_decision_queue_v1
with (security_invoker = true) as
select
  decision.public_decision_id as decision_id,
  decision.family_code,
  decision.status as decision_status,
  decision.read_model->>'product_title' as title,
  decision.read_model->>'problem' as problem,
  decision.read_model->>'recommendation_text' as recommendation,
  decision.read_model->>'solves' as solves,
  decision.read_model->>'uncertain_behavior' as uncertain_behavior,
  decision.read_model->>'unchanged_business_effects' as unchanged_business_effects,
  decision.read_model->>'decision_question' as decision_question,
  coalesce(decision.read_model->'product_actions','[]'::jsonb) as actions,
  (decision.read_model->>'affected_count')::integer as affected_count,
  (decision.read_model->>'affected_product_count')::integer as affected_product_count,
  decision.read_model->'evidence_summary' as evidence_summary,
  decision.read_model->'impact_preview' as impact_preview,
  decision.decision_fingerprint,
  work.id as work_item_id,
  work.work_key,
  work.status as work_status,
  work.row_version as work_version,
  operational.queue_state,
  operational.can_resolve_now,
  operational.is_deferred,
  work.defer_reason,
  work.deferred_until,
  decision.created_at,
  decision.resolved_action,
  decision.resolution_comment,
  decision.resolved_by,
  decision.resolved_at
from public.catalog_relation_decisions decision
join public.catalog_review_work_items work on work.id=decision.work_item_id
join public.catalog_review_operational_queue_v1 operational on operational.id=work.id;

create or replace function public.get_catalog_relation_decision_queue_v1(
  p_status text default 'pending',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare result jsonb;
begin
  if p_status not in ('pending','applied','rejected','adjustment_requested','superseded','all')
     or p_limit is null or p_limit<1 or p_limit>100
     or p_offset is null or p_offset<0 then
    raise exception using errcode='22023', message='Los filtros de la cola no son validos.';
  end if;
  select jsonb_build_object(
    'contractVersion','stage4e-v1','status',p_status,
    'total',(select count(*)::integer
      from public.catalog_relation_decision_queue_v1 queue
      where p_status='all' or queue.decision_status=p_status),
    'pending',(select count(*)::integer
      from public.catalog_relation_decision_queue_v1 queue
      where queue.decision_status='pending'),
    'deferred',(select count(*)::integer
      from public.catalog_relation_decision_queue_v1 queue
      where queue.decision_status='pending' and queue.is_deferred),
    'limit',p_limit,'offset',p_offset,
    'decisions',coalesce((
      select jsonb_agg(to_jsonb(page) order by page.is_deferred,
        page.affected_count desc,page.decision_id)
      from (
        select * from public.catalog_relation_decision_queue_v1 queue
        where p_status='all' or queue.decision_status=p_status
        order by queue.is_deferred,queue.affected_count desc,queue.decision_id
        limit p_limit offset p_offset
      ) page
    ),'[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

create or replace function public.get_catalog_relation_decision_detail_v1(
  p_decision_id text,
  p_item_limit integer default 25,
  p_item_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  decision public.catalog_relation_decisions%rowtype;
  queue_row public.catalog_relation_decision_queue_v1%rowtype;
  result jsonb;
begin
  if nullif(trim(coalesce(p_decision_id,'')),'') is null
     or p_item_limit is null or p_item_limit<1 or p_item_limit>100
     or p_item_offset is null or p_item_offset<0 then
    raise exception using errcode='22023', message='La consulta de detalle no es valida.';
  end if;
  select * into decision from public.catalog_relation_decisions current
  where current.public_decision_id=p_decision_id;
  if not found then
    raise exception using errcode='P0002', message='La decision no existe.';
  end if;
  select * into queue_row from public.catalog_relation_decision_queue_v1 queue
  where queue.decision_id=p_decision_id;

  select jsonb_build_object(
    'contractVersion','stage4e-v1','decision',to_jsonb(queue_row),
    'affectedTotal',(select count(*)::integer
      from public.catalog_relation_decision_items item
      where item.decision_id=decision.id),
    'itemLimit',p_item_limit,'itemOffset',p_item_offset,
    'affected',coalesce((
      select jsonb_agg(jsonb_build_object(
        'position',page.ordinal,
        'candidateId',page.candidate_id,
        'sourceProduct',jsonb_build_object(
          'id',page.source_snapshot->'source'->>'productId',
          'name',page.source_snapshot->'source'->>'name',
          'type',page.source_snapshot->'source'->>'productType'
        ),
        'targetProduct',jsonb_build_object(
          'id',page.source_snapshot->'target'->>'productId',
          'name',page.source_snapshot->'target'->>'name',
          'type',page.source_snapshot->'target'->>'productType'
        ),
        'currentStatus',page.candidate_status,
        'proposal',page.proposed_resolution,
        'needsTypeConfirmation',page.context_snapshot->>'authority' in (
          'HEURISTIC_ONLY','OFFICIAL_LABEL_UNLINKED'
        ),
        'evidenceLabel',case page.context_snapshot->>'authority'
          when 'EXPLICIT_PAIR_EVIDENCE' then 'Hay una declaración directa para esta asociación.'
          when 'SOURCE_RECORD_DECLARED' then 'Hay una fuente registrada que respalda este caso.'
          when 'OFFICIAL_LABEL_UNLINKED' then 'La marca parece indicarlo, pero falta vincular la ficha exacta.'
          else 'Lo identificamos por el nombre y el contexto; conviene confirmar el tipo del producto.'
        end,
        'audit',jsonb_build_object(
          'itemFingerprint',page.item_fingerprint,
          'context',page.context_snapshot,
          'explanation',page.explanation
        )
      ) order by page.ordinal)
      from (
        select item.*,candidate.status as candidate_status
        from public.catalog_relation_decision_items item
        join public.catalog_relation_candidates candidate on candidate.id=item.candidate_id
        where item.decision_id=decision.id
        order by item.ordinal limit p_item_limit offset p_item_offset
      ) page
    ),'[]'::jsonb),
    'history',coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType',event.event_type,'actionCode',event.action_code,
        'actorLabel',event.actor_label,'payload',event.payload,
        'occurredAt',event.occurred_at
      ) order by event.occurred_at,event.id)
      from public.catalog_review_events event
      where event.work_item_id=decision.work_item_id
    ),'[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

-- Verificacion posterior separada: permite que el adaptador sincronice Neo4j
-- entre apply y verify sin que React encadene actualizaciones directas.
create or replace function public.verify_catalog_relation_decision_v1(
  p_decision_id text
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with selected as (
    select decision.* from public.catalog_relation_decisions decision
    where decision.public_decision_id=p_decision_id
  ), checks as (
    select
      exists(select 1 from selected where status in (
        'applied','rejected','adjustment_requested'
      )) as decision_resolved,
      exists(select 1 from selected decision
        join public.catalog_review_work_items work on work.id=decision.work_item_id
        where work.status='resolved') as work_resolved,
      exists(select 1 from selected decision
        join public.catalog_relation_decision_previews preview
          on preview.decision_id=decision.id and preview.status='applied') as preview_applied,
      exists(select 1 from selected decision
        join public.catalog_review_events event on event.work_item_id=decision.work_item_id
        where event.event_type='decision_taken'
          and event.action_code=decision.resolved_action) as audit_recorded,
      not exists(select 1 from selected decision
        join public.catalog_relation_rules rule
          on rule.metadata->>'stage4eDecisionId'=decision.public_decision_id
        join public.graph_edges_v2 edge
          on edge.edge_key='relation-rule:' || rule.id::text
        where edge.layer<>'evidence') as no_stage4e_rule_is_canonical,
      not exists(select 1 from selected decision
        join public.catalog_class_members member
          on member.metadata->>'stage4eDecisionId'=decision.public_decision_id
          or coalesce(member.metadata->'stage4eDecisionIds','[]'::jsonb)
            ? decision.public_decision_id
        join public.graph_edges_v2 edge
          on edge.edge_key='class-member:' || member.id::text
        where edge.layer<>'evidence') as no_stage4e_membership_is_canonical
  )
  select jsonb_build_object(
    'contractVersion','stage4e-v1','decisionId',p_decision_id,
    'passed',decision_resolved and work_resolved and preview_applied
      and audit_recorded and no_stage4e_rule_is_canonical
      and no_stage4e_membership_is_canonical,
    'checks',to_jsonb(checks),
    'commercialEffects',0,'priceChanged',false,'stockChanged',false,
    'publicationChanged',false,'canonicalFactsCreated',0
  ) from checks;
$function$;

create or replace function public.get_catalog_stage4e_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with totals as (
    select
      count(*)::integer as decisions,
      count(*) filter(where decision.status='pending')::integer as pending,
      count(*) filter(where decision.status in (
        'applied','rejected','adjustment_requested'
      ))::integer as resolved,
      count(distinct decision.work_item_id)::integer as work_items
    from public.catalog_relation_decisions decision
  )
  select jsonb_build_object(
    'contractVersion','stage4e-v1','stage4dClosed',true,
    'stage4eContractImplemented',true,
    'metrics',jsonb_build_object(
      'decisions',totals.decisions,'pending',totals.pending,
      'resolved',totals.resolved,'workItems',totals.work_items,
      'deferred',(select count(*)::integer
        from public.catalog_relation_decisions decision
        join public.catalog_review_work_items work on work.id=decision.work_item_id
        where decision.status='pending' and work.deferred_until>now()),
      'previews',(select count(*)::integer
        from public.catalog_relation_decision_previews),
      'appliedPreviews',(select count(*)::integer
        from public.catalog_relation_decision_previews where status='applied')
    ),
    'guards',jsonb_build_object(
      'oneWorkPerSharedDecision',totals.work_items=totals.decisions,
      'humanWorkPerCandidateCreated',0,
      'uncertainProductsInheritAutomatically',false,
      'deferResolvesDecision',false,
      'previewFingerprintRequired',true,
      'idempotencyRequired',true,
      'historyDeleted',0,'canonicalFactsCreated',0,'commercialEffects',0,
      'priceChanged',false,'stockChanged',false,'publicationChanged',false
    )
  ) from totals;
$function$;

-- El vocabulario universal ya permite PRECEDES y otros tipos sin equivalente
-- legado. La proyeccion usa relation_kind_code como predicado estable.
create or replace view public.graph_relation_edges_v1
with (security_invoker = true) as
select
  'product-relation:' || relation.id::text as edge_key,
  relation.source_ref as source_key,
  case when relation.relation_type='compatible_with'
      and relation.compatibility_status='not_compatible'
    then 'INCOMPATIBLE_WITH' else upper(relation.relation_type::text) end as predicate,
  relation.target_ref as target_key,
  jsonb_strip_nulls(jsonb_build_object(
    'assertionKind','specific_fact','compatibilityStatus',relation.compatibility_status,
    'sortOrder',relation.sort_order
  )) as properties
from public.product_relations relation
where relation.is_active and relation.knowledge_status='approved'
union all
select
  'relation-rule:' || rule.id::text,
  'class:' || rule.source_class_id::text,
  case when rule.relation_kind_code='COMPATIBLE_WITH'
      and rule.compatibility_status='not_compatible'
    then 'INCOMPATIBLE_WITH' else rule.relation_kind_code end,
  'class:' || rule.target_class_id::text,
  jsonb_strip_nulls(jsonb_build_object(
    'assertionKind','class_rule','ruleCode',rule.code,
    'relationKind',rule.relation_kind_code,
    'compatibilityStatus',rule.compatibility_status,'systemId',rule.system_id,
    'stageId',rule.stage_id,'requirementLevel',rule.requirement_level,
    'brandPolicy',rule.brand_policy,'epistemicState',rule.epistemic_state
  ))
from public.catalog_relation_rules rule
where rule.is_active and rule.decision_status='approved';

create or replace view public.graph_stage4e_knowledge_edges_v1
with (security_invoker = true) as
select
  'class-member:' || membership.id::text as edge_key,
  membership.knowledge_subject_ref as source_key,
  'MEMBER_OF'::text as predicate,
  'class:' || membership.class_id::text as target_key,
  'evidence'::text as layer,
  jsonb_build_object(
    'origin',membership.origin,'evidenceSetId',membership.evidence_set_id,
    'decisionId',membership.metadata->>'stage4eDecisionId',
    'decisionIds',coalesce(membership.metadata->'stage4eDecisionIds',
      jsonb_build_array(membership.metadata->>'stage4eDecisionId')),
    'epistemicState',membership.metadata->>'epistemicState',
    'confirmedOnlyForFrozenPreview',true
  ) as properties
from public.catalog_class_members membership
where membership.decision_status='approved'
  and (membership.metadata ? 'stage4eDecisionId'
    or membership.metadata ? 'stage4eDecisionIds')
union all
select
  'relation-rule:' || rule.id::text,
  'class:' || rule.source_class_id::text,
  rule.relation_kind_code,
  'class:' || rule.target_class_id::text,
  'evidence',
  jsonb_build_object(
    'assertionKind','class_rule','ruleCode',rule.code,
    'relationKind',rule.relation_kind_code,'evidenceSetId',rule.evidence_set_id,
    'decisionId',rule.metadata->>'stage4eDecisionId',
    'epistemicState',rule.epistemic_state,'canonicalPromotion',false
  )
from public.catalog_relation_rules rule
where rule.is_active and rule.decision_status='approved'
  and rule.metadata ? 'stage4eDecisionId';

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select edge.edge_key,edge.source_key,edge.predicate,edge.target_key,
  edge.layer,edge.properties,
  md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|'
    || edge.target_key || '|' || edge.layer || '|' || edge.properties::text)
    as projection_fingerprint
from (
  select base.* from public.graph_edges_v2_base base
  where base.edge_key not like 'reference-match:%'
    and not exists (
      select 1 from public.catalog_class_members membership
      where (membership.metadata ? 'stage4eDecisionId'
          or membership.metadata ? 'stage4eDecisionIds')
        and base.edge_key='class-member:' || membership.id::text
    )
    and not exists (
      select 1 from public.catalog_relation_rules rule
      where rule.metadata ? 'stage4eDecisionId'
        and base.edge_key='relation-rule:' || rule.id::text
    )
  union all select * from public.graph_stage4e_knowledge_edges_v1
  union all select * from public.graph_identity_case_edges_v1
  union all select * from public.graph_review_work_edges_v1
  union all select * from public.graph_semantic_term_edges_v1
  union all select * from public.graph_semantic_problem_group_edges_v1
  union all select * from public.graph_universal_semantic_edges_v1
  union all select * from public.graph_system_class_contract_edges_v1
) edge;

alter table public.catalog_relation_decisions enable row level security;
alter table public.catalog_relation_decision_items enable row level security;
alter table public.catalog_relation_decision_previews enable row level security;

create policy "admins read relation decisions" on public.catalog_relation_decisions
for select to authenticated using (public.is_admin());
create policy "admins read relation decision items" on public.catalog_relation_decision_items
for select to authenticated using (public.is_admin());
create policy "admins read relation decision previews" on public.catalog_relation_decision_previews
for select to authenticated using (public.is_admin());

grant select on public.catalog_decision_read_model_v2,
  public.catalog_decision_product_v1,
  public.catalog_relation_decision_item_source_v1,
  public.catalog_relation_decision_queue_v1,
  public.graph_stage4e_knowledge_edges_v1
to authenticated,service_role;
grant select on public.catalog_relation_decisions,
  public.catalog_relation_decision_items,
  public.catalog_relation_decision_previews
to authenticated,service_role;

create trigger catalog_relation_decision_items_immutable
before update or delete on public.catalog_relation_decision_items
for each row execute function public.prevent_catalog_relation_decision_item_mutation();

create trigger catalog_relation_decisions_set_updated_at
before update on public.catalog_relation_decisions
for each row execute function public.set_updated_at();

create or replace function public.sync_catalog_relation_decisions_v1()
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  model record;
  persisted public.catalog_relation_decisions%rowtype;
  work public.catalog_review_work_items%rowtype;
  source_run_id uuid;
  inserted_count integer := 0;
  linked_work_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('catalog-relation-decisions-stage4e-v1',0));

  for model in select * from public.catalog_decision_product_v1 order by group_key loop
    select item.reprocess_run_id into source_run_id
    from public.catalog_relation_decision_item_source_v1 item
    where item.group_key=model.group_key
    order by item.ordinal limit 1;

    if source_run_id is null then
      raise exception using errcode='P0002',
        message='La decision no conserva elementos del preview 4B.';
    end if;

    select * into persisted
    from public.catalog_relation_decisions decision
    where decision.decision_key=model.group_key
      and decision.decision_fingerprint=model.fingerprint;

    if not found then
      update public.catalog_relation_decisions
      set status='superseded', resolved_at=now(),
          resolution_comment='La evidencia material genero una version posterior.'
      where decision_key=model.group_key and status='pending';

      insert into public.catalog_relation_decisions(
        decision_key, public_decision_id, group_key, family_code,
        source_reprocess_run_id, decision_fingerprint, affected_set_fingerprint,
        source_preview_fingerprint, source_snapshot_fingerprint, read_model
      ) values (
        model.group_key, model.decision_id, model.group_key, model.family_code,
        source_run_id, model.fingerprint,
        model.evidence_summary->>'affectedSetFingerprint',
        model.evidence_summary->>'previewFingerprint',
        model.evidence_summary->>'snapshotFingerprint', to_jsonb(model)
      ) returning * into persisted;

      insert into public.catalog_relation_decision_items(
        decision_id, reprocess_item_id, candidate_id, ordinal, classification,
        item_fingerprint, source_snapshot, context_snapshot,
        proposed_resolution, explanation
      )
      select persisted.id, source.id, source.candidate_id,
        row_number() over(order by source.ordinal)::integer,
        source.classification, source.item_fingerprint, source.source_snapshot,
        source.context_snapshot, source.proposed_resolution, source.explanation
      from public.catalog_relation_decision_item_source_v1 source
      where source.group_key=model.group_key
      order by source.ordinal;

      inserted_count := inserted_count + 1;
    end if;

    work := public.register_catalog_review_work_item_v1(
      model.group_key,
      'relation_decision', persisted.id,
      'decision', 'relation', 'rule', null,
      model.fingerprint,
      model.decision_question,
      model.recommendation_text,
      model.group_key,
      'normal', 'normal', false, 0,
      least(100, model.affected_count)::numeric,
      2::smallint,
      jsonb_build_object(
        'readModelOrigin','stage4e',
        'decisionPublicId',model.decision_id,
        'familyCode',model.family_code,
        'affectedCount',model.affected_count,
        'humanActionable',true
      )
    );

    if persisted.work_item_id is distinct from work.id then
      update public.catalog_relation_decisions set work_item_id=work.id where id=persisted.id
      returning * into persisted;
      linked_work_count := linked_work_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'contractVersion','stage4e-v1',
    'decisionsInserted',inserted_count,
    'workItemsLinked',linked_work_count,
    'activeDecisions',(select count(*) from public.catalog_relation_decisions where status='pending'),
    'humanWorkPerCandidateCreated',false
  );
end;
$function$;

create or replace function public.catalog_relation_decision_mutation_plan_v1(
  p_decision_id uuid,
  p_action_code text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  decision public.catalog_relation_decisions%rowtype;
  candidate_plan jsonb;
  membership_plan jsonb := '[]'::jsonb;
  class_plan jsonb := '[]'::jsonb;
  rule_plan jsonb := null;
  evidence_plan jsonb := null;
  blocker_count integer := 0;
  membership_count integer := 0;
  missing_class_count integer := 0;
  planned_rule_code text;
  planned_source_class_code text;
  planned_target_class_code text;
  planned_relation_kind_code text;
begin
  select * into decision from public.catalog_relation_decisions where id=p_decision_id;
  if not found then
    raise exception using errcode='P0002', message='La decision agrupada no existe.';
  end if;

  if not (
    (decision.family_code='CLASS_RULE_PROMOTION'
      and p_action_code in ('ACCEPT_CLASS_RULE','REJECT_CLASS_RULE'))
    or (decision.family_code='ENDPOINT_SCOPE_RECLASSIFICATION'
      and p_action_code in ('ACCEPT_MEMBERSHIP_SCOPE','ADJUST_ENDPOINT_PROFILE'))
    or (decision.family_code='FALSE_PAIR_RETIREMENT'
      and p_action_code in ('ACCEPT_FALSE_PAIR_RETIREMENT','ADJUST_ENDPOINT_PROFILE'))
  ) then
    raise exception using errcode='22023', message='La accion no pertenece a esta familia de decision.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateId',candidate.id,
    'itemFingerprint',item.item_fingerprint,
    'currentStatus',candidate.status,
    'currentResolutionKind',candidate.resolution_kind,
    'nextStatus',case
      when p_action_code in ('ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE') then 'approved'
      when p_action_code='ACCEPT_FALSE_PAIR_RETIREMENT' then 'rejected'
      else candidate.status end,
    'nextResolutionKind',case
      when p_action_code='ACCEPT_CLASS_RULE' then 'class_rule'
      when p_action_code='ACCEPT_MEMBERSHIP_SCOPE' then 'class_membership'
      when p_action_code='ACCEPT_FALSE_PAIR_RETIREMENT' then 'incorrect'
      else candidate.resolution_kind end
  ) order by item.ordinal),'[]'::jsonb)
  into candidate_plan
  from public.catalog_relation_decision_items item
  join public.catalog_relation_candidates candidate on candidate.id=item.candidate_id
  where item.decision_id=decision.id;

  if p_action_code in ('ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE') then
    with proposed as (
      select (membership->>'productId')::uuid as product_id,
             membership->>'classCode' as class_code
      from public.catalog_relation_decision_items item
      cross join lateral jsonb_array_elements(
        case when p_action_code='ACCEPT_CLASS_RULE'
          then coalesce(item.proposed_resolution->'memberships','[]'::jsonb)
          else '[]'::jsonb end
      ) membership
      where item.decision_id=decision.id
      union
      select (item.proposed_resolution->>'sourceProductId')::uuid,
             observed->>'classCode'
      from public.catalog_relation_decision_items item
      cross join lateral jsonb_array_elements(
        case when p_action_code='ACCEPT_MEMBERSHIP_SCOPE'
          then coalesce(item.proposed_resolution->'sourceObservedClasses','[]'::jsonb)
          else '[]'::jsonb end
      ) observed
      where item.decision_id=decision.id
      union
      select (item.proposed_resolution->>'targetProductId')::uuid,
             observed->>'classCode'
      from public.catalog_relation_decision_items item
      cross join lateral jsonb_array_elements(
        case when p_action_code='ACCEPT_MEMBERSHIP_SCOPE'
          then coalesce(item.proposed_resolution->'targetObservedClasses','[]'::jsonb)
          else '[]'::jsonb end
      ) observed
      where item.decision_id=decision.id
    ), distinct_proposed as (
      select distinct product_id,class_code from proposed
      where product_id is not null and nullif(class_code,'') is not null
    )
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'productId',proposed.product_id,
      'classCode',proposed.class_code,
      'existingClassId',class.id,
      'existingMembershipId',membership.id,
      'existingMembershipStatus',membership.decision_status,
      'nextMembershipStatus','approved'
    )) order by proposed.class_code,proposed.product_id),'[]'::jsonb), count(*)::integer,
      count(*) filter(where membership.decision_status in ('rejected','superseded'))::integer
    into membership_plan,membership_count,blocker_count
    from distinct_proposed proposed
    left join public.catalog_classes class on class.code=proposed.class_code
    left join public.catalog_class_members membership
      on membership.class_id=class.id and membership.product_id=proposed.product_id;
  end if;

  if p_action_code='ACCEPT_CLASS_RULE' then
    select item.proposed_resolution->>'sourceClass',
           item.proposed_resolution->>'targetClass',
           item.proposed_resolution->>'relationKind'
    into planned_source_class_code,planned_target_class_code,planned_relation_kind_code
    from public.catalog_relation_decision_items item
    where item.decision_id=decision.id order by item.ordinal limit 1;
    planned_rule_code := 'STAGE4E_' || upper(substr(md5(decision.decision_key),1,24));
  end if;

  with class_codes as (
    select distinct value->>'classCode' as class_code
    from jsonb_array_elements(membership_plan) value
    union
    select planned_source_class_code where planned_source_class_code is not null
    union
    select planned_target_class_code where planned_target_class_code is not null
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'classCode',codes.class_code,
    'existingClassId',class.id,
    'name',profile.display_name,
    'description',profile.description
  )) order by codes.class_code),'[]'::jsonb),
    count(*) filter(where class.id is null)::integer
  into class_plan,missing_class_count
  from class_codes codes
  left join public.catalog_classes class on class.code=codes.class_code
  left join public.catalog_relation_endpoint_profiles profile
    on profile.proposed_class_code=codes.class_code and profile.is_active;

  if p_action_code='ACCEPT_CLASS_RULE' then
    select jsonb_strip_nulls(jsonb_build_object(
      'ruleCode',planned_rule_code,
      'sourceClassCode',planned_source_class_code,
      'targetClassCode',planned_target_class_code,
      'relationKind',planned_relation_kind_code,
      'existingRuleId',rule.id,
      'existingRuleDecision',rule.metadata->>'stage4eDecisionId',
      'nextDecisionStatus','approved',
      'epistemicState','NEEDS_EVIDENCE',
      'canonicalPromotion',false
    )) into rule_plan
    from (select 1) singleton
    left join public.catalog_relation_rules rule on rule.code=planned_rule_code;
    if rule_plan->>'existingRuleId' is not null
       and rule_plan->>'existingRuleDecision' is distinct from decision.public_decision_id then
      blocker_count := blocker_count + 1;
    end if;
  end if;

  if p_action_code in ('ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE') then
    select jsonb_strip_nulls(jsonb_build_object(
      'evidenceKey','stage4e:' || decision.public_decision_id,
      'version',1,
      'existingEvidenceSetId',evidence.id,
      'nextDecisionStatus','approved',
      'evidenceType','human_review'
    )) into evidence_plan
    from (select 1) singleton
    left join public.catalog_evidence_sets evidence
      on evidence.evidence_key='stage4e:' || decision.public_decision_id and evidence.version=1;
  end if;

  if p_action_code in ('ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE','ACCEPT_FALSE_PAIR_RETIREMENT') then
    blocker_count := blocker_count + (
      select count(*)::integer
      from public.catalog_relation_decision_items item
      join public.catalog_relation_candidates candidate on candidate.id=item.candidate_id
      where item.decision_id=decision.id and candidate.status<>'needs_evidence'
    );
  end if;

  return jsonb_build_object(
    'contractVersion','stage4e-v1',
    'decisionId',decision.public_decision_id,
    'decisionFingerprint',decision.decision_fingerprint,
    'familyCode',decision.family_code,
    'actionCode',p_action_code,
    'candidates',candidate_plan,
    'classes',class_plan,
    'memberships',membership_plan,
    'classRule',rule_plan,
    'evidenceSet',evidence_plan,
    'blockerCount',blocker_count,
    'impact',jsonb_build_object(
      'candidateRowsChanged',case when p_action_code in (
        'ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE','ACCEPT_FALSE_PAIR_RETIREMENT'
      ) then jsonb_array_length(candidate_plan) else 0 end,
      'classMembershipsConfirmed',membership_count,
      'classesCreated',missing_class_count,
      'classRulesCreated',case when p_action_code='ACCEPT_CLASS_RULE'
        and rule_plan->>'existingRuleId' is null then 1 else 0 end,
      'historyDeleted',0,
      'canonicalFactsCreated',0,
      'commercialEffects',0,
      'priceChanged',false,
      'stockChanged',false,
      'publicationChanged',false
    )
  );
end;
$function$;

create or replace function public.preview_catalog_relation_decision_v1(
  p_decision_id text,
  p_action_code text,
  p_comment text,
  p_expected_work_version bigint,
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
  decision public.catalog_relation_decisions%rowtype;
  work public.catalog_review_work_items%rowtype;
  existing public.catalog_relation_decision_previews%rowtype;
  created public.catalog_relation_decision_previews%rowtype;
  normalized_comment text := nullif(trim(coalesce(p_comment,'')),'');
  request_fingerprint text;
  state_fingerprint text;
  preview_fingerprint text;
  plan jsonb;
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id<>auth.uid() then
    raise exception using errcode='42501', message='El actor no coincide con la sesion autenticada.';
  end if;
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode='42501', message='Solo administracion puede preparar decisiones de catalogo.';
  end if;
  if nullif(trim(coalesce(p_decision_id,'')),'') is null
     or nullif(trim(coalesce(p_action_code,'')),'') is null
     or p_expected_work_version is null or p_expected_work_version<=0
     or nullif(trim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023',
      message='El preview exige decision, accion, version y clave idempotente.';
  end if;
  if length(coalesce(normalized_comment,''))>1000 then
    raise exception using errcode='22001', message='El comentario supera 1000 caracteres.';
  end if;
  if p_action_code in ('REJECT_CLASS_RULE','ADJUST_ENDPOINT_PROFILE')
     and normalized_comment is null then
    raise exception using errcode='22023', message='Esta accion exige una explicacion breve.';
  end if;
  if p_action_code='KEEP_DEFERRED' then
    raise exception using errcode='22023',
      message='Guardar pendiente usa la transicion de aplazamiento, no un preview de apply.';
  end if;

  request_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'decisionId',p_decision_id,'actionCode',p_action_code,
    'comment',normalized_comment,'expectedWorkVersion',p_expected_work_version
  )::text,'UTF8'),'sha256'),'hex');

  select * into existing from public.catalog_relation_decision_previews preview
  where preview.preview_idempotency_key=p_idempotency_key;
  if found then
    if existing.preview_request_fingerprint<>request_fingerprint then
      raise exception using errcode='23505',
        message='La clave idempotente ya fue usada para otro preview.';
    end if;
    return jsonb_build_object(
      'contractVersion','stage4e-v1','previewId',existing.id,
      'status',existing.status,'decisionId',p_decision_id,
      'actionCode',existing.action_code,
      'previewFingerprint',existing.preview_fingerprint,
      'expectedWorkVersion',existing.expected_work_version,
      'impact',existing.mutation_plan->'impact','idempotentReplay',true
    );
  end if;

  select * into decision from public.catalog_relation_decisions current
  where current.public_decision_id=p_decision_id for update;
  if not found then
    raise exception using errcode='P0002', message='La decision agrupada no existe.';
  end if;
  if decision.status<>'pending' then
    raise exception using errcode='23514', message='La decision ya no admite un preview nuevo.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(decision.decision_key,0));
  select * into work from public.catalog_review_work_items item
  where item.id=decision.work_item_id for update;
  if not found or work.status not in ('open','in_progress') then
    raise exception using errcode='23514', message='El trabajo de la Mesa ya no esta abierto.';
  end if;
  if work.row_version<>p_expected_work_version then
    raise exception using errcode='40001',
      message='El caso cambio desde que fue abierto; vuelve a cargarlo.';
  end if;
  if work.material_fingerprint<>decision.decision_fingerprint then
    raise exception using errcode='40001', message='La decision ya no coincide con su expediente.';
  end if;
  if work.deferred_until is not null and work.deferred_until>now() then
    raise exception using errcode='23514', message='El caso esta guardado para despues; reanudalo antes de decidir.';
  end if;

  plan := public.catalog_relation_decision_mutation_plan_v1(decision.id,p_action_code);
  if coalesce((plan->>'blockerCount')::integer,0)>0 then
    raise exception using errcode='40001',
      message='El conjunto afectado cambio o contiene un conflicto; genera un preview nuevo.';
  end if;
  state_fingerprint := encode(extensions.digest(convert_to(plan::text,'UTF8'),'sha256'),'hex');
  preview_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    decision.decision_fingerprint,state_fingerprint,p_action_code,
    coalesce(normalized_comment,''),p_expected_work_version::text
  ),'UTF8'),'sha256'),'hex');

  insert into public.catalog_relation_decision_previews(
    decision_id,work_item_id,action_code,decision_comment,expected_work_version,
    decision_fingerprint,state_fingerprint,mutation_plan,preview_fingerprint,
    preview_idempotency_key,preview_request_fingerprint,created_by
  ) values (
    decision.id,work.id,p_action_code,normalized_comment,p_expected_work_version,
    decision.decision_fingerprint,state_fingerprint,plan,preview_fingerprint,
    p_idempotency_key,request_fingerprint,actor
  ) returning * into created;

  return jsonb_build_object(
    'contractVersion','stage4e-v1','previewId',created.id,'status',created.status,
    'decisionId',decision.public_decision_id,'actionCode',created.action_code,
    'previewFingerprint',created.preview_fingerprint,
    'expectedWorkVersion',created.expected_work_version,
    'confirmation',jsonb_build_object(
      'title',decision.read_model->>'product_title',
      'question',decision.read_model->>'decision_question',
      'comment',created.decision_comment
    ),
    'impact',plan->'impact','idempotentReplay',false
  );
end;
$function$;

create or replace function public.apply_catalog_relation_decision_v1(
  p_preview_id uuid,
  p_preview_fingerprint text,
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
  actor_name text;
  preview public.catalog_relation_decision_previews%rowtype;
  decision public.catalog_relation_decisions%rowtype;
  work public.catalog_review_work_items%rowtype;
  changed_work public.catalog_review_work_items%rowtype;
  plan jsonb;
  current_state_fingerprint text;
  request_fingerprint text;
  entry jsonb;
  planned_class_id uuid;
  evidence_id uuid;
  relation_rule_id uuid;
  relation_legacy_type public.product_relation_type;
  changed_candidates integer := 0;
  changed_memberships integer := 0;
  created_classes integer := 0;
  created_rules integer := 0;
  decision_status text;
begin
  if auth.uid() is not null and p_actor_id is not null and p_actor_id<>auth.uid() then
    raise exception using errcode='42501', message='El actor no coincide con la sesion autenticada.';
  end if;
  if actor is null or not public.is_admin(actor) then
    raise exception using errcode='42501', message='Solo administracion puede aplicar decisiones de catalogo.';
  end if;
  if p_preview_id is null
     or nullif(trim(coalesce(p_preview_fingerprint,'')),'') is null
     or nullif(trim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023',
      message='Apply exige preview, huella confirmada y clave idempotente.';
  end if;

  select * into preview
  from public.catalog_relation_decision_previews current
  where current.id=p_preview_id
  for update;
  if not found then
    raise exception using errcode='P0002', message='El preview de decision no existe.';
  end if;
  if preview.status='applied' then
    if preview.application_idempotency_key is distinct from p_idempotency_key
       or preview.preview_fingerprint is distinct from p_preview_fingerprint then
      raise exception using errcode='23505',
        message='El preview ya fue aplicado con otra confirmacion.';
    end if;
    select * into decision from public.catalog_relation_decisions where id=preview.decision_id;
    select * into work from public.catalog_review_work_items where id=preview.work_item_id;
    return jsonb_build_object(
      'contractVersion','stage4e-v1','previewId',preview.id,
      'decisionId',decision.public_decision_id,'status',decision.status,
      'actionCode',preview.action_code,'workStatus',work.status,
      'workVersion',work.row_version,'impact',preview.mutation_plan->'impact',
      'graphSyncRequired',false,'idempotentReplay',true
    );
  end if;
  if preview.status<>'previewed' then
    raise exception using errcode='23514', message='El preview ya no se puede aplicar.';
  end if;
  if preview.preview_fingerprint<>p_preview_fingerprint then
    raise exception using errcode='40001',
      message='La confirmacion no coincide con el preview que se mostro.';
  end if;

  select * into decision from public.catalog_relation_decisions current
  where current.id=preview.decision_id for update;
  if not found or decision.status<>'pending' then
    raise exception using errcode='23514', message='La decision ya no esta pendiente.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(decision.decision_key,0));
  select * into work from public.catalog_review_work_items current
  where current.id=preview.work_item_id for update;
  if not found or work.status not in ('open','in_progress') then
    raise exception using errcode='23514', message='El expediente ya no esta abierto.';
  end if;
  if work.row_version<>preview.expected_work_version
     or work.material_fingerprint<>preview.decision_fingerprint
     or decision.decision_fingerprint<>preview.decision_fingerprint then
    raise exception using errcode='40001',
      message='El caso cambio desde el preview; revisa la version actual.';
  end if;
  if work.deferred_until is not null and work.deferred_until>now() then
    raise exception using errcode='23514',
      message='El caso esta guardado para despues; reanudalo antes de aplicar.';
  end if;

  plan := public.catalog_relation_decision_mutation_plan_v1(decision.id,preview.action_code);
  current_state_fingerprint := encode(extensions.digest(
    convert_to(plan::text,'UTF8'),'sha256'),'hex');
  if current_state_fingerprint<>preview.state_fingerprint
     or coalesce((plan->>'blockerCount')::integer,0)>0 then
    raise exception using errcode='40001',
      message='Los registros afectados ya no son los del preview; genera uno nuevo.';
  end if;
  request_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    preview.id::text,preview.preview_fingerprint,p_idempotency_key
  ),'UTF8'),'sha256'),'hex');

  -- La aceptacion humana confirma solo las clases y productos congelados en
  -- el preview. No clasifica automaticamente productos nuevos o inciertos.
  if preview.action_code in ('ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE') then
    insert into public.catalog_evidence_sets(
      evidence_key,version,evidence_type,decision_status,confidence,
      rationale,decided_by,decided_at,metadata
    ) values (
      plan->'evidenceSet'->>'evidenceKey',1,'human_review','approved',1,
      coalesce(preview.decision_comment,
        'La propietaria confirmo el alcance exacto mostrado en el preview.'),
      actor,now(),jsonb_build_object(
        'stage','4E','stage4eDecisionId',decision.public_decision_id,
        'previewId',preview.id,'decisionFingerprint',decision.decision_fingerprint,
        'canonicalPromotion',false,'commercialEffect','none'
      )
    )
    on conflict (evidence_key,version) do update
      set decision_status='approved', confidence=excluded.confidence,
          rationale=excluded.rationale, decided_by=excluded.decided_by,
          decided_at=excluded.decided_at,
          metadata=public.catalog_evidence_sets.metadata || excluded.metadata
      where public.catalog_evidence_sets.metadata->>'stage4eDecisionId'
        = decision.public_decision_id
    returning id into evidence_id;
    if evidence_id is null then
      raise exception using errcode='23514',
        message='La evidencia de esta decision entra en conflicto con otra version.';
    end if;

    for entry in select value from jsonb_array_elements(plan->'classes') loop
      select id into planned_class_id from public.catalog_classes
      where code=entry->>'classCode' for update;
      if not found then
        insert into public.catalog_classes(
          code,name,target_scope,description,metadata
        ) values (
          entry->>'classCode',
          coalesce(nullif(entry->>'name',''),
            initcap(lower(replace(entry->>'classCode','_',' ')))),
          'product',entry->>'description',jsonb_build_object(
            'stage','4E','stage4eDecisionId',decision.public_decision_id,
            'epistemicState','DERIVED_INFERRED','canonicalPromotion',false
          )
        ) returning id into planned_class_id;
        created_classes := created_classes + 1;
      end if;
    end loop;

    for entry in select value from jsonb_array_elements(plan->'memberships') loop
      select id into planned_class_id from public.catalog_classes
      where code=entry->>'classCode';
      insert into public.catalog_class_members(
        class_id,product_id,origin,decision_status,evidence_set_id,metadata
      ) values (
        planned_class_id,(entry->>'productId')::uuid,'manual','approved',evidence_id,
        jsonb_build_object(
          'stage','4E','stage4eDecisionId',decision.public_decision_id,
          'stage4eDecisionIds',jsonb_build_array(decision.public_decision_id),
          'previewId',preview.id,'epistemicState','DERIVED_INFERRED',
          'confirmedOnlyForFrozenPreview',true,'canonicalPromotion',false
        )
      )
      on conflict (class_id,target_ref) do update
        set decision_status='approved',
            evidence_set_id=case
              when public.catalog_class_members.decision_status='approved'
                then public.catalog_class_members.evidence_set_id
              else excluded.evidence_set_id end,
            metadata=jsonb_set(
              public.catalog_class_members.metadata || case
                when public.catalog_class_members.metadata ? 'stage4eDecisionId'
                  then excluded.metadata - 'stage4eDecisionId' - 'stage4eDecisionIds'
                else excluded.metadata - 'stage4eDecisionIds' end,
              '{stage4eDecisionIds}',
              coalesce(public.catalog_class_members.metadata->'stage4eDecisionIds',
                case when public.catalog_class_members.metadata ? 'stage4eDecisionId'
                  then jsonb_build_array(
                    public.catalog_class_members.metadata->>'stage4eDecisionId')
                  else '[]'::jsonb end)
                || excluded.metadata->'stage4eDecisionIds',true
            )
        where public.catalog_class_members.decision_status in (
          'proposed','needs_evidence','approved'
        );
      if not found then
        raise exception using errcode='40001',
          message='Una membresia cambio a un estado incompatible con el preview.';
      end if;
      changed_memberships := changed_memberships + 1;
    end loop;
  end if;

  if preview.action_code='ACCEPT_CLASS_RULE' then
    select kind.legacy_relation_type into relation_legacy_type
    from public.catalog_relation_kinds kind
    where kind.code=plan->'classRule'->>'relationKind' and kind.is_active;
    select id into planned_class_id from public.catalog_classes
    where code=plan->'classRule'->>'sourceClassCode';
    insert into public.catalog_relation_rules(
      code,source_class_id,target_class_id,relation_type,relation_kind_code,
      compatibility_status,requirement_level,brand_policy,decision_status,
      evidence_set_id,epistemic_state,notes,metadata
    ) values (
      plan->'classRule'->>'ruleCode',planned_class_id,
      (select id from public.catalog_classes
        where code=plan->'classRule'->>'targetClassCode'),
      relation_legacy_type,plan->'classRule'->>'relationKind','unknown',
      'optional','explicit_evidence','approved',evidence_id,'NEEDS_EVIDENCE',
      'Regla compartida confirmada para las membresias del preview; no clasifica productos inciertos.',
      jsonb_build_object(
        'stage','4E','stage4eDecisionId',decision.public_decision_id,
        'previewId',preview.id,'confirmedOnlyForFrozenPreview',true,
        'canonicalPromotion',false,'commercialEffect','none'
      )
    )
    on conflict (code) do update
      set decision_status='approved',evidence_set_id=excluded.evidence_set_id,
          metadata=public.catalog_relation_rules.metadata || excluded.metadata
      where public.catalog_relation_rules.metadata->>'stage4eDecisionId'
        = decision.public_decision_id
    returning id into relation_rule_id;
    if relation_rule_id is null then
      raise exception using errcode='23514',
        message='El codigo de la regla pertenece a otra decision.';
    end if;
    created_rules := case when plan->'classRule'->>'existingRuleId' is null then 1 else 0 end;
  end if;

  if preview.action_code in (
    'ACCEPT_CLASS_RULE','ACCEPT_MEMBERSHIP_SCOPE','ACCEPT_FALSE_PAIR_RETIREMENT'
  ) then
    update public.catalog_relation_candidates candidate
    set status=case when preview.action_code='ACCEPT_FALSE_PAIR_RETIREMENT'
          then 'rejected' else 'approved' end,
        resolution_kind=case preview.action_code
          when 'ACCEPT_CLASS_RULE' then 'class_rule'
          when 'ACCEPT_MEMBERSHIP_SCOPE' then 'class_membership'
          else 'incorrect' end,
        decided_by=actor,decided_at=now()
    where candidate.id in (
      select item.candidate_id from public.catalog_relation_decision_items item
      where item.decision_id=decision.id
    ) and candidate.status='needs_evidence';
    get diagnostics changed_candidates = row_count;
    if changed_candidates<>jsonb_array_length(plan->'candidates') then
      raise exception using errcode='40001',
        message='No se pudo aplicar el conjunto exacto de candidatas.';
    end if;
  end if;

  decision_status := case preview.action_code
    when 'REJECT_CLASS_RULE' then 'rejected'
    when 'ADJUST_ENDPOINT_PROFILE' then 'adjustment_requested'
    else 'applied' end;
  update public.catalog_relation_decisions
  set status=decision_status,resolved_action=preview.action_code,
      resolution_comment=preview.decision_comment,resolved_by=actor,resolved_at=now()
  where id=decision.id;

  update public.catalog_review_work_items
  set status='resolved',resolution_code=lower(preview.action_code),
      resolution_payload=jsonb_build_object(
        'contractVersion','stage4e-v1','decisionId',decision.public_decision_id,
        'previewId',preview.id,'previewFingerprint',preview.preview_fingerprint,
        'actionCode',preview.action_code,'comment',preview.decision_comment,
        'impact',plan->'impact','canonicalFactsCreated',0,
        'commercialEffect','none','graphProjectionLayer','evidence'
      ),resolved_by=actor,resolved_at=now(),assigned_to=null,
      deferred_until=null,defer_reason=null
  where id=work.id and row_version=preview.expected_work_version
    and status in ('open','in_progress')
  returning * into changed_work;
  if not found then
    raise exception using errcode='40001', message='El expediente cambio durante el apply.';
  end if;

  select full_name into actor_name from public.admin_profiles where id=actor;
  insert into public.catalog_review_events(
    work_item_id,work_key,event_type,action_code,actor_id,actor_label,
    idempotency_key,request_fingerprint,prior_version,new_version,payload,evidence
  ) values (
    changed_work.id,changed_work.work_key,'decision_taken',preview.action_code,
    actor,actor_name,p_idempotency_key,request_fingerprint,
    preview.expected_work_version,changed_work.row_version,
    changed_work.resolution_payload || jsonb_build_object(
      'candidateRowsChanged',changed_candidates,
      'classMembershipRowsConfirmed',changed_memberships,
      'classesCreated',created_classes,'classRulesCreated',created_rules
    ),jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'kind','stage4e_exact_preview','previewId',preview.id,
      'previewFingerprint',preview.preview_fingerprint,
      'decisionFingerprint',decision.decision_fingerprint,
      'evidenceSetId',evidence_id,'relationRuleId',relation_rule_id
    )))
  );

  update public.catalog_relation_decision_previews
  set status='applied',application_idempotency_key=p_idempotency_key,
      applied_by=actor,applied_at=now()
  where id=preview.id;
  update public.catalog_relation_decision_previews
  set status='expired'
  where decision_id=decision.id and id<>preview.id and status='previewed';

  perform public.refresh_catalog_review_dependencies_v1();

  return jsonb_build_object(
    'contractVersion','stage4e-v1','previewId',preview.id,
    'decisionId',decision.public_decision_id,'status',decision_status,
    'actionCode',preview.action_code,'workStatus',changed_work.status,
    'workVersion',changed_work.row_version,
    'impact',(plan->'impact') || jsonb_build_object(
      'candidateRowsChanged',changed_candidates,
      'classMembershipRowsConfirmed',changed_memberships,
      'classesCreated',created_classes,'classRulesCreated',created_rules
    ),
    'graphSyncRequired',true,'graphProjectionLayer','evidence',
    'verifyRequired',true,'idempotentReplay',false
  );
end;
$function$;

create or replace function public.transition_catalog_relation_decision_v1(
  p_decision_id text,
  p_expected_work_version bigint,
  p_action_code text,
  p_reason text,
  p_defer_minutes integer,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  decision public.catalog_relation_decisions%rowtype;
  result jsonb;
  normalized_action text := case p_action_code
    when 'KEEP_DEFERRED' then 'defer'
    when 'RESUME' then 'resume'
    else lower(coalesce(p_action_code,'')) end;
begin
  if normalized_action not in ('defer','resume') then
    raise exception using errcode='22023',
      message='La decision solo admite guardar pendiente o reanudar.';
  end if;
  select * into decision from public.catalog_relation_decisions current
  where current.public_decision_id=p_decision_id and current.status='pending';
  if not found then
    raise exception using errcode='P0002', message='La decision pendiente no existe.';
  end if;

  result := public.transition_catalog_review_item_v1(
    decision.work_item_id,p_expected_work_version,normalized_action,p_reason,
    p_idempotency_key,coalesce(p_defer_minutes,1440),p_actor_id
  );
  return jsonb_build_object(
    'contractVersion','stage4e-v1','decisionId',decision.public_decision_id,
    'transition',result,'decisionResolved',false
  );
end;
$function$;

revoke all on function public.sync_catalog_relation_decisions_v1() from public,anon,authenticated;
grant execute on function public.sync_catalog_relation_decisions_v1() to service_role;
revoke all on function public.catalog_relation_human_endpoint_v1(text) from public,anon;
grant execute on function public.catalog_relation_human_endpoint_v1(text) to authenticated,service_role;
revoke all on function public.prevent_catalog_relation_decision_item_mutation()
from public,anon,authenticated;

revoke all on function public.catalog_relation_decision_mutation_plan_v1(uuid,text)
from public,anon;
revoke all on function public.preview_catalog_relation_decision_v1(text,text,text,bigint,text,uuid)
from public,anon;
revoke all on function public.apply_catalog_relation_decision_v1(uuid,text,text,uuid)
from public,anon;
revoke all on function public.transition_catalog_relation_decision_v1(text,bigint,text,text,integer,text,uuid)
from public,anon;
revoke all on function public.get_catalog_relation_decision_queue_v1(text,integer,integer)
from public,anon;
revoke all on function public.get_catalog_relation_decision_detail_v1(text,integer,integer)
from public,anon;
revoke all on function public.verify_catalog_relation_decision_v1(text)
from public,anon;
revoke all on function public.get_catalog_stage4e_report_v1()
from public,anon;

grant execute on function public.catalog_relation_decision_mutation_plan_v1(uuid,text),
  public.preview_catalog_relation_decision_v1(text,text,text,bigint,text,uuid),
  public.apply_catalog_relation_decision_v1(uuid,text,text,uuid),
  public.transition_catalog_relation_decision_v1(text,bigint,text,text,integer,text,uuid),
  public.get_catalog_relation_decision_queue_v1(text,integer,integer),
  public.get_catalog_relation_decision_detail_v1(text,integer,integer),
  public.verify_catalog_relation_decision_v1(text),
  public.get_catalog_stage4e_report_v1()
to authenticated,service_role;

select public.sync_catalog_relation_decisions_v1();

commit;
