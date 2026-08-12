-- 0103 · Contrato de proyección v2 y registro del Graph Projector
-- PostgreSQL sigue siendo autoridad; todas las filas de estas vistas son derivadas.

begin;

create table public.catalog_graph_projection_runs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  projector_version text not null,
  research_run_id uuid references public.catalog_research_runs(id) on delete set null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  postgres_fingerprint text,
  graph_fingerprint text,
  counts jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint catalog_graph_projection_runs_action_allowed check (action in ('status', 'sync', 'verify', 'rebuild')),
  constraint catalog_graph_projection_runs_version_not_blank check (length(trim(projector_version)) > 0),
  constraint catalog_graph_projection_runs_status_allowed check (status in ('running', 'succeeded', 'failed')),
  constraint catalog_graph_projection_runs_completion_consistent check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  constraint catalog_graph_projection_runs_json_shapes check (
    jsonb_typeof(counts) = 'object'
    and jsonb_typeof(errors) = 'array'
    and jsonb_typeof(verification) = 'object'
  )
);

create index catalog_graph_projection_runs_date_idx
  on public.catalog_graph_projection_runs(started_at desc, action, status);
create index catalog_graph_projection_runs_research_idx
  on public.catalog_graph_projection_runs(research_run_id, started_at desc)
  where research_run_id is not null;

create or replace view public.graph_nodes_v2_base
with (security_invoker = true) as
select node_key, node_type, entity_id, label, 'canonical'::text as layer, properties
from public.graph_product_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_variant_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_class_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_system_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_stage_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_brand_nodes_v1
union all select node_key, node_type, entity_id, label, 'canonical', properties from public.graph_supplier_nodes_v1
union all
select
  'category:' || category.id::text,
  'Category',
  category.id,
  category.name,
  'canonical',
  jsonb_strip_nulls(jsonb_build_object(
    'slug', category.slug,
    'parentId', category.parent_id,
    'templateId', category.template_id,
    'sortOrder', category.sort_order,
    'isActive', category.is_active
  ))
from public.categories category
union all
select
  'shade:' || shade.id::text,
  'Shade',
  shade.id,
  shade.name,
  'canonical',
  jsonb_strip_nulls(jsonb_build_object(
    'code', shade.code,
    'brandId', shade.brand_id,
    'lineId', shade.product_line_id,
    'referenceColor', shade.reference_color,
    'isActive', shade.is_active
  ))
from public.color_shades shade
union all
select
  'role:' || role.id::text,
  'Role',
  role.id,
  role.name,
  'canonical',
  jsonb_build_object('code', role.code, 'kind', role.role_kind, 'isActive', role.is_active)
from public.catalog_roles role
union all
select
  'source:' || source.id::text,
  'Source',
  source.id,
  source.name,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'sourceKey', source.source_key,
    'authority', source.authority,
    'adapter', source.adapter,
    'baseUrl', source.base_url,
    'brandId', source.brand_id,
    'isActive', source.is_active
  ))
from public.catalog_sources source
union all
select
  'reference_product:' || reference.id::text,
  'ReferenceProduct',
  reference.id,
  reference.name,
  'reference',
  jsonb_strip_nulls(jsonb_build_object(
    'referenceKey', reference.reference_key,
    'brandId', reference.brand_id,
    'primarySourceId', reference.primary_source_id,
    'externalId', reference.primary_external_id,
    'normalizedName', reference.normalized_name,
    'family', reference.family,
    'productType', reference.product_type,
    'line', reference.line,
    'presentation', reference.presentation,
    'sourceUrl', reference.source_url,
    'imageUrl', reference.primary_image_url,
    'enrichmentLevel', reference.enrichment_level,
    'knowledgeStatus', reference.knowledge_status,
    'presenceStatus', reference.presence_status,
    'firstSeenAt', reference.first_seen_at,
    'lastSeenAt', reference.last_seen_at
  ))
