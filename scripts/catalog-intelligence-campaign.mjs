import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  CONTROLLED_SYSTEM_MANIFESTS,
  loadSystemManifest,
  runSystemExpansion,
} from "./lib/catalog-system-expansion.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import {
  createGraphDriverFromEnv,
  createPostgresPoolFromEnv,
  GraphProjector,
} from "../src/lib/catalog-intelligence/graph-projector.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "catalog:intelligence",
  allowedFlags: [
    "--source-key", "--brand", "--campaign-key", "--campaign-id", "--skip-research",
  ],
});
if (!isLocal) throw new Error("La campaña unificada solo está autorizada contra el entorno local.");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function must(response, operation) {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

function parseChildJson(stdout, label) {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`${label} no devolvió un objeto JSON.`);
  try {
    return JSON.parse(stdout.slice(start));
  } catch (error) {
    throw new Error(`${label} devolvió JSON inválido: ${error.message}`);
  }
}

function runChild(script, args, label) {
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`${label} falló: ${(child.stderr || child.stdout || "sin detalle").trim()}`);
  }
  return parseChildJson(child.stdout, label);
}

const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sourceKey = option("--source-key") ?? "admiss-co-official";
const requestedBrand = option("--brand");
const campaignKey = option("--campaign-key")
  ?? `manual:${sourceKey}:${new Date().toISOString().slice(0, 10)}`;
const runResearch = !process.argv.includes("--skip-research");

async function sourceContext() {
  const source = must(await database.from("catalog_sources")
    .select("id,source_key,brand_id,brands!inner(id,name)")
    .eq("source_key", sourceKey)
    .single(), "catalog source");
  const brand = source.brands;
  if (requestedBrand && requestedBrand.localeCompare(brand.name, undefined, {
    sensitivity: "base",
  }) !== 0) {
    throw new Error(`La fuente ${sourceKey} pertenece a ${brand.name}, no a ${requestedBrand}.`);
  }
  return { source, brand };
}

async function preview() {
  return must(await database.rpc("preview_catalog_intelligence_campaign_v1", {
    p_source_key: sourceKey,
    p_campaign_key: campaignKey,
    p_options: {
      runResearch,
      certifySemantics: true,
      reprocessReview: true,
      reprocessRelations: true,
      syncDecisions: true,
      applyControlledExpansion: true,
      syncGraph: true,
      evaluateReadiness: true,
    },
  }), "preview catalog intelligence campaign");
}

async function campaignReport(campaignId = null) {
  return must(await database.rpc("get_catalog_intelligence_campaign_report_v1", {
    p_campaign_id: campaignId,
  }), "catalog intelligence campaign report");
}

async function existingSuccessfulStep(campaignId, stepCode) {
  const rows = must(await database.from("catalog_intelligence_campaign_events")
    .select("status,result")
    .eq("campaign_id", campaignId)
    .eq("step_code", stepCode)
    .in("status", ["succeeded", "skipped"])
    .order("id", { ascending: false })
    .limit(1), `campaign step ${stepCode}`);
  return rows[0] ?? null;
}

async function recordStep(campaignId, stepCode, status, result, error = null) {
  return must(await database.rpc("record_catalog_intelligence_campaign_event_v1", {
    p_campaign_id: campaignId,
    p_step_code: stepCode,
    p_status: status,
    p_result: result ?? {},
    p_error_detail: error,
    p_idempotency_key: `${campaignKey}:${stepCode}:${status}`,
  }), `record campaign step ${stepCode}`);
}

async function executeStep(campaignId, stepCode, enabled, worker) {
  const existing = await existingSuccessfulStep(campaignId, stepCode);
  if (existing) return existing.result;
  if (!enabled) {
    const result = { reason: "disabled_by_preview" };
    await recordStep(campaignId, stepCode, "skipped", result);
    return result;
  }
  try {
    const result = await worker();
    await recordStep(campaignId, stepCode, "succeeded", result);
    return result;
  } catch (error) {
    const detail = {
      message: error instanceof Error ? error.message : String(error),
      step: stepCode,
    };
    await recordStep(campaignId, stepCode, "failed", {}, detail);
    await database.rpc("fail_catalog_intelligence_campaign_v1", {
      p_campaign_id: campaignId,
      p_error_detail: detail,
    });
    throw error;
  }
}

