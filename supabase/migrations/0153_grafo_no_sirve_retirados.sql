-- 0153 · Las vistas del grafo dejan de servir derivaciones retiradas.
--
-- Marcar una fila como superseded no basta si la lectura activa no lo mira.
-- Comprobado: tras retirar las 1.395 variantes falsas de Cherimoya,
-- graph_nodes_v2_base seguía devolviendo las 1.395. La fila estaba marcada y
-- circulaba igual, que es la peor combinación: parece resuelto y no lo está.
--
-- El arreglo es apuntar esas dos lecturas a las vistas «vigentes» en vez de a
-- las tablas base. La tabla base conserva la historia; el grafo, que es una
-- proyección de lo que está en circulación, deja de verla.

begin;

create or replace view public.graph_nodes_v2_base as
 SELECT graph_product_nodes_v1.node_key,
    graph_product_nodes_v1.node_type,
    graph_product_nodes_v1.entity_id,
    graph_product_nodes_v1.label,
    'canonical'::text AS layer,
    graph_product_nodes_v1.properties
   FROM graph_product_nodes_v1
UNION ALL
 SELECT graph_variant_nodes_v1.node_key,
    graph_variant_nodes_v1.node_type,
    graph_variant_nodes_v1.entity_id,
    graph_variant_nodes_v1.label,
    'canonical'::text AS layer,
    graph_variant_nodes_v1.properties
   FROM graph_variant_nodes_v1
UNION ALL
 SELECT graph_class_nodes_v1.node_key,
    graph_class_nodes_v1.node_type,
    graph_class_nodes_v1.entity_id,
    graph_class_nodes_v1.label,
    'canonical'::text AS layer,
    graph_class_nodes_v1.properties
   FROM graph_class_nodes_v1
UNION ALL
 SELECT graph_system_nodes_v1.node_key,
    graph_system_nodes_v1.node_type,
    graph_system_nodes_v1.entity_id,
    graph_system_nodes_v1.label,
    'canonical'::text AS layer,
    graph_system_nodes_v1.properties
   FROM graph_system_nodes_v1
UNION ALL
 SELECT graph_stage_nodes_v1.node_key,
    graph_stage_nodes_v1.node_type,
    graph_stage_nodes_v1.entity_id,
    graph_stage_nodes_v1.label,
    'canonical'::text AS layer,
    graph_stage_nodes_v1.properties
   FROM graph_stage_nodes_v1
UNION ALL
 SELECT graph_brand_nodes_v1.node_key,
    graph_brand_nodes_v1.node_type,
    graph_brand_nodes_v1.entity_id,
    graph_brand_nodes_v1.label,
    'canonical'::text AS layer,
    graph_brand_nodes_v1.properties
   FROM graph_brand_nodes_v1
UNION ALL
 SELECT graph_supplier_nodes_v1.node_key,
    graph_supplier_nodes_v1.node_type,
    graph_supplier_nodes_v1.entity_id,
    graph_supplier_nodes_v1.label,
    'canonical'::text AS layer,
    graph_supplier_nodes_v1.properties
   FROM graph_supplier_nodes_v1
UNION ALL
 SELECT ('category:'::text || (category.id)::text) AS node_key,
    'Category'::text AS node_type,
    category.id AS entity_id,
    category.name AS label,
    'canonical'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('slug', category.slug, 'parentId', category.parent_id, 'templateId', category.template_id, 'sortOrder', category.sort_order, 'isActive', category.is_active)) AS properties
   FROM categories category
UNION ALL
 SELECT ('shade:'::text || (shade.id)::text) AS node_key,
    'Shade'::text AS node_type,
    shade.id AS entity_id,
    shade.name AS label,
    'canonical'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('code', shade.code, 'brandId', shade.brand_id, 'lineId', shade.product_line_id, 'referenceColor', shade.reference_color, 'isActive', shade.is_active)) AS properties
   FROM color_shades shade
