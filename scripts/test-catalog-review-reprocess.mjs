import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "test-catalog-review-reprocess",
});
if (!isLocal) throw new Error("La prueba de reprocesamiento solo corre en local.");

const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function must(response, operation) {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

async function tableCount(table) {
  const response = await database.from(table).select("*", { count: "exact", head: true });
  must(response, `count ${table}`);
  return response.count ?? 0;
}

const protectedTables = [
  "products", "product_variants", "variant_prices", "inventory_stock", "product_media",
];
const beforeCommercial = Object.fromEntries(await Promise.all(
  protectedTables.map(async (table) => [table, await tableCount(table)]),
));
const reportBefore = must(
  await database.rpc("get_catalog_review_reprocess_report_v1"),
  "report before",
);
assert.equal(reportBefore.latestRun?.status, "applied", "Debe existir un reproceso real aplicado.");

const key = `stage3-idempotency:${Date.now()}`;
const preview = must(
  await database.rpc("preview_catalog_review_reprocess_v1", { p_idempotency_key: `${key}:preview` }),
  "idempotency preview",
);
const applied = must(await database.rpc("apply_catalog_review_reprocess_v1", {
  p_preview_id: preview.previewId,
  p_preview_fingerprint: preview.previewFingerprint,
  p_idempotency_key: `${key}:apply`,
}), "idempotency apply");

assert.equal(applied.actionCounts.changed, 0, "La segunda ejecución no puede cambiar trabajo.");
assert.equal(applied.actionCounts.newFromEvidence, 0, "La segunda ejecución no puede crear trabajo.");
assert.equal(applied.actionCounts.eventsCreated, 0, "La segunda ejecución no puede fabricar eventos.");
assert.equal(
  preview.logicalFingerprint,
  reportBefore.latestRun.logicalFingerprint,
  "La misma evidencia debe conservar el resultado lógico.",
);

const afterCommercial = Object.fromEntries(await Promise.all(
  protectedTables.map(async (table) => [table, await tableCount(table)]),
));
assert.deepEqual(afterCommercial, beforeCommercial, "El reproceso no puede tocar dominios comerciales.");

const duplicates = must(await database.from("catalog_review_reprocess_items")
  .select("reprocess_run_id,work_item_id"), "reprocess items");
assert.equal(
  new Set(duplicates.map((item) => `${item.reprocess_run_id}:${item.work_item_id}`)).size,
  duplicates.length,
  "No puede haber filas duplicadas en previews.",
);

process.stdout.write(`${JSON.stringify({
  result: "PASS",
  logicalFingerprint: preview.logicalFingerprint,
  metrics: applied.metricsAfter,
  actionCounts: applied.actionCounts,
  commercialGuard: { before: beforeCommercial, after: afterCommercial, unchanged: true },
}, null, 2)}\n`);