async function run() {
  const context = await sourceContext();
  const frozen = await preview();
  if (frozen.status === "succeeded") return campaignReport(frozen.campaignId);

  must(await database.rpc("start_catalog_intelligence_campaign_v1", {
    p_campaign_id: frozen.campaignId,
    p_preview_fingerprint: frozen.previewFingerprint,
  }), "start catalog intelligence campaign");

  const research = await executeStep(frozen.campaignId, "research_delta", runResearch, async () =>
    runChild("scripts/research-official-brand.mjs", [
      "--env", ".env.supabase.local",
      "--source-key", sourceKey,
      "--brand", context.brand.name,
      "--summary",
    ], "research delta"));

  const semantic = await executeStep(frozen.campaignId, "semantic_certification", true, async () =>
    runChild("scripts/gate-semantic-certification.mjs", [
      "--env", ".env.supabase.local",
    ], "semantic certification"));

  const review = await executeStep(frozen.campaignId, "review_reprocess", true, async () => {
    const reviewPreview = must(await database.rpc("preview_catalog_review_reprocess_v1", {
      p_idempotency_key: `${campaignKey}:review:preview`,
    }), "review reprocess preview");
    const applied = must(await database.rpc("apply_catalog_review_reprocess_v1", {
      p_preview_id: reviewPreview.previewId,
      p_preview_fingerprint: reviewPreview.previewFingerprint,
      p_idempotency_key: `${campaignKey}:review:apply`,
    }), "review reprocess apply");
    return { preview: reviewPreview, applied };
  });

  const relations = await executeStep(frozen.campaignId, "relation_reprocess", true, async () => {
    const relationPreview = must(await database.rpc("preview_catalog_relation_reprocess_v1", {
      p_idempotency_key: `${campaignKey}:relations:preview`,
      p_expected_candidate_count: 323,
    }), "relation reprocess preview");
    const applied = must(await database.rpc("apply_catalog_relation_reprocess_v1", {
      p_preview_id: relationPreview.previewId,
      p_preview_fingerprint: relationPreview.previewFingerprint,
      p_idempotency_key: `${campaignKey}:relations:apply`,
    }), "relation reprocess apply");
    return { preview: relationPreview, applied };
  });

  const decisions = await executeStep(frozen.campaignId, "decisions_sync", true, async () =>
    must(await database.rpc("sync_catalog_relation_decisions_v1"), "sync relation decisions"));

  const expansion = await executeStep(frozen.campaignId, "controlled_expansion", true, async () => {
    const results = [];
    for (const manifestPath of CONTROLLED_SYSTEM_MANIFESTS) {
      const { manifest } = await loadSystemManifest(ROOT, manifestPath);
      results.push(await runSystemExpansion(database, manifest,
        `controlled:${manifest.manifestKey}:v${manifest.manifestVersion}`));
    }
    return {
      results,
      report: must(await database.rpc("get_catalog_controlled_expansion_report_v1"),
        "controlled expansion report"),
    };
  });

  const driver = createGraphDriverFromEnv(env);
  const postgres = createPostgresPoolFromEnv(env);
  const projector = new GraphProjector({
    supabase: database,
    postgres,
    driver,
    database: env.NEO4J_DATABASE || undefined,
  });
  let graphSync;
  let graphVerification;
  try {
    graphSync = await executeStep(frozen.campaignId, "graph_sync", true,
      async () => projector.sync());
    graphVerification = await executeStep(frozen.campaignId, "graph_verify", true,
      async () => projector.verify());
  } finally {
    await driver.close();
    await postgres.end();
  }

  const readiness = await executeStep(frozen.campaignId, "readiness", true, async () =>
    must(await database.rpc("get_catalog_reference_commercial_readiness_v1", {
      p_source_id: context.source.id,
    }), "commercial readiness"));

  must(await database.rpc("complete_catalog_intelligence_campaign_v1", {
    p_campaign_id: frozen.campaignId,
    p_result: {
      delta: research?.report?.delta ?? { skipped: true },
      researchRun: research?.run ?? null,
      semanticCertification: {
        status: semantic.status,
        fingerprint: semantic.fingerprint,
        contractViolations: semantic.contractViolations,
      },
      review: review.applied ?? review,
      relations: relations.applied ?? relations,
      decisions,
      controlledExpansion: expansion.report ?? expansion,
      graphSync,
      graphVerification,
      readiness,
    },
  }), "complete catalog intelligence campaign");
  return campaignReport(frozen.campaignId);
}

const action = positionals[0] ?? "report";
let output;
if (action === "preview") output = await preview();
else if (action === "run") output = await run();
else if (action === "report") {
  const id = option("--campaign-id");
  output = await campaignReport(id);
} else {
  throw new Error("Acción inválida. Usa preview, run o report.");
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
