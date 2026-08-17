import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "relation:reprocess",
});
const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function preview(key, expectedCount = 323) {
  return must(await database.rpc("preview_catalog_relation_reprocess_v1", {
    p_idempotency_key: key,
    p_expected_candidate_count: expectedCount,
  }), "preview_catalog_relation_reprocess_v1");
}

async function apply(previewId, fingerprint, key) {
  return must(await database.rpc("apply_catalog_relation_reprocess_v1", {
    p_preview_id: previewId,
    p_preview_fingerprint: fingerprint,
    p_idempotency_key: key,
  }), "apply_catalog_relation_reprocess_v1");
}

async function report() {
  return must(await database.rpc("get_catalog_relation_reprocess_report_v1"),
    "get_catalog_relation_reprocess_report_v1");
}

const [action = "report", ...args] = positionals;
let output;

if (action === "preview") {
  const key = args[0] ?? `stage4b-preview:${new Date().toISOString()}`;
  const expectedCount = args[1] ? Number(args[1]) : 323;
  output = await preview(key, expectedCount);
} else if (action === "apply") {
  const [previewId, fingerprint, key] = args;
  if (!previewId || !fingerprint || !key) {
    throw new Error("Uso: apply <preview-id> <preview-fingerprint> <idempotency-key>.");
  }
  output = await apply(previewId, fingerprint, key);
} else if (action === "report") {
  output = await report();
} else {
  throw new Error("Accion invalida. Usa preview, apply o report.");
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
