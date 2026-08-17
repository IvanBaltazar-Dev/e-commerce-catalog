/** Stage 4A gate: universal contract, epistemic safety and graph parity. */
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
  scriptName: "gate:stage4a",
  allowedFlags: [],
});
if (!isLocal) throw new Error("El gate Stage 4A solo se ejecuta contra Supabase local.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const migration = readFileSync(
  path.join(ROOT, "supabase/migrations/0113_universal_system_class_model.sql"),
  "utf8",
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv(env);
const graphPostgres = createPostgresPoolFromEnv(env);

try {
  const report = (await client.query(
    "select public.get_catalog_stage4a_report_v1() as report",
  )).rows[0].report;

  assert(report.stage4Authorized === false, "Stage 4A no puede cambiar stage4Authorized=false.");
  assert(report.scope.systems >= 1, "Falta un sistema real.");
  assert(report.scope.stages >= 5, "El fixture necesita multiples etapas.");
  assert(report.scope.classes >= 5, "El fixture necesita multiples clases.");
  assert(report.scope.requirements >= 5, "Faltan requisitos reales.");
  assert(report.scope.sequences >= 5, "Faltan secuencias reales.");
  assert(report.coverage.referenceProducts >= 2, "El contrato de referencias no esta validado.");
  assert(report.coverage.roleClassMappings >= 10, "El puente rol-clase esta incompleto.");
  assert(report.epistemic.literalObservations === 4, "El fixture no inicia en observaciones literales.");
  assert(report.epistemic.normalizedSourceClaims === 4, "Faltan claims normalizados.");
  assert(report.epistemic.derivedInferences === 4, "Faltan inferencias explicables.");
  assert(report.epistemic.canonicalFactsCreated === 0, "Hubo canonizacion automatica indebida.");
  assert(report.epistemic.pendingRequirements >= 3, "Las brechas reales no quedaron visibles.");
  assert(report.historicalRelations.checkpointDeferred === 323, "El checkpoint historico debe conservar 323 relaciones reales.");
  assert(report.historicalRelations.untouched === 323, "Se tocaron relaciones historicas fuera de alcance.");
  assert(report.historicalRelations.analyzedThisCut === 0, "Este corte no debe reprocesar las relaciones historicas.");
  assert(report.historicalRelations.batchMutationPerformed === false, "Se detecto una mutacion masiva prohibida.");
  assert(report.guards.membershipImpliesCompatibility === false, "La pertenencia no puede implicar compatibilidad.");
  assert(report.guards.sameSystemImpliesCompatibility === false, "Compartir sistema no puede implicar compatibilidad.");
  assert(report.guards.sameBrandImpliesCompatibility === false, "Compartir marca no puede implicar compatibilidad.");
  assert(report.guards.humanReviewPerProductGenerated === 0, "Se genero revision humana artificial por producto.");

  const strictRelationLeaks = Number((await client.query(`
    select count(*)::integer as count
    from public.catalog_relation_rules rule
    join public.catalog_relation_kinds kind on kind.code=rule.relation_kind_code
    where kind.requires_explicit_pair_evidence
      and rule.epistemic_state not in ('NEEDS_EVIDENCE','LEGACY_CANONICAL_PRE_0111')
      and not exists (
        select 1 from public.catalog_semantic_claims claim
        where claim.id=rule.semantic_claim_id and claim.dimension_code='compatibility'
          and claim.claim_status='ASSERTED'
      )
  `)).rows[0].count);
  assert(strictRelationLeaks === 0, "Hay relaciones estrictas sin claim explicito de compatibilidad.");

  const stage4ReviewLeaks = Number((await client.query(`
    select count(*)::integer as count from public.catalog_review_work_items
    where context::text ilike '%stage4a%' and subject_type in ('product','variant')
  `)).rows[0].count);
  assert(stage4ReviewLeaks === 0, "Stage 4A abrio trabajo humano individual por producto.");

  const adoptedFixtureReferences = Number((await client.query(`
    select count(*)::integer as count from public.catalog_reference_products
    where reference_key like 'stage4a-%' and knowledge_status='adopted'
  `)).rows[0].count);
  assert(adoptedFixtureReferences === 0, "Una referencia del fixture fue adoptada al catalogo comercial.");

  for (const forbidden of [
    /insert\s+into\s+public\.products\b/i,
    /update\s+public\.products\b/i,
    /insert\s+into\s+public\.variant_prices\b/i,
    /update\s+public\.variant_prices\b/i,
    /insert\s+into\s+public\.inventory_/i,
    /update\s+public\.inventory_/i,
  ]) {
    assert(!forbidden.test(migration), `La migracion toca una superficie comercial prohibida: ${forbidden}`);
  }

  const projector = new GraphProjector({
    supabase,
    postgres: graphPostgres,
    driver,
    database: env.NEO4J_DATABASE || undefined,
  });
  const graph = await projector.verify();
  assert(graph.ok, `Graph verify detecto divergencias: ${JSON.stringify(graph.verification)}`);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    projectorVersion: GRAPH_PROJECTOR_VERSION,
    report,
    graph,
    checks: {
      strictRelationLeaks,
      stage4ReviewLeaks,
      adoptedFixtureReferences,
      commercialMigrationWrites: 0,
    },
  }, null, 2)}\n`);
} finally {
  client.release();
  await pool.end();
  await driver.close();
  await graphPostgres.end();
}
