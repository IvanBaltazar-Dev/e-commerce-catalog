import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { catalogResearchPath } from "./lib/catalog-research-paths.mjs";


const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const DATA = catalogResearchPath(ROOT, "data");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "catalog-enrichment-stage" });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const sourceKeyByBrand = {
  Masglo: "masglo-es-official",
  Admiss: "admiss-co-official",
  AcryLove: "acrylove-official",
  "MC Nails": "mc-nails-mx-official",
  Cherimoya: "cherimoya-pe-official",
  Bigen: "bigen-usa-official",
};

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers, ...body] = rows;
  return body.filter((cells) => cells.some(Boolean)).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])));
}

async function csv(name) {
  return parseCsv(await fs.readFile(path.join(DATA, name), "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanObject(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== ""));
}

async function insertBatches(table, rows, size = 400) {
  for (let offset = 0; offset < rows.length; offset += size) {
    const { error } = await admin.from(table).insert(rows.slice(offset, offset + size));
    if (error) throw new Error(`${table} batch ${offset}: ${error.message}`);
  }
}

async function upsertBatches(table, rows, onConflict, size = 400) {
  for (let offset = 0; offset < rows.length; offset += size) {
    const { error } = await admin.from(table).upsert(rows.slice(offset, offset + size), { onConflict });
    if (error) throw new Error(`${table} batch ${offset}: ${error.message}`);
  }
}

async function selectAll(table, columns, configure = (query) => query, size = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += size) {
    const query = configure(admin.from(table).select(columns).range(offset, offset + size - 1));
    const { data, error } = await query;
    if (error) throw new Error(`${table} page ${offset}: ${error.message}`);
    rows.push(...data);
    if (data.length < size) return rows;
  }
}

function reconciliationKey(row) {
  const internalId = row.product_id || row.variant_id || row.shade_id;
  return `${row.entity_type}:${internalId}:${row.source_record_id}`;
}

async function stageReconciliationCases(algorithm, desiredRows) {
  const activeRows = await selectAll(
    "catalog_reconciliation_cases",
    "id, entity_type, product_id, variant_id, shade_id, source_record_id, status",
    (query) => query.eq("algorithm", algorithm).in("status", ["proposed", "needs_review", "approved"]),
  );
  const desiredKeys = new Set(desiredRows.map(reconciliationKey));
  const existingKeys = new Set(activeRows.map(reconciliationKey));
  const staleIds = activeRows
    .filter((row) => row.status !== "approved" && !desiredKeys.has(reconciliationKey(row)))
    .map((row) => row.id);

  for (let offset = 0; offset < staleIds.length; offset += 200) {
    const { error } = await admin
      .from("catalog_reconciliation_cases")
      .update({
        status: "superseded",
        decided_at: new Date().toISOString(),
        decision_reason: "Replaced by a newer official snapshot.",
      })
      .in("id", staleIds.slice(offset, offset + 200));
    if (error) throw new Error(`supersede ${algorithm} cases: ${error.message}`);
  }

  const missingRows = desiredRows.filter((row) => !existingKeys.has(reconciliationKey(row)));
  if (missingRows.length) await insertBatches("catalog_reconciliation_cases", missingRows);
  return missingRows.length;
}

const [summaries, products, variants, images, tones, productMatches, relations, exceptions] = await Promise.all([
  csv("external_official_sources_summary.csv"),
  csv("external_official_products.csv"),
  csv("external_official_variants.csv"),
  csv("external_official_images.csv"),
  csv("internal_official_tone_reconciliation.csv"),
  csv("internal_official_product_reconciliation.csv"),
  csv("product_relation_candidates.csv"),
  csv("master_exception_register.csv"),
]);

const { data: sourceRows, error: sourceError } = await admin
  .from("catalog_sources")
  .select("id, source_key, brand_id, base_url");
if (sourceError) throw new Error(`catalog_sources: ${sourceError.message}`);
const sources = Object.fromEntries(sourceRows.map((row) => [row.source_key, row]));

const latestSnapshotByBrand = new Map();
let newSnapshots = 0;
let stagedRecords = 0;

for (const summary of summaries) {
  const sourceKey = sourceKeyByBrand[summary.brand];
  const source = sources[sourceKey];
  if (!source) throw new Error(`Missing seeded catalog source: ${sourceKey}`);
  const brandProducts = products.filter((row) => row.brand === summary.brand);
  const brandVariants = variants.filter((row) => row.brand === summary.brand);
  const brandImages = images.filter((row) => row.brand === summary.brand);
  const contentHash = sha256(JSON.stringify({
    products: brandProducts.map((row) => [row.external_product_id, row.updated_at, row.title]),
    variants: brandVariants.map((row) => [row.external_variant_id, row.sku, row.price]),
    images: brandImages.map((row) => [row.external_image_id, row.image_url]),
  }));

  const expectedRecords = brandProducts.length + brandVariants.length + brandImages.length;
  const { data: foundExisting, error: existingError } = await admin
    .from("catalog_source_snapshots")
    .select("id, completed_at")
    .eq("source_id", source.id)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existingError) throw new Error(`snapshot lookup ${summary.brand}: ${existingError.message}`);

  let existing = foundExisting;
  if (existing) {
    const { count, error: countError } = await admin
      .from("catalog_source_records")
      .select("id", { count: "exact", head: true })
      .eq("snapshot_id", existing.id);
    if (countError) throw new Error(`snapshot record count ${summary.brand}: ${countError.message}`);
    if (count !== expectedRecords) {
      const { error: deleteError } = await admin.from("catalog_source_snapshots").delete().eq("id", existing.id);
      if (deleteError) throw new Error(`discard incomplete snapshot ${summary.brand}: ${deleteError.message}`);
      existing = null;
    }
  }

  let snapshot = existing;
  if (!snapshot) {
    const completedAt = summary.captured_at || new Date().toISOString();
    const { data, error } = await admin.from("catalog_source_snapshots").insert({
      source_id: source.id,
      status: "running",
      started_at: completedAt,
      content_hash: contentHash,
      raw_storage_path: `local-storage://sources/${summary.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      product_count: Number(summary.products),
      variant_count: Number(summary.variants),
      image_count: Number(summary.images),
      metadata: { capture: "official_bulk_adapter", source_type: summary.source_type },
    }).select("id").single();
    if (error) throw new Error(`snapshot insert ${summary.brand}: ${error.message}`);
    snapshot = data;
    newSnapshots += 1;

    const records = [
      ...brandProducts.map((row) => ({
        snapshot_id: snapshot.id,
        source_id: source.id,
        entity_type: "product",
        external_id: `p:${row.external_product_id}`,
        title: row.title,
        normalized_name: normalizeName(row.title),
        source_url: row.source_product_url,
        primary_image_url: row.primary_image_url || null,
        payload: cleanObject(row),
        captured_at: row.captured_at,
      })),
      ...brandVariants.map((row) => ({
        snapshot_id: snapshot.id,
        source_id: source.id,
        entity_type: "variant",
        external_id: `v:${row.external_variant_id}`,
        external_parent_id: `p:${row.external_product_id}`,
        title: `${row.product_title} / ${row.variant_title}`,
        normalized_name: normalizeName(`${row.product_title} ${row.variant_title}`),
        sku: row.sku || null,
        barcode: row.barcode || null,
        source_url: row.source_product_url,
        payload: cleanObject(row),
        captured_at: row.captured_at,
      })),
      ...brandImages.map((row) => ({
        snapshot_id: snapshot.id,
        source_id: source.id,
        entity_type: "image",
        external_id: `i:${row.external_product_id}:${row.external_image_id || "none"}:${row.image_position}`,
        external_parent_id: `p:${row.external_product_id}`,
        title: `${summary.brand} image ${row.external_product_id}/${row.image_position}`,
        normalized_name: normalizeName(`${summary.brand} image ${row.external_product_id} ${row.image_position}`),
        source_url: row.source_product_url,
        primary_image_url: row.image_url,
        payload: cleanObject(row),
        captured_at: row.captured_at,
      })),
    ];
    await insertBatches("catalog_source_records", records);
    stagedRecords += records.length;
    const { data: completedSnapshot, error: completionError } = await admin
      .from("catalog_source_snapshots")
      .update({ status: "succeeded", completed_at: completedAt })
      .eq("id", snapshot.id)
      .select("id, completed_at")
      .single();
    if (completionError) throw new Error(`snapshot completion ${summary.brand}: ${completionError.message}`);
    snapshot = completedSnapshot;
  }

  latestSnapshotByBrand.set(summary.brand, { source, snapshot });
  const { error: sourceUpdateError } = await admin.from("catalog_sources").update({ last_success_at: snapshot.completed_at }).eq("id", source.id);
  if (sourceUpdateError) throw new Error(`source refresh ${summary.brand}: ${sourceUpdateError.message}`);
}

const sourceRecordIds = new Map();
for (const [brand, context] of latestSnapshotByBrand.entries()) {
  const records = await selectAll(
    "catalog_source_records",
    "id, entity_type, external_id",
    (query) => query
      .eq("snapshot_id", context.snapshot.id)
      .in("entity_type", ["product", "variant"]),
  );
  for (const row of records) sourceRecordIds.set(`${brand}:${row.entity_type}:${row.external_id}`, row.id);
}

const confirmedTones = tones.filter((row) => row.match_status === "CONFIRMADO_OFICIAL");
const desiredReconciliationCases = confirmedTones.map((row) => {
  const brand = row.internal_brand === "BIGEN" ? "Bigen" : row.internal_brand;
  const entityType = row.official_variant_id ? "variant" : "product";
  const externalId = row.official_variant_id ? `v:${row.official_variant_id}` : `p:${row.official_product_id}`;
  const sourceRecordId = sourceRecordIds.get(`${brand}:${entityType}:${externalId}`);
  if (!sourceRecordId) throw new Error(`Missing source record for ${brand}/${entityType}/${externalId}`);
  return {
    entity_type: "shade",
    shade_id: row.internal_shade_id,
    source_record_id: sourceRecordId,
    algorithm: "exact_normalized_tone_or_official_code_v1",
    score: 1,
    status: "needs_review",
    evidence: {
      internal_tone: row.internal_shade_name,
      official_tone: row.official_tone,
      official_url: row.official_product_url,
      official_image_url: row.official_image_url,
    },
  };
});
const toneReconciliationCases = await stageReconciliationCases(
  "exact_normalized_tone_or_official_code_v1",
  desiredReconciliationCases,
);

const officialBrandName = {
  ACRYLOVE: "AcryLove",
  BIGEN: "Bigen",
  "MC NAILS": "MC Nails",
};
const desiredProductCases = productMatches.map((row) => {
  const brand = officialBrandName[row.internal_brand] || row.internal_brand;
  const externalId = `p:${row.official_product_id}`;
  const sourceRecordId = sourceRecordIds.get(`${brand}:product:${externalId}`);
  if (!sourceRecordId) throw new Error(`Missing product source record for ${brand}/${externalId}`);
  return {
    entity_type: "product",
    product_id: row.internal_product_id,
    source_record_id: sourceRecordId,
    algorithm: "official_product_name_and_code_v1",
    score: Number(row.match_score),
    status: "needs_review",
    evidence: {
      source_match_status: row.match_status,
      ambiguous: row.ambiguous === "True",
      internal_name: row.internal_product_name,
      internal_code: row.internal_product_code,
      official_title: row.official_title,
      official_line: row.official_line,
      official_url: row.official_product_url,
      official_image_url: row.official_primary_image_url,
      candidate_2: row.candidate_2 || null,
      candidate_2_score: row.candidate_2_score ? Number(row.candidate_2_score) : null,
      candidate_3: row.candidate_3 || null,
      candidate_3_score: row.candidate_3_score ? Number(row.candidate_3_score) : null,
    },
  };
});
const productReconciliationCases = await stageReconciliationCases(
  "official_product_name_and_code_v1",
  desiredProductCases,
);

const relationRows = relations.map((row) => ({
  source_product_id: row.source_product_id,
  target_product_id: row.target_product_id,
  relation_type: row.relation_type,
  confidence: row.confidence === "INFERIDO_MISMA_MARCA" ? "same_brand_rule" : "category_rule",
  status: "needs_evidence",
  rule_code: `${row.source_role}->${row.target_role}`,
  rationale: row.rationale,
  evidence: { validation_required: row.validation_required, generated_from: "catalog_process_rule_v1" },
}));
const existingRelations = await selectAll(
  "catalog_relation_candidates",
  "source_product_id, target_product_id, relation_type, rule_code, status, decided_by, decided_at, evidence, resolution_kind, promoted_product_relation_id, promoted_relation_rule_id, promoted_system_role_id, promoted_class_member_id",
);
const existingRelationByKey = new Map(existingRelations.map((row) => [
  `${row.source_product_id}:${row.target_product_id}:${row.relation_type}:${row.rule_code}`,
  row,
]));
const preservedRelationRows = relationRows.map((row) => {
  const existing = existingRelationByKey.get(`${row.source_product_id}:${row.target_product_id}:${row.relation_type}:${row.rule_code}`);
  return existing ? {
    ...row,
    status: existing.status,
    decided_by: existing.decided_by,
    decided_at: existing.decided_at,
    evidence: { ...row.evidence, ...(existing.evidence || {}) },
    resolution_kind: existing.resolution_kind,
    promoted_product_relation_id: existing.promoted_product_relation_id,
    promoted_relation_rule_id: existing.promoted_relation_rule_id,
    promoted_system_role_id: existing.promoted_system_role_id,
    promoted_class_member_id: existing.promoted_class_member_id,
  } : row;
});
await upsertBatches("catalog_relation_candidates", preservedRelationRows, "source_product_id,target_product_id,relation_type,rule_code");

const { data: acrylicCandidateClassification, error: acrylicCandidateClassificationError } = await admin
  .rpc("classify_acrylic_relation_candidates_v1");
if (acrylicCandidateClassificationError) {
  throw new Error(`classify_acrylic_relation_candidates_v1: ${acrylicCandidateClassificationError.message}`);
}

const { data: brands, error: brandsError } = await admin.from("brands").select("id, name");
if (brandsError) throw new Error(`brands lookup: ${brandsError.message}`);
const brandIdByName = Object.fromEntries(brands.map((row) => [row.name.toLowerCase(), row.id]));

function exceptionType(row) {
  if (row.exception_scope === "TONE") return "tone_missing";
  if (row.exception_scope === "IMAGE_RIGHTS_AND_REPRESENTATION") return "image_ambiguous";
  if (row.exception_scope === "IMAGE") return row.exception_type === "REQUIERE_FOTOGRAFIA_PROPIA" ? "physical_capture_required" : "image_missing";
  if (row.exception_scope === "BRAND" && row.exception_type === "REQUIERE_LEVANTAMIENTO_FISICO") return "physical_capture_required";
  return "identity_ambiguous";
}

const exceptionRows = exceptions.map((row) => {
  const productOrVariantId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(row.entity_key) ? row.entity_key : null;
  return {
    exception_key: sha256(`${row.exception_scope}|${row.entity_key}|${row.exception_type}`),
    brand_id: brandIdByName[row.brand.toLowerCase()] || null,
    variant_id: row.exception_scope === "IMAGE" ? productOrVariantId : null,
    shade_id: row.exception_scope === "TONE" ? productOrVariantId : null,
    exception_type: exceptionType(row),
    severity: row.severity.toLowerCase(),
    status: "open",
    title: `${row.exception_scope}: ${row.entity_name}`.slice(0, 500),
    details: cleanObject({
      source_scope: row.exception_scope,
      source_key: row.entity_key,
      source_exception_type: row.exception_type,
      evidence: row.evidence,
      required_action: row.required_action,
      publish_allowed: row.publish_allowed,
    }),
  };
});
const existingExceptions = await selectAll(
  "catalog_enrichment_exceptions",
  "id, exception_key, status, details, resolution_notes, resolved_by, resolved_at",
);
const existingExceptionByKey = new Map(existingExceptions.map((row) => [row.exception_key, row]));
const desiredExceptionKeys = new Set(exceptionRows.map((row) => row.exception_key));
const staleExceptionIds = existingExceptions
  .filter((row) => ["open", "in_review"].includes(row.status) && !desiredExceptionKeys.has(row.exception_key))
  .map((row) => row.id);

for (let offset = 0; offset < staleExceptionIds.length; offset += 200) {
  const { error } = await admin
    .from("catalog_enrichment_exceptions")
    .update({
      status: "superseded",
      resolution_notes: "La excepción dejó de ser emitida por el último corte del pipeline.",
      resolved_at: new Date().toISOString(),
    })
    .in("id", staleExceptionIds.slice(offset, offset + 200));
  if (error) throw new Error(`supersede enrichment exceptions: ${error.message}`);
}

const preservedExceptionRows = exceptionRows.map((row) => {
  const existing = existingExceptionByKey.get(row.exception_key);
  if (!existing) return row;

  if (existing.status === "superseded") {
    const previousOccurrence = Number(existing.details?.occurrence_version || 0);
    return {
      ...row,
      status: "open",
      details: { ...row.details, occurrence_version: previousOccurrence + 1 },
      resolution_notes: null,
      resolved_by: null,
      resolved_at: null,
    };
  }

  const decided = ["resolved", "waived"].includes(existing.status);
  return {
    ...row,
    details: decided ? existing.details : row.details,
    status: existing.status,
    resolution_notes: existing.resolution_notes,
    resolved_by: existing.resolved_by,
    resolved_at: existing.resolved_at,
  };
});
await upsertBatches("catalog_enrichment_exceptions", preservedExceptionRows, "exception_key");

const { data: reviewWorkflow, error: reviewWorkflowError } = await admin
  .rpc("sync_catalog_review_work_items_v1");
if (reviewWorkflowError) {
  throw new Error(`sync_catalog_review_work_items_v1: ${reviewWorkflowError.message}`);
}
const { data: reviewDependencies, error: reviewDependenciesError } = await admin
  .rpc("refresh_catalog_review_dependencies_v1");
if (reviewDependenciesError) {
  throw new Error(`refresh_catalog_review_dependencies_v1: ${reviewDependenciesError.message}`);
}

console.log(JSON.stringify({
  newSnapshots,
  stagedRecords,
  toneReconciliationCases,
  productReconciliationCases,
  relationCandidates: relationRows.length,
  acrylicCandidateClassification,
  exceptions: exceptionRows.length,
  supersededExceptions: staleExceptionIds.length,
  reviewWorkflow,
  reviewDependencies,
}, null, 2));