from public.catalog_reference_products reference
union all
select
  'reference_variant:' || variant.id::text,
  'ReferenceVariant',
  variant.id,
  variant.name,
  'reference',
  jsonb_strip_nulls(jsonb_build_object(
    'referenceKey', variant.reference_key,
    'referenceProductId', variant.reference_product_id,
    'primarySourceId', variant.primary_source_id,
    'externalId', variant.primary_external_id,
    'normalizedName', variant.normalized_name,
    'sku', variant.sku,
    'barcode', variant.barcode,
    'shadeName', variant.shade_name,
    'presentation', variant.presentation,
    'sourceUrl', variant.source_url,
    'imageUrl', variant.primary_image_url,
    'enrichmentLevel', variant.enrichment_level,
    'knowledgeStatus', variant.knowledge_status,
    'presenceStatus', variant.presence_status,
    'firstSeenAt', variant.first_seen_at,
    'lastSeenAt', variant.last_seen_at
  ))
from public.catalog_reference_variants variant
union all
select
  'observation:' || observation.id::text,
  'Observation',
  observation.id,
  observation.predicate,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'observationKey', observation.observation_key,
    'kind', observation.observation_kind,
    'predicate', observation.predicate,
    'subjectRef', observation.target_ref,
    'objectRef', observation.object_ref,
    'valueText', observation.value_text,
    'valueNumber', observation.value_number,
    'valueBoolean', observation.value_boolean,
    'valueDate', observation.value_date,
    'valueJson', observation.value_json,
    'unit', observation.observed_unit,
    'confidence', observation.confidence,
    'observedAt', observation.observed_at,
    'sourceRecordId', observation.source_record_id
  ))
from public.catalog_observations observation
union all
select
  'evidence_set:' || evidence.id::text,
  'EvidenceSet',
  evidence.id,
  evidence.evidence_key || ':v' || evidence.version::text,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'evidenceKey', evidence.evidence_key,
    'version', evidence.version,
    'type', evidence.evidence_type,
    'decisionStatus', evidence.decision_status,
    'confidence', evidence.confidence,
    'rationale', evidence.rationale
  ))
from public.catalog_evidence_sets evidence
union all
select
  'relation_candidate:' || candidate.id::text,
  'RelationCandidate',
  candidate.id,
  candidate.rule_code,
  'candidate',
  jsonb_build_object(
    'relationType', candidate.relation_type,
    'confidence', candidate.confidence,
    'status', candidate.status,
    'rationale', candidate.rationale,
    'resolutionKind', candidate.resolution_kind
  )
from public.catalog_relation_candidates candidate
union all
select
  'external_price:' || price.id::text,
  'ExternalPrice',
  price.id,
  price.currency || ' ' || price.amount::text,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'priceKey', price.price_key,
    'subjectRef', price.target_ref,
    'sourceId', price.source_id,
    'currency', price.currency,
    'amount', price.amount,
    'presentation', price.presentation,
    'availability', price.external_availability,
    'observedAt', price.observed_at
  ))
from public.catalog_reference_prices price
union all
select
  'reference_media:' || media.id::text,
  'ReferenceMedia',
  media.id,
  media.media_kind || ':' || media.media_key,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'mediaKey', media.media_key,
    'subjectRef', media.target_ref,
    'sourceId', media.source_id,
    'kind', media.media_kind,
    'remoteUrl', media.remote_url,
    'contentHash', media.content_hash,
    'mimeType', media.mime_type,
    'validationStatus', media.validation_status
  ))
from public.catalog_reference_media media
union all
select
  'research_run:' || run.id::text,
  'ResearchRun',
  run.id,
  run.run_key,
  'evidence',
  jsonb_build_object(
    'runKey', run.run_key,
    'runKind', run.run_kind,
    'actorKind', run.actor_kind,
    'actorLabel', run.actor_label,
    'status', run.status,
    'startedAt', run.started_at,
    'finishedAt', run.finished_at,
    'inputFingerprint', run.input_fingerprint,
    'resultFingerprint', run.result_fingerprint
  )
from public.catalog_research_runs run
union all
select
  'presence_event:' || event.id::text,
  'PresenceEvent',
  event.id,
  event.delta_status,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object(
    'deltaStatus', event.delta_status,
    'subjectRef', event.target_ref,
    'previousFingerprint', event.previous_fingerprint,
    'currentFingerprint', event.current_fingerprint,
    'observedAt', event.observed_at
  ))
from public.catalog_reference_presence_events event;

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
from public.graph_nodes_v2_base node;

create or replace view public.graph_edges_v2_base
with (security_invoker = true) as
select edge_key, source_key, predicate, target_key, 'canonical'::text as layer, properties
from public.graph_variant_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_brand_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_stage_system_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_system_role_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_class_membership_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_relation_edges_v1
union all select edge_key, source_key, predicate, target_key, 'canonical', properties from public.graph_supplier_edges_v1
union all
select
  'product-category:' || product.id::text,
  'product:' || product.id::text,
  'IN_CATEGORY',
  'category:' || product.category_id::text,
  'canonical',
  '{}'::jsonb
