import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "stage1:fixtures" });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ID = {
  source: "11000000-0000-4000-8000-000000000001",
  baselineRun: "11000000-0000-4000-8000-000000000010",
  baselineScope: "11000000-0000-4000-8000-000000000011",
  missingRun: "11000000-0000-4000-8000-000000000012",
  missingScope: "11000000-0000-4000-8000-000000000013",
  returnedRun: "11000000-0000-4000-8000-000000000014",
  returnedScope: "11000000-0000-4000-8000-000000000015",
  unchangedRun: "11000000-0000-4000-8000-000000000016",
  unchangedScope: "11000000-0000-4000-8000-000000000017",
  unavailableRun: "11000000-0000-4000-8000-000000000018",
  unavailableScope: "11000000-0000-4000-8000-000000000019",
  snapshot: "11000000-0000-4000-8000-000000000020",
  productRecord: "11000000-0000-4000-8000-000000000021",
  variantRecord: "11000000-0000-4000-8000-000000000022",
  referenceProduct: "11000000-0000-4000-8000-000000000030",
  referenceVariant: "11000000-0000-4000-8000-000000000031",
  firstProduct: "11000000-0000-4000-8000-000000000040",
  firstVariant: "11000000-0000-4000-8000-000000000041",
  missingProduct: "11000000-0000-4000-8000-000000000042",
  returnedProduct: "11000000-0000-4000-8000-000000000043",
  unchangedProduct: "11000000-0000-4000-8000-000000000044",
  unavailableSource: "11000000-0000-4000-8000-000000000045",
  redObservation: "11000000-0000-4000-8000-000000000050",
  blueObservation: "11000000-0000-4000-8000-000000000051",
  evidence: "11000000-0000-4000-8000-000000000060",
  price: "11000000-0000-4000-8000-000000000070",
  media: "11000000-0000-4000-8000-000000000071",
  reconciliation: "11000000-0000-4000-8000-000000000080",
  relationCandidate: "11000000-0000-4000-8000-000000000081",
};

