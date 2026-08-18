import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONTROLLED_SYSTEM_MANIFESTS = Object.freeze([
  "research/catalog-master/system-manifests/gel-polish.v1.json",
  "research/catalog-master/system-manifests/lash-extension.v1.json",
]);

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

export async function loadSystemManifest(rootDir, manifestPath) {
  const absolutePath = path.resolve(rootDir, manifestPath);
  const manifest = JSON.parse(await readFile(absolutePath, "utf8"));

  if (!manifest?.manifestKey || !manifest?.system?.code) {
    throw new Error(`El manifiesto ${absolutePath} no tiene identidad de expansión.`);
  }

  return { absolutePath, manifest };
}

export async function previewSystemExpansion(database, manifest, idempotencyKey) {
  return must(await database.rpc("preview_catalog_system_expansion_v1", {
    p_manifest: manifest,
    p_idempotency_key: idempotencyKey,
  }), "preview_catalog_system_expansion_v1");
}

export async function applySystemExpansion(database, preview, idempotencyKey) {
  return must(await database.rpc("apply_catalog_system_expansion_v1", {
    p_preview_id: preview.previewId,
    p_preview_fingerprint: preview.previewFingerprint,
    p_idempotency_key: idempotencyKey,
  }), "apply_catalog_system_expansion_v1");
}

export async function runSystemExpansion(database, manifest, keyPrefix) {
  const preview = await previewSystemExpansion(database, manifest, `${keyPrefix}:preview`);
  const applied = await applySystemExpansion(database, preview, `${keyPrefix}:apply`);
  return { preview, applied };
}

export async function getControlledExpansionReport(database) {
  return must(await database.rpc("get_catalog_controlled_expansion_report_v1"),
    "get_catalog_controlled_expansion_report_v1");
}