from public.products product where product.category_id is not null
union all
select
  'variant-shade:' || variant.id::text,
  'variant:' || variant.id::text,
  'HAS_SHADE',
  'shade:' || variant.color_shade_id::text,
  'canonical',
  '{}'::jsonb
from public.product_variants variant where variant.color_shade_id is not null
union all
select
  'expected-role:' || expected.id::text || ':system',
  'system:' || expected.system_id::text,
  'EXPECTS_ROLE',
  'role:' || expected.role_id::text,
  'canonical',
  jsonb_build_object('stageId', expected.stage_id, 'necessity', expected.necessity)
from public.catalog_system_stage_roles expected
where expected.is_active and expected.decision_status = 'approved'
union all
select
  'expected-role:' || expected.id::text || ':stage',
  'stage:' || expected.stage_id::text,
  'EXPECTS_ROLE',
  'role:' || expected.role_id::text,
  'canonical',
  jsonb_build_object('systemId', expected.system_id, 'necessity', expected.necessity)
from public.catalog_system_stage_roles expected
where expected.is_active and expected.decision_status = 'approved'
union all
select
  'reference-variant:' || variant.id::text,
  'reference_product:' || variant.reference_product_id::text,
  'HAS_REFERENCE_VARIANT',
  'reference_variant:' || variant.id::text,
  'reference',
  '{}'::jsonb
from public.catalog_reference_variants variant
union all
select
  'reference-brand:' || reference.id::text,
  'reference_product:' || reference.id::text,
  'IDENTIFIED_BRAND',
  'brand:' || reference.brand_id::text,
  'reference',
  '{}'::jsonb
from public.catalog_reference_products reference
union all
select
  'reference-source:' || reference.id::text,
  'reference_product:' || reference.id::text,
  'OBSERVED_AT',
  'source:' || reference.primary_source_id::text,
  'evidence',
  jsonb_build_object('externalId', reference.primary_external_id)
from public.catalog_reference_products reference
union all
select
  'reference-variant-source:' || variant.id::text,
  'reference_variant:' || variant.id::text,
  'OBSERVED_AT',
  'source:' || variant.primary_source_id::text,
  'evidence',
  jsonb_build_object('externalId', variant.primary_external_id)
from public.catalog_reference_variants variant
union all
select
  'observation-subject:' || observation.id::text,
  'observation:' || observation.id::text,
  'OBSERVES',
  observation.target_ref,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object('predicate', observation.predicate, 'objectRef', observation.object_ref))
from public.catalog_observations observation
union all
select
  'observation-source:' || observation.id::text,
  'observation:' || observation.id::text,
  'OBSERVED_AT',
  'source:' || record.source_id::text,
  'evidence',
  jsonb_build_object('sourceRecordId', record.id)
from public.catalog_observations observation
join public.catalog_source_records record on record.id = observation.source_record_id
union all
select
  'observation-object:' || observation.id::text,
  'observation:' || observation.id::text,
  'ASSERTS_RELATION_TO',
  observation.object_ref,
  'evidence',
  jsonb_build_object('predicate', observation.predicate)
from public.catalog_observations observation
where observation.object_ref is not null
union all
select
  'reference-match:' || reconciliation.id::text,
  case
    when reconciliation.reference_product_id is not null then 'reference_product:' || reconciliation.reference_product_id::text
    else 'reference_variant:' || reconciliation.reference_variant_id::text
  end,
  'MATCHES',
  case
    when reconciliation.product_id is not null then 'product:' || reconciliation.product_id::text
    else 'variant:' || reconciliation.variant_id::text
  end,
  'canonical',
  jsonb_build_object('algorithm', reconciliation.algorithm, 'score', reconciliation.score)
from public.catalog_reconciliation_cases reconciliation
where reconciliation.status = 'approved'
  and num_nonnulls(reconciliation.reference_product_id, reconciliation.reference_variant_id) = 1
union all
select
  'evidence-observation:' || item.id::text,
  'evidence_set:' || item.evidence_set_id::text,
  case when item.stance = 'supports' then 'SUPPORTS_OBSERVATION' else 'CONTRADICTS_OBSERVATION' end,
  'observation:' || item.observation_id::text,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object('notes', item.notes))
