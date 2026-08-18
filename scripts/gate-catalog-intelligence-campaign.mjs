/** Gate de Etapa 5: la campaña unificada orquesta conocimiento sin decidir ni comerciar. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import {
  createGraphDriverFromEnv,
  createPostgresPoolFromEnv,
  GraphProjector,
  GRAPH_PROJECTOR_VERSION,
} from "../src/lib/catalog-intelligence/graph-projector.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate:stage5",
});
if (!isLocal) throw new Error("El gate de Etapa 5 solo se ejecuta contra el entorno local.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function must(response, operation) {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
}

const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv(env);
const postgres = createPostgresPoolFromEnv(env);
const migration = readFileSync(
  path.join(ROOT, "supabase/migrations/0118_catalog_intelligence_campaign.sql"),
  "utf8",
);

try {
  const report = must(await database.rpc("get_catalog_intelligence_campaign_report_v1", {
    p_campaign_id: null,
  }), "catalog intelligence campaign report");
  const steps = new Map((report.steps ?? []).map((step) => [step.step, step.status]));
  const required = [
    "research_delta", "semantic_certification", "review_reprocess",
    "relation_reprocess", "decisions_sync", "controlled_expansion",
    "graph_sync", "graph_verify", "readiness",
  ];

  assert(report.contractVersion === "catalog-intelligence-campaign-v1",
    "Versión inesperada del contrato de campaña.");
  assert(report.status === "succeeded" && report.passes === true,
    `La última campaña no está certificada: ${JSON.stringify(report)}`);
  assert(required.every((step) => ["succeeded", "skipped"].includes(steps.get(step))),
    "La campaña no cerró sus nueve pasos obligatorios.");
  assert(report.steps.length === 9 && steps.size === 9,
    "La campaña debe conservar exactamente un cierre efectivo por paso.");
  assert(report.graphVerification?.ok === true
      && report.graphVerification?.differenceCount === 0,
  "La campaña terminó con divergencias en la proyección.");
  assert(report.guards?.commercialFingerprintUnchanged === true
      && report.guards?.humanDecisionsApplied === 0
      && report.guards?.productsPublished === 0
      && report.guards?.pricesAssigned === 0
      && report.guards?.stockAssigned === 0
      && report.guards?.canonicalFactsAutomaticallyCreated === 0,
  "La campaña cruzó una frontera comercial, humana o epistemológica.");
  assert(report.ownerSummary?.newProductsReady >= 0
      && report.ownerSummary?.newProductsBlocked >= 0
      && Array.isArray(report.readyForCommercialDecision)
      && Array.isArray(report.blockedReadiness),
  "El resultado no puede explicarse a la propietaria.");

  for (const forbidden of [
    /insert\s+into\s+public\.products\b/i,
    /update\s+public\.products\b/i,
    /insert\s+into\s+public\.product_variants\b/i,
    /update\s+public\.product_variants\b/i,
    /insert\s+into\s+public\.variant_prices\b/i,
    /update\s+public\.variant_prices\b/i,
    /insert\s+into\s+public\.inventory_/i,
    /update\s+public\.inventory_/i,
    /apply_catalog_relation_decision_v1/i,
    /insert\s+into\s+public\.catalog_canonical_promotions\b/i,
  ]) {
    assert(!forbidden.test(migration), `La migración contiene una escritura prohibida: ${forbidden}`);
  }

  const graph = await new GraphProjector({
    supabase: database,
    postgres,
    driver,
    database: env.NEO4J_DATABASE || undefined,
  }).verify();
  assert(graph.ok && graph.differenceCount === 0,
    `La verificación independiente del grafo falló: ${JSON.stringify(graph)}`);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    stage: "catalog-intelligence-campaign",
    projectorVersion: GRAPH_PROJECTOR_VERSION,
    campaignId: report.campaignId,
    campaignKey: report.campaignKey,
    ownerSummary: report.ownerSummary,
    delta: report.delta,
    checks: {
      requiredSteps: required.length,
      commercialChanges: 0,
      humanDecisionsApplied: 0,
      canonicalFactsAutomaticallyCreated: 0,
      migrationWritesOutsideScope: 0,
    },
    graph,
  }, null, 2)}\n`);
} finally {
  await driver.close();
  await postgres.end();
}