function must(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function count(table) {
  const result = await admin.from(table).select("id", { head: true, count: "exact" });
  must(result, `count ${table}`);
  return result.count ?? 0;
}

const before = {
  products: await count("products"),
  variants: await count("product_variants"),
  prices: await count("variant_prices"),
};
const brand = must(await admin.from("brands").select("id").order("name").limit(1).single(), "brand");
const internalProducts = must(
  await admin.from("products").select("id").order("name").limit(2),
  "internal products",
);
if (internalProducts.length < 2) throw new Error("El fixture requiere dos productos internos sin modificarlos.");
const internalProduct = internalProducts[0];
const now = "2026-08-12T12:00:00.000Z";

must(
  await admin.from("catalog_sources").upsert({
    id: ID.source,
    source_key: "stage1-synthetic-reference",
    name: "Fuente sintética Etapa 1",
    authority: "official",
    adapter: "manual_capture",
    base_url: "https://stage1.invalid",
    brand_id: brand.id,
  }),
  "source",
);

const runs = [
  [ID.baselineRun, "stage1-fixture-baseline", "baseline", null, "baseline-input"],
  [ID.missingRun, "stage1-fixture-missing", "delta", ID.baselineRun, "missing-input"],
  [ID.returnedRun, "stage1-fixture-returned", "delta", ID.missingRun, "returned-input"],
  [ID.unchangedRun, "stage1-fixture-unchanged", "delta", ID.returnedRun, "unchanged-input"],
  [ID.unavailableRun, "stage1-fixture-unavailable", "targeted", ID.unchangedRun, "unavailable-input"],
];
must(
  await admin.from("catalog_research_runs").upsert(
    runs.map(([id, runKey, runKind, previousRunId, inputFingerprint]) => ({
      id,
      run_key: runKey,
      run_kind: runKind,
      previous_run_id: previousRunId,
      actor_kind: "codex",
      actor_label: "fixture sintético Etapa 1",
      status: "succeeded",
      started_at: now,
      finished_at: now,
      input_fingerprint: inputFingerprint,
      result_fingerprint: `${inputFingerprint}-result`,
      scope: { fixture: true },
      metrics: {},
      result: { fixture: true },
    })),
    { onConflict: "id" },
  ),
  "research runs",
);
must(
  await admin.from("catalog_research_run_brands").upsert(
    runs.map(([id]) => ({ research_run_id: id, brand_id: brand.id })),
    { onConflict: "research_run_id,brand_id", ignoreDuplicates: true },
  ),
  "research run brands",
);

const scopes = [
  [ID.baselineScope, ID.baselineRun, null, "first_seen"],
  [ID.missingScope, ID.missingRun, ID.baselineScope, "changed"],
  [ID.returnedScope, ID.returnedRun, ID.missingScope, "returned"],
  [ID.unchangedScope, ID.unchangedRun, ID.returnedScope, "unchanged"],
  [ID.unavailableScope, ID.unavailableRun, ID.unchangedScope, "source_unavailable"],
];
must(
  await admin.from("catalog_research_run_sources").upsert(
    scopes.map(([id, researchRunId, previousRunSourceId, sourceState]) => ({
      id,
      research_run_id: researchRunId,
      source_id: ID.source,
      brand_id: brand.id,
      scope_key: "all-products",
      previous_run_source_id: previousRunSourceId,
      status: sourceState === "source_unavailable" ? "failed" : "succeeded",
      source_state: sourceState,
      input_fingerprint: `${id}-input`,
      result_fingerprint: sourceState === "source_unavailable" ? null : `${id}-result`,
      scope: { fixture: true },
      metrics: {},
      errors: sourceState === "source_unavailable" ? ["synthetic outage"] : [],
      started_at: now,
      finished_at: now,
    })),
    { onConflict: "id" },
  ),
  "research scopes",
);

must(
  await admin.from("catalog_source_snapshots").upsert({
    id: ID.snapshot,
    source_id: ID.source,
    status: "succeeded",
    started_at: now,
    completed_at: now,
    content_hash: "stage1-fixture-content",
    product_count: 1,
    variant_count: 1,
  }),
  "snapshot",
);
must(
  await admin.from("catalog_source_records").upsert([
    {
      id: ID.productRecord,
      snapshot_id: ID.snapshot,
      source_id: ID.source,
      entity_type: "product",
      external_id: "stage1-external-product",
      title: "Producto externo jamás vendido",
      normalized_name: "producto externo jamas vendido",
      sku: "EXT-001",
      source_url: "https://stage1.invalid/products/external",
      captured_at: now,
    },
    {
      id: ID.variantRecord,
      snapshot_id: ID.snapshot,
      source_id: ID.source,
      entity_type: "variant",
      external_id: "stage1-external-variant-red",
      external_parent_id: "stage1-external-product",
      title: "Variante externa roja",
      normalized_name: "variante externa roja",
      sku: "EXT-RED",
      source_url: "https://stage1.invalid/products/external/red",
      primary_image_url: "https://stage1.invalid/images/red.jpg",
      captured_at: now,
    },
  ]),
  "source records",
);

must(
  await admin.from("catalog_reference_products").upsert({
    id: ID.referenceProduct,
    reference_key: "stage1-reference-product",
    brand_id: brand.id,
    primary_source_id: ID.source,
    primary_source_record_id: ID.productRecord,
    primary_external_id: "stage1-external-product",
    name: "Producto externo jamás vendido",
    normalized_name: "producto externo jamas vendido",
    family: "Esmaltes",
    product_type: "Esmalte",
    line: "Línea sintética",
    presentation: "10 ml",
    source_url: "https://stage1.invalid/products/external",
    identity_fingerprint: "stage1-identity-product",
    content_fingerprint: "stage1-content-product",
    enrichment_level: "REFERENCE_ENRICHED",
    knowledge_status: "matched_internal",
    presence_status: "present",
    first_seen_run_id: ID.baselineRun,
    last_seen_run_id: ID.unchangedRun,
    first_seen_at: now,
    last_seen_at: now,
  }),
  "reference product",
);
must(
  await admin.from("catalog_reference_variants").upsert({
    id: ID.referenceVariant,
    reference_product_id: ID.referenceProduct,
    reference_key: "stage1-reference-variant-red",
    primary_source_id: ID.source,
    primary_source_record_id: ID.variantRecord,
    primary_external_id: "stage1-external-variant-red",
    name: "Variante externa roja",
    normalized_name: "variante externa roja",
    sku: "EXT-RED",
    shade_name: "Rojo",
    presentation: "10 ml",
    source_url: "https://stage1.invalid/products/external/red",
    primary_image_url: "https://stage1.invalid/images/red.jpg",
    identity_fingerprint: "stage1-identity-variant-red",
    content_fingerprint: "stage1-content-variant-red",
    enrichment_level: "REFERENCE_LIGHT",
    knowledge_status: "observed",
    presence_status: "present",
    first_seen_run_id: ID.baselineRun,
    last_seen_run_id: ID.unchangedRun,
    first_seen_at: now,
    last_seen_at: now,
  }),
  "reference variant",
);

must(
  await admin.from("catalog_reference_identifiers").upsert([
    {
      id: "11000000-0000-4000-8000-000000000032",
      reference_product_id: ID.referenceProduct,
      source_id: ID.source,
      source_record_id: ID.productRecord,
      identifier_kind: "sku",
      observed_value: "EXT-001",
      normalized_value: "ext-001",
      first_seen_run_id: ID.baselineRun,
      last_seen_run_id: ID.unchangedRun,
      first_seen_at: now,
      last_seen_at: now,
    },
    {
      id: "11000000-0000-4000-8000-000000000033",
      reference_variant_id: ID.referenceVariant,
      source_id: ID.source,
      source_record_id: ID.variantRecord,
      identifier_kind: "sku",
      observed_value: "EXT-RED",
      normalized_value: "ext-red",
      first_seen_run_id: ID.baselineRun,
      last_seen_run_id: ID.unchangedRun,
      first_seen_at: now,
      last_seen_at: now,
    },
  ]),
  "identifiers",
);

must(
  await admin.from("catalog_reference_presence_events").upsert([
    { id: ID.firstProduct, research_run_source_id: ID.baselineScope, reference_product_id: ID.referenceProduct, delta_status: "first_seen", current_fingerprint: "stage1-content-product", observed_at: now },
    { id: ID.firstVariant, research_run_source_id: ID.baselineScope, reference_variant_id: ID.referenceVariant, delta_status: "first_seen", current_fingerprint: "stage1-content-variant-red", observed_at: now },
    { id: ID.missingProduct, research_run_source_id: ID.missingScope, reference_product_id: ID.referenceProduct, delta_status: "missing_from_source", previous_fingerprint: "stage1-content-product", current_fingerprint: null, observed_at: now },
    { id: ID.returnedProduct, research_run_source_id: ID.returnedScope, reference_product_id: ID.referenceProduct, delta_status: "returned", previous_fingerprint: "stage1-content-product", current_fingerprint: "stage1-content-product", observed_at: now },
    { id: ID.unchangedProduct, research_run_source_id: ID.unchangedScope, reference_product_id: ID.referenceProduct, delta_status: "unchanged", previous_fingerprint: "stage1-content-product", current_fingerprint: "stage1-content-product", observed_at: now },
    { id: ID.unavailableSource, research_run_source_id: ID.unavailableScope, delta_status: "source_unavailable", previous_fingerprint: "stage1-content-product", current_fingerprint: null, observed_at: now },
  ], { onConflict: "id", ignoreDuplicates: true }),
  "presence events",
);

must(
  await admin.from("catalog_observations").upsert([
    {
      id: ID.redObservation,
      observation_key: "stage1-fixture-shade-red",
      source_record_id: ID.variantRecord,
      research_run_id: ID.baselineRun,
      reference_variant_id: ID.referenceVariant,
      observation_kind: "shade",
      predicate: "shade_name",
      value_text: "Rojo",
      observed_at: now,
      extraction_method: "official_page",
      confidence: 0.95,
    },
    {
      id: ID.blueObservation,
      observation_key: "stage1-fixture-shade-blue",
      source_record_id: ID.variantRecord,
      research_run_id: ID.baselineRun,
      reference_variant_id: ID.referenceVariant,
      observation_kind: "shade",
      predicate: "shade_name",
      value_text: "Azul",
      observed_at: now,
      extraction_method: "manual_capture",
      confidence: 0.6,
    },
  ], { onConflict: "observation_key", ignoreDuplicates: true }),
  "observations",
);
must(
  await admin.from("catalog_evidence_sets").upsert({
    id: ID.evidence,
    evidence_key: "stage1-fixture-contradiction",
    version: 1,
    evidence_type: "official_sources",
    decision_status: "proposed",
    confidence: 0.8,
    metadata: { assertion: "shade_name=Rojo" },
  }),
  "evidence set",
);
must(
  await admin.from("catalog_evidence_items").upsert([
    { id: "11000000-0000-4000-8000-000000000061", evidence_set_id: ID.evidence, observation_id: ID.redObservation, stance: "supports" },
    { id: "11000000-0000-4000-8000-000000000062", evidence_set_id: ID.evidence, observation_id: ID.blueObservation, stance: "contradicts" },
  ]),
  "evidence items",
);
must(
  await admin.from("catalog_reference_prices").upsert({
    id: ID.price,
    price_key: "stage1-fixture-price",
    research_run_id: ID.baselineRun,
    reference_variant_id: ID.referenceVariant,
    source_id: ID.source,
    source_record_id: ID.variantRecord,
    currency: "COP",
    amount: 12900,
    presentation: "10 ml",
    external_availability: "available",
    observed_at: now,
    content_fingerprint: "stage1-price-content",
  }),
  "external price",
);
must(
  await admin.from("catalog_reference_media").upsert({
    id: ID.media,
    media_key: "stage1-fixture-image",
    reference_variant_id: ID.referenceVariant,
    source_id: ID.source,
    source_record_id: ID.variantRecord,
    media_kind: "image",
    remote_url: "https://stage1.invalid/images/red.jpg",
    validation_status: "remote_reference",
    first_seen_run_id: ID.baselineRun,
    last_seen_run_id: ID.unchangedRun,
    first_seen_at: now,
    last_seen_at: now,
  }),
  "reference media",
);
must(
  await admin.from("catalog_reconciliation_cases").upsert({
    id: ID.reconciliation,
    entity_type: "product",
    product_id: internalProduct.id,
    reference_product_id: ID.referenceProduct,
    source_record_id: ID.productRecord,
    research_run_id: ID.baselineRun,
    algorithm: "stage1_synthetic_exact_v1",
    score: 1,
    status: "approved",
    decision_reason: "Fixture sintético exacto",
    evidence: { fixture: true },
    decided_at: now,
  }),
  "reconciliation",
);
must(
  await admin.from("catalog_relation_candidates").upsert({
    id: ID.relationCandidate,
    source_product_id: internalProducts[0].id,
    target_product_id: internalProducts[1].id,
    relation_type: "recommended_with",
    confidence: "category_rule",
    status: "proposed",
    rule_code: "stage1_fixture_candidate",
    rationale: "Candidata sintética para demostrar separación semántica",
    evidence: { fixture: true },
  }),
  "relation candidate",
);

for (const [researchRunId, runKey, , , inputFingerprint] of runs) {
  must(
    await admin.rpc("finalize_catalog_research_run_v1", {
      p_research_run_id: researchRunId,
      p_status: runKey === "stage1-fixture-unavailable" ? "partial" : "succeeded",
      p_result_fingerprint: `${inputFingerprint}-result`,
      p_result: { fixture: true },
      p_errors: runKey === "stage1-fixture-unavailable" ? ["synthetic outage"] : [],
    }),
    `finalize ${runKey}`,
  );
}

const after = {
  products: await count("products"),
  variants: await count("product_variants"),
  prices: await count("variant_prices"),
};
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error(`El fixture contaminó catálogo comercial: ${JSON.stringify({ before, after })}`);
}

const knowledge = must(
  await admin.rpc("get_catalog_reference_knowledge_v1", { p_reference_key: "stage1-reference-product" }),
  "reference knowledge",
);
console.log(JSON.stringify({ referenceKey: "stage1-reference-product", commercialCounts: after, knowledge }, null, 2));
