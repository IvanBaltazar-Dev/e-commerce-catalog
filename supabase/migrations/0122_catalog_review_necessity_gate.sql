-- 0122 · Compuerta de necesidad: la propietaria solo ve lo que puede decidir.
--
-- La Mesa acumulaba 413 preguntas humanas. Al abrirlas una por una aparecen
-- cinco familias que no son decisiones comerciales sino defectos de método:
--
--   1. El emparejador de nombres oficiales sugiere parejas sin ningún término
--      en común ("Broca Bola" contra "ACRY LOVE BOLSA BLACK CHICA"). Nadie
--      puede aprobar eso: no es una duda, es ruido de similitud de caracteres.
--   2. El mismo registro oficial es reclamado por varios productos internos
--      ("BRILLO GEL EVOLUTION" lo reclaman seis brillos distintos). Como mucho
--      uno es correcto; presentarlos como seis decisiones separadas esconde que
--      el emparejamiento se hizo con la granularidad equivocada.
--   3. El primer candidato y el segundo empatan. El sistema no distingue, así
--      que nombrar a uno "recomendación" es precisión falsa.
--   4. Las excepciones de identidad citan filas "Excel:NNN" que ya no existen
--      en ninguna tabla. La pregunta no tiene sujeto recuperable.
--   5. Ciento cincuenta y seis encargos dicen "buscar el fabricante y
--      contrastar el envase". Buscar no es decidir: la clase de trabajo se
--      estaba derivando del formato del registro y no de lo que el registro
--      pide, así que toda investigación pendiente aterrizaba en la Mesa.
--
-- Ninguno de esos cinco casos se borra. Se degradan a deuda automática: el
-- sistema sigue debiendo el trabajo, pero deja de cobrárselo a la propietaria.
--
-- En sentido contrario, once identidades de tono ya resueltas seguían llegando
-- a la Mesa porque la regla objetiva exigía igualdad de cadena completa
-- ("N.º 26" contra "26 Golden Brown") en vez de igualdad del código numérico
-- que el propio algoritmo usó para dar puntaje 1. Esas se resuelven solas.
--
-- Lo que queda se ordena. La relevancia comercial existía como columna y valía
-- 0,0000 en 394 de 413 trabajos, de modo que la Mesa era dos montones sin orden
-- interno. Aquí pasa a significar algo comprobable: cuántos productos del
-- catálogo quedan afectados por esa decisión.

begin;

-- Términos con capacidad de distinguir un producto de otro. Se descartan las
-- palabras cortas, los números sueltos y los nombres de marca, porque aparecen
-- en casi todos los títulos y no informan nada sobre la identidad.
create or replace function public.catalog_review_discriminative_tokens_v1(p_text text)
returns text[]
language sql
immutable
parallel safe
as $function$
  select coalesce(array_agg(distinct token), array[]::text[])
  from unnest(
    regexp_split_to_array(public.search_normalize(coalesce(p_text, '')), '[^a-z0-9]+')
  ) as token
  where length(token) >= 4
    and token !~ '^[0-9]+$'
    and token not in (
      'masglo', 'admiss', 'acry', 'love', 'bellaroshe', 'nail', 'nails',
      'para', 'profesional', 'professional'
    );
$function$;

-- Código numérico que identifica un tono dentro de su familia. "N.º 26" y
-- "26 Golden Brown" comparten el 26; ese es el hecho objetivo que el algoritmo
-- exact_normalized_tone_or_official_code_v1 usa para puntuar 1.
create or replace function public.catalog_review_tone_code_v1(p_text text)
returns text
language sql
immutable
parallel safe
as $function$
  select (regexp_match(public.search_normalize(coalesce(p_text, '')), '([0-9]+)'))[1];
$function$;

