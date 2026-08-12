import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "catalog-review-reprocess",
});
if (!isLocal) throw new Error("Etapa 3 solo está autorizada contra el entorno local.");

const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function must(response, operation) {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

async function preview(key) {
  return must(
    await database.rpc("preview_catalog_review_reprocess_v1", { p_idempotency_key: key }),
    "preview_catalog_review_reprocess_v1",
  );
}

async function apply(previewId, fingerprint, key) {
  return must(
    await database.rpc("apply_catalog_review_reprocess_v1", {
      p_preview_id: previewId,
      p_preview_fingerprint: fingerprint,
      p_idempotency_key: key,
    }),
    "apply_catalog_review_reprocess_v1",
  );
}

async function report() {
  return must(await database.rpc("get_catalog_review_reprocess_report_v1"), "reprocess report");
}

const action = positionals[0] ?? "report";
let output;
if (action === "preview") {
  const key = positionals[1] ?? `stage3-preview:${new Date().toISOString()}`;
  output = await preview(key);
} else if (action === "apply") {
  const [previewId, fingerprint, key] = positionals.slice(1);
  if (!previewId || !fingerprint || !key) {
    throw new Error("Uso: apply <preview-id> <preview-fingerprint> <idempotency-key>.");
  }
  output = await apply(previewId, fingerprint, key);
} else if (action === "run") {
  const runKey = positionals[1] ?? `stage3:${new Date().toISOString()}`;
  const frozen = await preview(`${runKey}:preview`);
  const applied = await apply(
    frozen.previewId,
    frozen.previewFingerprint,
    `${runKey}:apply`,
  );
  output = { preview: frozen, apply: applied, report: await report() };
} else if (action === "report") {
  output = await report();
} else {
  throw new Error("Acción inválida. Usa preview, apply, run o report.");
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
