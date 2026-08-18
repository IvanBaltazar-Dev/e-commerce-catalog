import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  CONTROLLED_SYSTEM_MANIFESTS,
  applySystemExpansion,
  getControlledExpansionReport,
  loadSystemManifest,
  previewSystemExpansion,
  runSystemExpansion,
} from "./lib/catalog-system-expansion.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "system:expand",
});
const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const [action = "report", ...args] = positionals;
let output;

if (action === "preview") {
  const [manifestPath, key = `system-expansion:${new Date().toISOString()}:preview`] = args;
  if (!manifestPath) throw new Error("Uso: preview <manifest.json> [clave-idempotente].");
  const { manifest } = await loadSystemManifest(ROOT, manifestPath);
  output = await previewSystemExpansion(database, manifest, key);
} else if (action === "apply") {
  const [previewId, previewFingerprint, key] = args;
  if (!previewId || !previewFingerprint || !key) {
    throw new Error("Uso: apply <preview-id> <huella-preview> <clave-idempotente>.");
  }
  output = await applySystemExpansion(database, {
    previewId,
    previewFingerprint,
  }, key);
} else if (action === "run") {
  const [manifestPath, keyPrefix] = args;
  if (!manifestPath || !keyPrefix) {
    throw new Error("Uso: run <manifest.json> <prefijo-idempotente>.");
  }
  const { manifest } = await loadSystemManifest(ROOT, manifestPath);
  output = await runSystemExpansion(database, manifest, keyPrefix);
} else if (action === "run-approved") {
  const results = [];
  for (const manifestPath of CONTROLLED_SYSTEM_MANIFESTS) {
    const { manifest } = await loadSystemManifest(ROOT, manifestPath);
    results.push(await runSystemExpansion(
      database,
      manifest,
      `controlled:${manifest.manifestKey}:v${manifest.manifestVersion}`,
    ));
  }
  output = { results, report: await getControlledExpansionReport(database) };
} else if (action === "report") {
  output = await getControlledExpansionReport(database);
} else {
  throw new Error("Acción inválida. Usa preview, apply, run, run-approved o report.");
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