UNION ALL
 SELECT ('role:'::text || (role.id)::text) AS node_key,
    'Role'::text AS node_type,
    role.id AS entity_id,
    role.name AS label,
    'canonical'::text AS layer,
    jsonb_build_object('code', role.code, 'kind', role.role_kind, 'isActive', role.is_active) AS properties
   FROM catalog_roles role
UNION ALL
 SELECT ('source:'::text || (source.id)::text) AS node_key,
    'Source'::text AS node_type,
    source.id AS entity_id,
    source.name AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('sourceKey', source.source_key, 'authority', source.authority, 'adapter', source.adapter, 'baseUrl', source.base_url, 'brandId', source.brand_id, 'isActive', source.is_active)) AS properties
   FROM catalog_sources source
UNION ALL
 SELECT ('reference_product:'::text || (reference.id)::text) AS node_key,
    'ReferenceProduct'::text AS node_type,
    reference.id AS entity_id,
    reference.name AS label,
    'reference'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('referenceKey', reference.reference_key, 'brandId', reference.brand_id, 'primarySourceId', reference.primary_source_id, 'externalId', reference.primary_external_id, 'normalizedName', reference.normalized_name, 'family', reference.family, 'productType', reference.product_type, 'line', reference.line, 'presentation', reference.presentation, 'sourceUrl', reference.source_url, 'imageUrl', reference.primary_image_url, 'enrichmentLevel', reference.enrichment_level, 'knowledgeStatus', reference.knowledge_status, 'presenceStatus', reference.presence_status, 'firstSeenAt', reference.first_seen_at, 'lastSeenAt', reference.last_seen_at)) AS properties
   FROM catalog_reference_products reference
UNION ALL
 SELECT ('reference_variant:'::text || (variant.id)::text) AS node_key,
    'ReferenceVariant'::text AS node_type,
    variant.id AS entity_id,
    variant.name AS label,
    'reference'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('referenceKey', variant.reference_key, 'referenceProductId', variant.reference_product_id, 'primarySourceId', variant.primary_source_id, 'externalId', variant.primary_external_id, 'normalizedName', variant.normalized_name, 'sku', variant.sku, 'barcode', variant.barcode, 'shadeName', variant.shade_name, 'presentation', variant.presentation, 'sourceUrl', variant.source_url, 'imageUrl', variant.primary_image_url, 'enrichmentLevel', variant.enrichment_level, 'knowledgeStatus', variant.knowledge_status, 'presenceStatus', variant.presence_status, 'firstSeenAt', variant.first_seen_at, 'lastSeenAt', variant.last_seen_at)) AS properties
   FROM public.catalog_reference_variants_vigentes_v1 variant
UNION ALL
 SELECT ('observation:'::text || (observation.id)::text) AS node_key,
    'Observation'::text AS node_type,
    observation.id AS entity_id,
    observation.predicate AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('observationKey', observation.observation_key, 'kind', observation.observation_kind, 'predicate', observation.predicate, 'subjectRef', observation.target_ref, 'objectRef', observation.object_ref, 'valueText', observation.value_text, 'valueNumber', observation.value_number, 'valueBoolean', observation.value_boolean, 'valueDate', observation.value_date, 'valueJson', observation.value_json, 'unit', observation.observed_unit, 'confidence', observation.confidence, 'observedAt', observation.observed_at, 'sourceRecordId', observation.source_record_id)) AS properties
   FROM catalog_observations observation
UNION ALL
 SELECT ('evidence_set:'::text || (evidence.id)::text) AS node_key,
    'EvidenceSet'::text AS node_type,
    evidence.id AS entity_id,
    ((evidence.evidence_key || ':v'::text) || (evidence.version)::text) AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('evidenceKey', evidence.evidence_key, 'version', evidence.version, 'type', evidence.evidence_type, 'decisionStatus', evidence.decision_status, 'confidence', evidence.confidence, 'rationale', evidence.rationale)) AS properties
   FROM catalog_evidence_sets evidence
