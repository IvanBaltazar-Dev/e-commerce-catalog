/** Stage 4C gate: real grouped cases and a frontend-ready read model. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

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
  scriptName: "gate:stage4c",
  allowedFlags: [],
});
if (!isLocal) throw new Error("El gate Stage 4C solo se ejecuta contra Supabase local.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const migration = readFileSync(
  path.join(ROOT, "supabase/migrations/0115_human_decision_read_model.sql"),
  "utf8",
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv(env);
const graphPostgres = createPostgresPoolFromEnv(env);

try {
  const before = (await client.query(`
    select
      (select count(*)::integer from public.catalog_relation_candidates
        where status='needs_evidence'
          and evidence->>'generated_from'='catalog_process_rule_v1') deferred,
      (select count(*)::integer from public.catalog_semantic_claims
        where epistemic_class='CANONICAL_FACT') canonical,
      (select count(*)::integer from public.catalog_review_work_items) review_work
  `)).rows[0];

  await client.query(
    "select public.preview_catalog_relation_reprocess_v1($1,$2)",
    ["stage4b-certified-preview-v1", 323],
  );
  const report = (await client.query(
    "select public.get_catalog_stage4c_report_v1() report",
  )).rows[0].report;
  const decisions = (await client.query(`
    select * from public.catalog_decision_read_model_v1
    order by family_code, affected_count desc, decision_id
  `)).rows;
  const after = (await client.query(`
    select
      (select count(*)::integer from public.catalog_relation_candidates
        where status='needs_evidence'
          and evidence->>'generated_from'='catalog_process_rule_v1') deferred,
      (select count(*)::integer from public.catalog_semantic_claims
        where epistemic_class='CANONICAL_FACT') canonical,
      (select count(*)::integer from public.catalog_review_work_items) review_work
  `)).rows[0];

  assert(report.stage4Authorized === false, "4C no puede cambiar stage4Authorized=false.");
  assert(report.metrics.familyCount === 3, "Los datos no produjeron tres familias reales.");
  assert(report.metrics.decisionCount === 18, "La agrupacion compartida esperada debe producir 18 decisiones.");
  assert(report.metrics.affectedDetections === 263, "El contrato no cubre las detecciones materiales.");
  assert(report.metrics.automaticEvidenceDebtExcluded === 60,
    "La incertidumbre de evidencia se convirtio indebidamente en trabajo humano.");
  assert(report.metrics.individualReviewAvoided === 0.9316,
    "La reduccion de revision individual no coincide con el conjunto real.");
  assert(Number(report.families.CLASS_RULE_PROMOTION) === 9, "Faltan decisiones de reglas de clase.");
  assert(Number(report.families.ENDPOINT_SCOPE_RECLASSIFICATION) === 5,
    "Faltan decisiones de alcance compartido.");
  assert(Number(report.families.FALSE_PAIR_RETIREMENT) === 4,
    "Faltan decisiones para retirar falsos pares.");
  assert(decisions.some((decision) => decision.family_code === "FALSE_PAIR_RETIREMENT"
    && Number(decision.affected_count) === 88), "La causa compartida de lampara no se agrupo en una decision.");

  const requiredText = [
    "decision_id", "title", "business_summary", "what_was_found",
    "why_human_is_needed", "system_recommendation", "fingerprint",
  ];
  for (const decision of decisions) {
    for (const field of requiredText) {
      assert(String(decision[field] ?? "").trim().length > 0,
        `La decision ${decision.decision_id} no tiene ${field}.`);
    }
    assert(Number(decision.affected_count) > 0, "Una decision no tiene afectados.");
    assert(Array.isArray(decision.affected_entity_types), "affected_entity_types no es una lista.");
    assert(Array.isArray(decision.available_actions) && decision.available_actions.length >= 3,
      "Las acciones disponibles no vienen resueltas por backend.");
    assert(decision.evidence_summary && typeof decision.evidence_summary === "object",
      "Falta resumen de evidencia.");
    assert(decision.impact_preview?.canonicalFactsCreated === 0
      && decision.impact_preview?.commercialEffects === 0,
    "Un preview de impacto cruza la frontera epistemica o comercial.");
  }

  assert(report.guards.reactInterpretsRuleCode === false, "React quedo obligado a interpretar reglas.");
  assert(report.guards.humanWorkPerCandidateCreated === 0, "4C creo trabajo por candidata.");
  assert(report.guards.canonicalFactsCreated === 0, "4C creo hechos canonicos.");
  assert(report.guards.decisionApplied === false, "4C aplico una decision humana.");
  assert(before.deferred === after.deferred, "4C cambio el estado de las candidatas.");
  assert(before.canonical === after.canonical, "4C cambio hechos canonicos.");
  assert(before.review_work === after.review_work, "4C creo trabajos fuera del read model.");

  for (const forbidden of [
    /insert\s+into\s+public\.products\b/i,
    /update\s+public\.products\b/i,
    /insert\s+into\s+public\.variant_prices\b/i,
    /update\s+public\.variant_prices\b/i,
    /insert\s+into\s+public\.inventory_/i,
    /update\s+public\.inventory_/i,
  ]) {
    assert(!forbidden.test(migration), `La migracion toca una superficie comercial: ${forbidden}`);
  }

  const contractFingerprint = createHash("sha256")
    .update(JSON.stringify(decisions.map((decision) => [decision.decision_id, decision.fingerprint])))
    .digest("hex");
  const graph = await new GraphProjector({
    supabase,
    postgres: graphPostgres,
    driver,
    database: env.NEO4J_DATABASE || undefined,
  }).verify();
  assert(graph.ok, `Graph verify detecto divergencias: ${JSON.stringify(graph.verification)}`);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    projectorVersion: GRAPH_PROJECTOR_VERSION,
    contractFingerprint,
    report,
    representativeDecisions: [
      decisions.find((decision) => decision.family_code === "CLASS_RULE_PROMOTION"),
      decisions.find((decision) => decision.family_code === "ENDPOINT_SCOPE_RECLASSIFICATION"),
      decisions.find((decision) => decision.family_code === "FALSE_PAIR_RETIREMENT"),
    ],
    checks: {
      sourceCandidatesMutated: after.deferred - before.deferred,
      canonicalFactsCreated: after.canonical - before.canonical,
      reviewWorkCreated: after.review_work - before.review_work,
      commercialMigrationWrites: 0,
    },
    graph,
  }, null, 2)}\n`);
} finally {
  client.release();
  await pool.end();
  await driver.close();
  await graphPostgres.end();
}
