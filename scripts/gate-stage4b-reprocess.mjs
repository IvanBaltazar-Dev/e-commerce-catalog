/** Stage 4B gate: complete preview, semantic compression and safety guards. */
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
  scriptName: "gate:stage4b",
  allowedFlags: [],
});
if (!isLocal) throw new Error("El gate Stage 4B solo se ejecuta contra Supabase local.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const migration = readFileSync(
  path.join(ROOT, "supabase/migrations/0114_universal_relation_reprocessing.sql"),
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

  const preview = (await client.query(
    "select public.preview_catalog_relation_reprocess_v1($1,$2) result",
    ["stage4b-certified-preview-v1", 323],
  )).rows[0].result;
  const replay = (await client.query(
    "select public.preview_catalog_relation_reprocess_v1($1,$2) result",
    ["stage4b-certified-preview-v1", 323],
  )).rows[0].result;
  const report = (await client.query(
    "select public.get_catalog_relation_reprocess_report_v1() report",
  )).rows[0].report;
  const after = (await client.query(`
    select
      (select count(*)::integer from public.catalog_relation_candidates
        where status='needs_evidence'
          and evidence->>'generated_from'='catalog_process_rule_v1') deferred,
      (select count(*)::integer from public.catalog_semantic_claims
        where epistemic_class='CANONICAL_FACT') canonical,
      (select count(*)::integer from public.catalog_review_work_items) review_work
  `)).rows[0];

  const metrics = preview.metrics;
  const classifications = metrics.classificationCounts;
  const classified = Object.values(classifications).reduce((sum, value) => sum + Number(value), 0);

  assert(preview.status === "previewed", "El primer pase certificado debe permanecer en preview.");
  assert(preview.engineVersion === "stage4b-v1", "Version inesperada del motor 4B.");
  assert(preview.snapshotFingerprint.length === 64, "La fotografia no tiene SHA-256.");
  assert(preview.previewFingerprint.length === 64, "El preview no tiene SHA-256.");
  assert(replay.idempotentReplay === true, "El preview no es idempotente.");
  assert(replay.previewFingerprint === preview.previewFingerprint, "La repeticion cambio la huella.");
  assert(metrics.historicalCandidates === 323, "El preview no cubre las 323 candidatas.");
  assert(classified === 323, "La clasificacion no es exhaustiva.");
  assert(Number(classifications.CLASS_RELATION ?? 0) > 0, "No se detectaron relaciones entre clases.");
  assert(Number(classifications.CLASS_MEMBERSHIP ?? 0) > 0, "No se detectaron membresias comprimibles.");
  assert(Number(classifications.NEEDS_EVIDENCE ?? 0) > 0, "La compatibilidad estricta perdio sus brechas.");
  assert(Number(classifications.REJECTED ?? 0) > 0, "No se detectaron falsos pares reales.");
  assert(metrics.classVsDirect.classExpressiblePairs > 0, "No existe compresion semantica medible.");
  assert(metrics.classVsDirect.distinctClassRelations < metrics.classVsDirect.classRelationCandidatePairs,
    "Las reglas entre clases no reducen pares historicos.");
  assert(metrics.epistemic.canonicalFactsCreated === 0, "4B canonizo inferencias automaticamente.");
  assert(report.stage4Authorized === false, "4B no puede cambiar stage4Authorized=false.");
  assert(report.guards.applyPromotesKnowledge === false, "Apply no debe promover conocimiento.");
  assert(report.guards.humanWorkPerCandidateCreated === 0, "Se creo trabajo humano por candidata.");
  assert(before.deferred === 323 && after.deferred === 323, "El preview mutó la cohorte diferida.");
  assert(before.canonical === after.canonical, "El preview creo hechos canonicos.");
  assert(before.review_work === after.review_work, "El preview creo trabajo de Mesa.");

  const strictLeaks = Number((await client.query(`
    select count(*)::integer count
    from public.catalog_relation_reprocess_plan_v1 plan
    join public.catalog_relation_kinds kind on kind.code=plan.relation_kind_code
    where kind.requires_explicit_pair_evidence
      and plan.classification in ('CLASS_RELATION','GENUINE_PAIR_RELATION')
      and plan.context_snapshot->'relation'->>'hasExplicitPairEvidence' <> 'true'
  `)).rows[0].count);
  assert(strictLeaks === 0, "Una relacion estricta avanzo sin evidencia explicita del par.");

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
    preview,
    report,
    checks: {
      strictLeaks,
      sourceCandidatesMutated: after.deferred - before.deferred,
      canonicalFactsCreated: after.canonical - before.canonical,
      humanWorkCreated: after.review_work - before.review_work,
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