UNION ALL
 SELECT ('relation_candidate:'::text || (candidate.id)::text) AS node_key,
    'RelationCandidate'::text AS node_type,
    candidate.id AS entity_id,
    candidate.rule_code AS label,
    'candidate'::text AS layer,
    jsonb_build_object('relationType', candidate.relation_type, 'confidence', candidate.confidence, 'status', candidate.status, 'rationale', candidate.rationale, 'resolutionKind', candidate.resolution_kind) AS properties
   FROM catalog_relation_candidates candidate
UNION ALL
 SELECT ('external_price:'::text || (price.id)::text) AS node_key,
    'ExternalPrice'::text AS node_type,
    price.id AS entity_id,
    ((price.currency || ' '::text) || (price.amount)::text) AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('priceKey', price.price_key, 'subjectRef', price.target_ref, 'sourceId', price.source_id, 'currency', price.currency, 'amount', price.amount, 'presentation', price.presentation, 'availability', price.external_availability, 'observedAt', price.observed_at)) AS properties
   FROM public.catalog_reference_prices_vigentes_v1 price
UNION ALL
 SELECT ('reference_media:'::text || (media.id)::text) AS node_key,
    'ReferenceMedia'::text AS node_type,
    media.id AS entity_id,
    ((media.media_kind || ':'::text) || media.media_key) AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('mediaKey', media.media_key, 'subjectRef', media.target_ref, 'sourceId', media.source_id, 'kind', media.media_kind, 'remoteUrl', media.remote_url, 'contentHash', media.content_hash, 'mimeType', media.mime_type, 'validationStatus', media.validation_status)) AS properties
   FROM catalog_reference_media media
UNION ALL
 SELECT ('research_run:'::text || (run.id)::text) AS node_key,
    'ResearchRun'::text AS node_type,
    run.id AS entity_id,
    run.run_key AS label,
    'evidence'::text AS layer,
    jsonb_build_object('runKey', run.run_key, 'runKind', run.run_kind, 'actorKind', run.actor_kind, 'actorLabel', run.actor_label, 'status', run.status, 'startedAt', run.started_at, 'finishedAt', run.finished_at, 'inputFingerprint', run.input_fingerprint, 'resultFingerprint', run.result_fingerprint) AS properties
   FROM catalog_research_runs run
UNION ALL
 SELECT ('presence_event:'::text || (event.id)::text) AS node_key,
    'PresenceEvent'::text AS node_type,
    event.id AS entity_id,
    event.delta_status AS label,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('deltaStatus', event.delta_status, 'subjectRef', event.target_ref, 'previousFingerprint', event.previous_fingerprint, 'currentFingerprint', event.current_fingerprint, 'observedAt', event.observed_at)) AS properties
   FROM catalog_reference_presence_events event;

create or replace view public.graph_edges_v2_base as
 SELECT graph_variant_edges_v1.edge_key,
    graph_variant_edges_v1.source_key,
    graph_variant_edges_v1.predicate,
    graph_variant_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_variant_edges_v1.properties
   FROM graph_variant_edges_v1
UNION ALL
 SELECT graph_brand_edges_v1.edge_key,
    graph_brand_edges_v1.source_key,
    graph_brand_edges_v1.predicate,
    graph_brand_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_brand_edges_v1.properties
   FROM graph_brand_edges_v1
UNION ALL
 SELECT graph_stage_system_edges_v1.edge_key,
    graph_stage_system_edges_v1.source_key,
    graph_stage_system_edges_v1.predicate,
    graph_stage_system_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_stage_system_edges_v1.properties
   FROM graph_stage_system_edges_v1
UNION ALL
 SELECT graph_system_role_edges_v1.edge_key,
    graph_system_role_edges_v1.source_key,
    graph_system_role_edges_v1.predicate,
    graph_system_role_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_system_role_edges_v1.properties
   FROM graph_system_role_edges_v1