from public.catalog_evidence_items item
where item.observation_id is not null
union all
select
  'evidence-source:' || item.id::text,
  'evidence_set:' || item.evidence_set_id::text,
  case when item.stance = 'supports' then 'SUPPORTED_BY_SOURCE' else 'CONTRADICTED_BY_SOURCE' end,
  'source:' || record.source_id::text,
  'evidence',
  jsonb_strip_nulls(jsonb_build_object('sourceRecordId', record.id, 'notes', item.notes))
from public.catalog_evidence_items item
join public.catalog_source_records record on record.id = item.source_record_id
where item.source_record_id is not null
union all
select
  'candidate-source:' || candidate.id::text,
  'relation_candidate:' || candidate.id::text,
  'CANDIDATE_SOURCE',
  'product:' || candidate.source_product_id::text,
  'candidate',
  '{}'::jsonb
from public.catalog_relation_candidates candidate
union all
select
  'candidate-target:' || candidate.id::text,
  'relation_candidate:' || candidate.id::text,
  'CANDIDATE_TARGET',
  'product:' || candidate.target_product_id::text,
  'candidate',
  '{}'::jsonb
from public.catalog_relation_candidates candidate
union all
select
  'price-subject:' || price.id::text,
  'external_price:' || price.id::text,
  'PRICE_FOR',
  price.target_ref,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_prices price
union all
select
  'price-source:' || price.id::text,
  'external_price:' || price.id::text,
  'OBSERVED_AT',
  'source:' || price.source_id::text,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_prices price
union all
select
  'media-subject:' || media.id::text,
  'reference_media:' || media.id::text,
  'MEDIA_FOR',
  media.target_ref,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_media media
union all
select
  'media-source:' || media.id::text,
  'reference_media:' || media.id::text,
  'OBSERVED_AT',
  'source:' || media.source_id::text,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_media media
union all
select
  'run-source:' || scope.id::text,
  'research_run:' || scope.research_run_id::text,
  'RESEARCHED_SOURCE',
  'source:' || scope.source_id::text,
  'evidence',
  jsonb_build_object('scopeKey', scope.scope_key, 'sourceState', scope.source_state, 'status', scope.status)
from public.catalog_research_run_sources scope
union all
select
  'run-delta:' || event.id::text,
  'research_run:' || scope.research_run_id::text,
  'PRODUCED_DELTA',
  'presence_event:' || event.id::text,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_presence_events event
join public.catalog_research_run_sources scope on scope.id = event.research_run_source_id
union all
select
  'delta-subject:' || event.id::text,
  'presence_event:' || event.id::text,
  'DESCRIBES',
  case
    when event.reference_product_id is not null then 'reference_product:' || event.reference_product_id::text
    when event.reference_variant_id is not null then 'reference_variant:' || event.reference_variant_id::text
    else 'source:' || scope.source_id::text
  end,
  'evidence',
  '{}'::jsonb
from public.catalog_reference_presence_events event
join public.catalog_research_run_sources scope on scope.id = event.research_run_source_id;

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
from public.graph_edges_v2_base edge;

create or replace view public.graph_projection_manifest_v2
with (security_invoker = true) as
select * from (values
  ('v2', 'node', '*', 'graph_nodes_v2', 'Nodos canónicos, de referencia, evidencia y candidatas con layer obligatorio'),
  ('v2', 'edge', '*', 'graph_edges_v2', 'Aristas tipadas con hechos y candidatas semánticamente separadas')
) contract(version, record_kind, graph_type, view_name, description);

alter table public.catalog_graph_projection_runs enable row level security;
create policy "admins manage graph projection runs" on public.catalog_graph_projection_runs
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.catalog_graph_projection_runs to authenticated, service_role;
grant select on
  public.graph_nodes_v2_base,
  public.graph_nodes_v2,
  public.graph_edges_v2_base,
  public.graph_edges_v2,
  public.graph_projection_manifest_v2
to authenticated, service_role;

comment on view public.graph_nodes_v2 is
  'Contrato paginable del Graph Projector. Product/Variant son comerciales; Reference* nunca lo son.';
comment on view public.graph_edges_v2 is
  'Contrato paginable con layer. CANDIDATE_* y evidencia nunca se confunden con relaciones canónicas.';

commit;