-- Resolución del sujeto de una excepción de fila fuente. Devuelve cuántos
-- productos internos se parecen al título y cuáles son, para que la pregunta
-- deje de ser un texto suelto y pase a tener destino verificable.
create or replace function public.catalog_review_source_row_link_v1(p_title text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with subject as (
    select public.search_normalize(regexp_replace(coalesce(p_title, ''), '^[A-Z_]+:\s*', '')) as needle
  ), scored as (
    select product.id, product.name, product.code,
           public.similarity(public.search_normalize(product.name), subject.needle) as score
    from public.products product, subject
    where subject.needle is not null
      and public.similarity(public.search_normalize(product.name), subject.needle) >= 0.45
  )
  select jsonb_build_object(
    'weakCount', (select count(*) from scored),
    'clearCount', (select count(*) from scored where score >= 0.60),
    'bestScore', coalesce((select round(max(score)::numeric, 4) from scored), 0),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', ranked.id, 'name', ranked.name,
        'code', ranked.code, 'score', round(ranked.score::numeric, 4)
      ) order by ranked.score desc)
      from (select * from scored order by score desc limit 5) ranked
    ), '[]'::jsonb)
  );
$function$;

-- La resolución se calcula una vez y queda como evidencia en el trabajo, no en
-- cada consulta. La interfaz puede mostrar los candidatos sin recalcular nada.
create or replace function public.normalize_catalog_review_source_row_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_type <> 'enrichment_exception'
     or coalesce(new.context -> 'details' ->> 'source_scope', '') <> 'SOURCE_ROW' then
    return new;
  end if;

  new.context := coalesce(new.context, '{}'::jsonb)
    || jsonb_build_object('sourceRowLink', public.catalog_review_source_row_link_v1(new.question));
  return new;
end;
$function$;

drop trigger if exists catalog_review_work_items_normalize_source_row
  on public.catalog_review_work_items;
create trigger catalog_review_work_items_normalize_source_row
before insert or update of source_type, question, context
on public.catalog_review_work_items
for each row execute function public.normalize_catalog_review_source_row_v1();

update public.catalog_review_work_items
set context = context
where source_type = 'enrichment_exception'
  and context -> 'details' ->> 'source_scope' = 'SOURCE_ROW'
  and status in ('open', 'in_progress');