UNION ALL
 SELECT graph_class_membership_edges_v1.edge_key,
    graph_class_membership_edges_v1.source_key,
    graph_class_membership_edges_v1.predicate,
    graph_class_membership_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_class_membership_edges_v1.properties
   FROM graph_class_membership_edges_v1
UNION ALL
 SELECT graph_relation_edges_v1.edge_key,
    graph_relation_edges_v1.source_key,
    graph_relation_edges_v1.predicate,
    graph_relation_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_relation_edges_v1.properties
   FROM graph_relation_edges_v1
UNION ALL
 SELECT graph_supplier_edges_v1.edge_key,
    graph_supplier_edges_v1.source_key,
    graph_supplier_edges_v1.predicate,
    graph_supplier_edges_v1.target_key,
    'canonical'::text AS layer,
    graph_supplier_edges_v1.properties
   FROM graph_supplier_edges_v1
UNION ALL
 SELECT ('product-category:'::text || (product.id)::text) AS edge_key,
    ('product:'::text || (product.id)::text) AS source_key,
    'IN_CATEGORY'::text AS predicate,
    ('category:'::text || (product.category_id)::text) AS target_key,
    'canonical'::text AS layer,
    '{}'::jsonb AS properties
   FROM products product
  WHERE (product.category_id IS NOT NULL)
UNION ALL
 SELECT ('variant-shade:'::text || (variant.id)::text) AS edge_key,
    ('variant:'::text || (variant.id)::text) AS source_key,
    'HAS_SHADE'::text AS predicate,
    ('shade:'::text || (variant.color_shade_id)::text) AS target_key,
    'canonical'::text AS layer,
    '{}'::jsonb AS properties
   FROM product_variants variant
  WHERE (variant.color_shade_id IS NOT NULL)
UNION ALL
 SELECT (('expected-role:'::text || (expected.id)::text) || ':system'::text) AS edge_key,
    ('system:'::text || (expected.system_id)::text) AS source_key,
    'EXPECTS_ROLE'::text AS predicate,
    ('role:'::text || (expected.role_id)::text) AS target_key,
    'canonical'::text AS layer,
    jsonb_build_object('stageId', expected.stage_id, 'necessity', expected.necessity) AS properties
   FROM catalog_system_stage_roles expected
  WHERE (expected.is_active AND (expected.decision_status = 'approved'::text))
UNION ALL
 SELECT (('expected-role:'::text || (expected.id)::text) || ':stage'::text) AS edge_key,
    ('stage:'::text || (expected.stage_id)::text) AS source_key,
    'EXPECTS_ROLE'::text AS predicate,
    ('role:'::text || (expected.role_id)::text) AS target_key,
    'canonical'::text AS layer,
    jsonb_build_object('systemId', expected.system_id, 'necessity', expected.necessity) AS properties
   FROM catalog_system_stage_roles expected
  WHERE (expected.is_active AND (expected.decision_status = 'approved'::text))
UNION ALL
 SELECT ('reference-variant:'::text || (variant.id)::text) AS edge_key,
    ('reference_product:'::text || (variant.reference_product_id)::text) AS source_key,
    'HAS_REFERENCE_VARIANT'::text AS predicate,
    ('reference_variant:'::text || (variant.id)::text) AS target_key,
    'reference'::text AS layer,
    '{}'::jsonb AS properties
   FROM public.catalog_reference_variants_vigentes_v1 variant
UNION ALL
 SELECT ('reference-brand:'::text || (reference.id)::text) AS edge_key,
    ('reference_product:'::text || (reference.id)::text) AS source_key,
    'IDENTIFIED_BRAND'::text AS predicate,
    ('brand:'::text || (reference.brand_id)::text) AS target_key,
    'reference'::text AS layer,
    '{}'::jsonb AS properties
   FROM catalog_reference_products reference
UNION ALL
 SELECT ('reference-source:'::text || (reference.id)::text) AS edge_key,
    ('reference_product:'::text || (reference.id)::text) AS source_key,
    'OBSERVED_AT'::text AS predicate,
    ('source:'::text || (reference.primary_source_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_build_object('externalId', reference.primary_external_id) AS properties
   FROM catalog_reference_products reference
UNION ALL
 SELECT ('reference-variant-source:'::text || (variant.id)::text) AS edge_key,
    ('reference_variant:'::text || (variant.id)::text) AS source_key,
    'OBSERVED_AT'::text AS predicate,
    ('source:'::text || (variant.primary_source_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_build_object('externalId', variant.primary_external_id) AS properties
   FROM public.catalog_reference_variants_vigentes_v1 variant
UNION ALL
 SELECT ('observation-subject:'::text || (observation.id)::text) AS edge_key,
    ('observation:'::text || (observation.id)::text) AS source_key,
    'OBSERVES'::text AS predicate,
    observation.target_ref AS target_key,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('predicate', observation.predicate, 'objectRef', observation.object_ref)) AS properties
   FROM catalog_observations observation
UNION ALL
 SELECT ('observation-source:'::text || (observation.id)::text) AS edge_key,
    ('observation:'::text || (observation.id)::text) AS source_key,
    'OBSERVED_AT'::text AS predicate,
    ('source:'::text || (record.source_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_build_object('sourceRecordId', record.id) AS properties
   FROM (catalog_observations observation
     JOIN catalog_source_records record ON ((record.id = observation.source_record_id)))
UNION ALL
 SELECT ('observation-object:'::text || (observation.id)::text) AS edge_key,
    ('observation:'::text || (observation.id)::text) AS source_key,
    'ASSERTS_RELATION_TO'::text AS predicate,
    observation.object_ref AS target_key,
    'evidence'::text AS layer,
    jsonb_build_object('predicate', observation.predicate) AS properties
   FROM catalog_observations observation
  WHERE (observation.object_ref IS NOT NULL)
UNION ALL
 SELECT ('reference-match:'::text || (reconciliation.id)::text) AS edge_key,
        CASE
            WHEN (reconciliation.reference_product_id IS NOT NULL) THEN ('reference_product:'::text || (reconciliation.reference_product_id)::text)
            ELSE ('reference_variant:'::text || (reconciliation.reference_variant_id)::text)
        END AS source_key,
    'MATCHES'::text AS predicate,
        CASE
            WHEN (reconciliation.product_id IS NOT NULL) THEN ('product:'::text || (reconciliation.product_id)::text)
            ELSE ('variant:'::text || (reconciliation.variant_id)::text)
        END AS target_key,
    'canonical'::text AS layer,
    jsonb_build_object('algorithm', reconciliation.algorithm, 'score', reconciliation.score) AS properties
   FROM catalog_reconciliation_cases reconciliation
  WHERE ((reconciliation.status = 'approved'::text) AND (num_nonnulls(reconciliation.reference_product_id, reconciliation.reference_variant_id) = 1))
UNION ALL
 SELECT ('evidence-observation:'::text || (item.id)::text) AS edge_key,
    ('evidence_set:'::text || (item.evidence_set_id)::text) AS source_key,
        CASE
            WHEN (item.stance = 'supports'::text) THEN 'SUPPORTS_OBSERVATION'::text
            ELSE 'CONTRADICTS_OBSERVATION'::text
        END AS predicate,
    ('observation:'::text || (item.observation_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('notes', item.notes)) AS properties
   FROM catalog_evidence_items item
  WHERE (item.observation_id IS NOT NULL)
UNION ALL
 SELECT ('evidence-source:'::text || (item.id)::text) AS edge_key,
    ('evidence_set:'::text || (item.evidence_set_id)::text) AS source_key,
        CASE
            WHEN (item.stance = 'supports'::text) THEN 'SUPPORTED_BY_SOURCE'::text
            ELSE 'CONTRADICTED_BY_SOURCE'::text
        END AS predicate,
    ('source:'::text || (record.source_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_strip_nulls(jsonb_build_object('sourceRecordId', record.id, 'notes', item.notes)) AS properties
   FROM (catalog_evidence_items item
     JOIN catalog_source_records record ON ((record.id = item.source_record_id)))
  WHERE (item.source_record_id IS NOT NULL)
UNION ALL
 SELECT ('candidate-source:'::text || (candidate.id)::text) AS edge_key,
    ('relation_candidate:'::text || (candidate.id)::text) AS source_key,
    'CANDIDATE_SOURCE'::text AS predicate,
    ('product:'::text || (candidate.source_product_id)::text) AS target_key,
    'candidate'::text AS layer,
    '{}'::jsonb AS properties
   FROM catalog_relation_candidates candidate
UNION ALL
 SELECT ('candidate-target:'::text || (candidate.id)::text) AS edge_key,
    ('relation_candidate:'::text || (candidate.id)::text) AS source_key,
    'CANDIDATE_TARGET'::text AS predicate,
    ('product:'::text || (candidate.target_product_id)::text) AS target_key,
    'candidate'::text AS layer,
    '{}'::jsonb AS properties
   FROM catalog_relation_candidates candidate
UNION ALL
 SELECT ('price-subject:'::text || (price.id)::text) AS edge_key,
    ('external_price:'::text || (price.id)::text) AS source_key,
    'PRICE_FOR'::text AS predicate,
    price.target_ref AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM public.catalog_reference_prices_vigentes_v1 price
UNION ALL
 SELECT ('price-source:'::text || (price.id)::text) AS edge_key,
    ('external_price:'::text || (price.id)::text) AS source_key,
    'OBSERVED_AT'::text AS predicate,
    ('source:'::text || (price.source_id)::text) AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM public.catalog_reference_prices_vigentes_v1 price
UNION ALL
 SELECT ('media-subject:'::text || (media.id)::text) AS edge_key,
    ('reference_media:'::text || (media.id)::text) AS source_key,
    'MEDIA_FOR'::text AS predicate,
    media.target_ref AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM catalog_reference_media media
UNION ALL
 SELECT ('media-source:'::text || (media.id)::text) AS edge_key,
    ('reference_media:'::text || (media.id)::text) AS source_key,
    'OBSERVED_AT'::text AS predicate,
    ('source:'::text || (media.source_id)::text) AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM catalog_reference_media media
UNION ALL
 SELECT ('run-source:'::text || (scope.id)::text) AS edge_key,
    ('research_run:'::text || (scope.research_run_id)::text) AS source_key,
    'RESEARCHED_SOURCE'::text AS predicate,
    ('source:'::text || (scope.source_id)::text) AS target_key,
    'evidence'::text AS layer,
    jsonb_build_object('scopeKey', scope.scope_key, 'sourceState', scope.source_state, 'status', scope.status) AS properties
   FROM catalog_research_run_sources scope
UNION ALL
 SELECT ('run-delta:'::text || (event.id)::text) AS edge_key,
    ('research_run:'::text || (scope.research_run_id)::text) AS source_key,
    'PRODUCED_DELTA'::text AS predicate,
    ('presence_event:'::text || (event.id)::text) AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM (catalog_reference_presence_events event
     JOIN catalog_research_run_sources scope ON ((scope.id = event.research_run_source_id)))
UNION ALL
 SELECT ('delta-subject:'::text || (event.id)::text) AS edge_key,
    ('presence_event:'::text || (event.id)::text) AS source_key,
    'DESCRIBES'::text AS predicate,
        CASE
            WHEN (event.reference_product_id IS NOT NULL) THEN ('reference_product:'::text || (event.reference_product_id)::text)
            WHEN (event.reference_variant_id IS NOT NULL) THEN ('reference_variant:'::text || (event.reference_variant_id)::text)
            ELSE ('source:'::text || (scope.source_id)::text)
        END AS target_key,
    'evidence'::text AS layer,
    '{}'::jsonb AS properties
   FROM (catalog_reference_presence_events event
     JOIN catalog_research_run_sources scope ON ((scope.id = event.research_run_source_id)));

commit;