create or replace function public.catalog_review_commercial_weight_v1(
  p_subject_type text,
  p_subject_id uuid,
  p_context jsonb
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $function$
  select least(100, coalesce(
    case
      when p_subject_type = 'brand' and p_subject_id is not null then (
        select count(*) from public.products product
        where product.brand_id = p_subject_id and product.is_active
      )
      when p_subject_type = 'product' and p_subject_id is not null then (
        select count(*) from public.products product
        where product.id = p_subject_id and product.is_active
      )
      when p_subject_type in ('variant', 'shade') and p_subject_id is not null then 1
      else 0
    end, 0))::numeric;
$function$;

create or replace function public.apply_catalog_review_commercial_weight_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Una relevancia declarada a mano por quien registra el trabajo manda sobre
  -- el cálculo. Solo se completa lo que llegó vacío.
  if new.business_relevance is not null and new.business_relevance > 0 then
    return new;
  end if;

  new.business_relevance := public.catalog_review_commercial_weight_v1(
    new.subject_type, new.subject_id, new.context
  );
  return new;
end;
$function$;

drop trigger if exists catalog_review_work_items_commercial_weight
  on public.catalog_review_work_items;
create trigger catalog_review_work_items_commercial_weight
before insert or update of subject_type, subject_id, context, business_relevance
on public.catalog_review_work_items
for each row execute function public.apply_catalog_review_commercial_weight_v1();

update public.catalog_review_work_items
set business_relevance = public.catalog_review_commercial_weight_v1(subject_type, subject_id, context)
where status in ('open', 'in_progress')
  and business_relevance = 0;

-- Una marca sin productos activos no tiene nada que desbloquear. La regla se
-- suma a la compuerta de necesidad de 0122 y actúa igual: degrada, no borra.
-- La vista se recrea porque incorpora la relevancia como columna propia. El
-- plan se recrea después sobre ella, así que se retira primero y vuelve entero
-- unas líneas más abajo; ninguna otra vista depende de él.
drop view if exists public.catalog_review_reprocess_plan_v1;
drop view if exists public.catalog_review_necessity_v1;
create view public.catalog_review_necessity_v1
with (security_invoker = true) as
with collision as (
  select reconciliation.source_record_id, count(*) as claimants
  from public.catalog_review_work_items item
  join public.catalog_reconciliation_cases reconciliation on reconciliation.id = item.source_id
  where item.source_type = 'reconciliation_case'
    and item.status in ('open', 'in_progress')
    and item.handling_class = 'human_exception'
    and reconciliation.score < 0.90
  group by reconciliation.source_record_id
  having count(*) >= 2
)
select
  item.id as work_item_id,
  item.work_key,
  item.purpose,
  item.source_type,
  item.handling_class,
  case
    when item.source_type = 'reconciliation_case'
      and coalesce(reconciliation.evidence ->> 'official_title', '') <> ''
      and not (
        public.catalog_review_discriminative_tokens_v1(reconciliation.evidence ->> 'internal_name')
        && public.catalog_review_discriminative_tokens_v1(reconciliation.evidence ->> 'official_title')
      )
      then 'matcher_without_discriminator'
    when item.source_type = 'reconciliation_case' and collision.claimants is not null
      then 'matcher_collides_many_to_one'
    when item.source_type = 'reconciliation_case'
      and reconciliation.score < 0.90
      and reconciliation.score
          - coalesce((reconciliation.evidence ->> 'candidate_2_score')::numeric, 0) < 0.05
      then 'matcher_candidates_indistinguishable'
    when item.source_type = 'enrichment_exception'
      and item.context -> 'sourceRowLink' is not null
      and coalesce((item.context -> 'sourceRowLink' ->> 'weakCount')::integer, 0) = 0
      then 'source_row_reference_unresolvable'
    when item.source_type = 'enrichment_exception'
      and item.context -> 'sourceRowLink' is not null
      and coalesce((item.context -> 'sourceRowLink' ->> 'clearCount')::integer, 0) = 0
      and coalesce((item.context -> 'sourceRowLink' ->> 'weakCount')::integer, 0) > 0
      then 'source_row_resemblance_too_weak'
    when item.subject_type = 'brand'
      and item.business_relevance = 0
      then 'subject_without_commercial_footprint'
    -- La clase de trabajo se deriva del formato del registro, no de lo que el
    -- registro pide. Todas las excepciones nacen con work_kind 'decision', así
    -- que 156 encargos que dicen "buscar el fabricante y contrastar el envase"
    -- llegaban a la Mesa como si fueran decisiones comerciales. Buscar no es
    -- decidir: eso lo debe la investigación, y vuelve a la propietaria cuando
    -- haya un nombre concreto que confirmar o rechazar.
    when item.context -> 'details' ->> 'required_action'
         = 'BUSCAR_FABRICANTE_DISTRIBUIDOR_Y_CONTRASTAR_ENVASE'
      then 'action_is_research_not_decision'
    else 'human_decision'
  end as verdict,
  coalesce(collision.claimants, 0) as claimants,
  item.business_relevance,
  reconciliation.score,
  item.context -> 'sourceRowLink' as source_row_link
from public.catalog_review_work_items item
left join public.catalog_reconciliation_cases reconciliation
  on item.source_type = 'reconciliation_case' and reconciliation.id = item.source_id
left join collision on collision.source_record_id = reconciliation.source_record_id
where item.status in ('open', 'in_progress')
  and item.handling_class = 'human_exception';

-- La compuerta pasa a tener una sola definición. El plan de reprocesamiento
-- consulta el mismo veredicto que se le muestra a la propietaria, en vez de
-- repetir las condiciones y arriesgarse a que las dos lecturas se separen.
create view public.catalog_review_reprocess_plan_v1
with (security_invoker = true) as
with classified as (
  select
    item.*,
    queue.queue_state as previous_queue_state,
    reconciliation.status as reconciliation_status,
    reconciliation.algorithm,
    reconciliation.score,
    reconciliation.evidence as reconciliation_evidence,
    exception.status as exception_status,
    gap.status as gap_status,
    case
      when item.source_type = 'reconciliation_case'
        and item.status = 'resolved'
        and reconciliation.status = 'approved'
        and coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'historical_contradiction'
      when item.source_type = 'reconciliation_case'
        and reconciliation.status = 'superseded'
        then 'source_superseded'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'exact_normalized_tone_or_official_code_v1'
        and reconciliation.score = 1
        and public.search_normalize(reconciliation.evidence->>'internal_tone') =
            public.search_normalize(reconciliation.evidence->>'official_tone')
        and reconciliation.evidence->>'official_url' ~ '^https?://'
        then 'objective_tone_identity'
      -- El algoritmo puntuó 1 por igualdad del código de tono, no del título.
      -- Exigir además igualdad de cadena completa devolvía a la propietaria
      -- identidades que la fuente oficial ya había resuelto.
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'exact_normalized_tone_or_official_code_v1'
        and reconciliation.score = 1
        and public.catalog_review_tone_code_v1(reconciliation.evidence->>'internal_tone') is not null
        and public.catalog_review_tone_code_v1(reconciliation.evidence->>'internal_tone') =
            public.catalog_review_tone_code_v1(reconciliation.evidence->>'official_tone')
        and reconciliation.evidence->>'official_url' ~ '^https?://'
        then 'objective_tone_code_identity'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'official_product_name_and_code_v1'
        and reconciliation.score = 1
        and not coalesce((reconciliation.evidence->>'ambiguous')::boolean, false)
        and reconciliation.evidence->>'source_match_status' = 'CONFIRMADO_OFICIAL'
        and reconciliation.evidence->>'official_url' ~ '^https?://'
        then 'objective_product_identity'
      when item.handling_class = 'physical_capture'
        and coalesce((item.context->>'officialEvidenceSatisfiesPhysicalCapture')::boolean, false)
        and exists (
          select 1 from public.catalog_evidence_sets evidence
          where evidence.id::text = item.context->>'evidenceSetId'
            and evidence.decision_status = 'approved'
            and evidence.evidence_type in ('official_sources', 'physical_packaging')
        )
        then 'official_evidence_resolves_capture'
      when item.handling_class = 'waiting_external'
        and coalesce((item.context->>'externalDependencySatisfied')::boolean, false)
        and exists (
          select 1 from public.catalog_evidence_sets evidence
          where evidence.id::text = item.context->>'evidenceSetId'
            and evidence.decision_status = 'approved'
        )
        then 'approved_evidence_resolves_wait'
      when item.source_type = 'relation_candidate'
        then 'relation_deferred_stage4'
      when item.source_type = 'reconciliation_case'
        and reconciliation.algorithm = 'official_identity_v1'
        and reconciliation.status = 'proposed'
        and not coalesce((reconciliation.evidence->>'classificationContradiction')::boolean, false)
        then 'external_candidate_signal'
      when item.status in ('open', 'in_progress')
        and item.purpose = 'image'
        and not item.has_contradiction
        and not coalesce((item.context->>'requiresOwnPhotography')::boolean, false)
        and coalesce(item.context->'details'->>'source_exception_type', '') <> 'REQUIERE_FOTOGRAFIA_PROPIA'
        and coalesce(item.context->'details'->>'required_action', '') not in (
          'INCLUIR_EN_SESION_FOTOGRAFICA', 'FOTOGRAFIAR_FRENTE_REVERSO_CODIGO_Y_MEDIDAS'
        )
        then 'image_automatic_debt'
      when necessity.verdict is not null and necessity.verdict <> 'human_decision'
        then necessity.verdict
      else 'unchanged'
    end as rule_code
  from public.catalog_review_work_items item
  join public.catalog_review_queue_v1 queue on queue.id = item.id
  left join public.catalog_reconciliation_cases reconciliation
    on item.source_type = 'reconciliation_case' and reconciliation.id = item.source_id
  left join public.catalog_review_necessity_v1 necessity on necessity.work_item_id = item.id
  left join public.catalog_enrichment_exceptions exception
    on item.source_type = 'enrichment_exception' and exception.id = item.source_id
  left join public.catalog_knowledge_gaps gap
    on item.source_type = 'knowledge_gap' and gap.id = item.source_id
), desired as (
  select
    classified.*,
    case
      when rule_code in (
        'objective_tone_identity', 'objective_tone_code_identity', 'objective_product_identity',
        'official_evidence_resolves_capture', 'approved_evidence_resolves_wait'
      ) then 'resolved'
      when rule_code = 'source_superseded' then 'superseded'
      else status
    end as target_status,
    case
      when rule_code in (
        'relation_deferred_stage4', 'external_candidate_signal', 'image_automatic_debt',
        'matcher_without_discriminator', 'matcher_collides_many_to_one',
        'matcher_candidates_indistinguishable', 'source_row_reference_unresolvable',
        'source_row_resemblance_too_weak', 'subject_without_commercial_footprint',
        'action_is_research_not_decision'
      ) then 'automatic_debt'
      else handling_class
    end as target_handling_class,
    case rule_code
      when 'objective_tone_identity' then 'auto_verified_identity'
      when 'objective_tone_code_identity' then 'auto_verified_identity'
      when 'objective_product_identity' then 'auto_verified_identity'
      when 'official_evidence_resolves_capture' then 'official_evidence_satisfied'
      when 'approved_evidence_resolves_wait' then 'external_evidence_satisfied'
      when 'source_superseded' then 'source_signal_superseded'
      else resolution_code
    end as target_resolution_code,
    case when rule_code = 'historical_contradiction' then
      'historical-contradiction:' || id::text || ':' || substr(md5(reconciliation_evidence::text), 1, 16)
    end as generated_work_family_key
  from classified
)
select
  desired.id as work_item_id,
  desired.work_key,
  desired.row_version as expected_row_version,
  desired.previous_queue_state,
  case
    when desired.rule_code = 'historical_contradiction' and not exists (
      select 1 from public.catalog_review_work_items existing
      where existing.work_family_key = desired.generated_work_family_key
    ) then 'new_historical_contradiction'
    when desired.status in ('resolved', 'superseded', 'cancelled') then 'audit_completed'
    when desired.target_status = 'resolved' then 'auto_resolve'
    when desired.target_status = 'superseded' then 'supersede'
    when desired.target_handling_class <> desired.handling_class then 'reclassify'
    else 'keep'
  end as planned_action,
  desired.rule_code,
  desired.target_status,
  desired.target_handling_class,
  desired.target_resolution_code,
  desired.generated_work_family_key,
  encode(extensions.digest(convert_to(jsonb_build_object(
    'workKey', desired.work_key,
    'rule', desired.rule_code,
    'targetStatus', desired.target_status,
    'targetHandlingClass', desired.target_handling_class,
    'targetResolutionCode', desired.target_resolution_code,
    'sourceStatus', coalesce(desired.reconciliation_status, desired.exception_status, desired.gap_status),
    'evidence', desired.reconciliation_evidence,
    'context', desired.context
  )::text, 'UTF8'), 'sha256'), 'hex') as evidence_fingerprint,
  jsonb_strip_nulls(jsonb_build_object(
    'previousStatus', desired.status,
    'previousHandlingClass', desired.handling_class,
    'previousQueueState', desired.previous_queue_state,
    'sourceType', desired.source_type,
    'sourceId', desired.source_id,
    'purpose', desired.purpose,
    'subjectType', desired.subject_type,
    'subjectId', desired.subject_id,
    'groupKey', desired.group_key,
    'question', desired.question,
    'recommendation', desired.recommendation,
    'hasContradiction', desired.has_contradiction,
    'historicalEvidence', desired.reconciliation_evidence
  )) as planned_payload
from desired;

-- Nada de esto es superficie pública. Son auxiliares de la Mesa y del plan de
-- reprocesamiento, así que ningún rol del catálogo público puede ejecutarlos.
revoke all on function public.catalog_review_source_row_link_v1(text)
  from public, anon, authenticated;
revoke all on function public.normalize_catalog_review_source_row_v1()
  from public, anon, authenticated;
revoke all on function public.catalog_review_discriminative_tokens_v1(text)
  from public, anon, authenticated;
revoke all on function public.catalog_review_tone_code_v1(text)
  from public, anon, authenticated;
revoke all on function public.catalog_review_commercial_weight_v1(text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.apply_catalog_review_commercial_weight_v1()
  from public, anon, authenticated;
grant select on public.catalog_review_necessity_v1 to authenticated, service_role;

commit;
