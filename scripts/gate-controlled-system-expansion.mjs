/** Gate posterior a 4F: expansión controlada del modelo universal, sin catálogo comercial. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

import {
  CONTROLLED_SYSTEM_MANIFESTS,
  getControlledExpansionReport,
  loadSystemManifest,
  runSystemExpansion,
} from "./lib/catalog-system-expansion.mjs";
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
  scriptName: "gate:controlled-expansion",
});
if (!isLocal) throw new Error("El gate de expansión controlada solo se ejecuta contra Supabase local.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectKeys(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      collectKeys(child, found);
    }
  }
  return found;
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv(env);
const graphPostgres = createPostgresPoolFromEnv(env);
const migration = readFileSync(
  path.join(ROOT, "supabase/migrations/0117_controlled_system_expansion.sql"),
  "utf8",
);

async function snapshot() {
  return (await client.query(`
    select
      (select count(*)::integer from public.products) products,
      (select count(*)::integer from public.product_variants) variants,
      (select md5(coalesce(string_agg(concat_ws('|',product.id,product.unit_price,
        product.wholesale_price),'#' order by product.id),'')) from public.products product) prices,
      (select md5(coalesce(string_agg(to_jsonb(price)::text,'#' order by price.id),''))
        from public.variant_prices price) variant_prices,
      (select md5(coalesce(string_agg(to_jsonb(stock)::text,'#'
        order by stock.variant_id,stock.branch_id),'')) from public.inventory_stock stock) stock,
      (select md5(coalesce(string_agg(concat_ws('|',product.id,product.is_active,
        product.editorial_status,product.published_at),'#' order by product.id),''))
        from public.products product) publication,
      (select count(*)::integer from public.catalog_class_members) class_members,
      (select count(*)::integer from public.product_system_roles) product_roles,
      (select count(*)::integer from public.catalog_review_work_items) review_work,
      (select count(*)::integer from public.catalog_semantic_claims
        where epistemic_class='CANONICAL_FACT') canonical
  `)).rows[0];
}

try {
  const before = await snapshot();
  const runs = [];

  for (const manifestPath of CONTROLLED_SYSTEM_MANIFESTS) {
    const { manifest } = await loadSystemManifest(ROOT, manifestPath);
    const forbiddenKeys = new Set([
      "products", "variants", "brands", "prices", "stock", "publication",
      "productId", "variantId", "referenceProductId", "referenceVariantId",
    ]);
    const leakingKey = collectKeys(manifest).find((key) => forbiddenKeys.has(key));
    assert(!leakingKey, `${manifest.manifestKey} contiene la clave prohibida ${leakingKey}.`);
    runs.push(await runSystemExpansion(
      database,
      manifest,
      `controlled:${manifest.manifestKey}:v${manifest.manifestVersion}`,
    ));
  }

  const report = await getControlledExpansionReport(database);
  const after = await snapshot();
  const leaks = (await client.query(`
    select
      (select count(*)::integer from public.catalog_system_stage_roles expectation
        where expectation.metadata ? 'expansionManifestKey'
          and expectation.decision_status<>'needs_evidence') expectation_status,
      (select count(*)::integer from public.catalog_system_stage_role_classes bridge
        where bridge.metadata ? 'expansionManifestKey'
          and (bridge.epistemic_state<>'NEEDS_EVIDENCE'
            or bridge.decision_status<>'needs_evidence' or bridge.semantic_claim_id is not null)) bridges,
      (select count(*)::integer from public.catalog_class_requirements requirement
        where requirement.metadata ? 'expansionManifestKey'
          and (requirement.epistemic_state<>'NEEDS_EVIDENCE'
            or requirement.decision_status<>'needs_evidence' or requirement.semantic_claim_id is not null)) requirements,
      (select count(*)::integer from public.catalog_stage_transitions transition
        where transition.metadata ? 'expansionManifestKey'
          and (transition.epistemic_state<>'NEEDS_EVIDENCE'
            or transition.decision_status<>'needs_evidence' or transition.semantic_claim_id is not null)) transitions,
      (select count(*)::integer from public.catalog_relation_rules rule
        where rule.metadata ? 'expansionManifestKey'
          and (rule.epistemic_state<>'NEEDS_EVIDENCE'
            or rule.decision_status<>'needs_evidence' or rule.semantic_claim_id is not null)) relation_rules,
      (select count(*)::integer from public.catalog_class_members member
        join public.catalog_classes class on class.id=member.class_id
        where class.metadata ? 'expansionManifestKey') memberships,
      (select count(*)::integer from public.product_system_roles assignment
        join public.catalog_systems system on system.id=assignment.system_id
        where system.metadata ? 'expansionManifestKey') product_roles
  `)).rows[0];

  assert(report.contractVersion === "stage4g-v1", "Versión inesperada del contrato de expansión.");
  assert(report.stage4Authorized === false, "La expansión no puede autorizar Etapa 4.");
  assert(report.passes === true, `El reporte no certificó la expansión: ${JSON.stringify(report)}`);
  assert(report.metrics.manifests === 2 && report.metrics.systems === 2
    && report.metrics.domains === 2, "La expansión debe cubrir dos sistemas en dos dominios.");
  assert(report.metrics.coveredDecisions === 8 && report.metrics.coveredFamilies === 3,
    "Los manifiestos no quedaron ligados a los casos reales esperados.");
  assert(report.metrics.relationProposals === 5, "Se esperaban cinco relaciones de clase propuestas.");
  assert(Object.values(leaks).every((value) => Number(value) === 0),
    `Una aserción cruzó la frontera epistemológica: ${JSON.stringify(leaks)}`);
  assert(JSON.stringify(before) === JSON.stringify(after),
    `La expansión alteró estado fuera de su vocabulario: ${JSON.stringify({ before, after })}`);

  for (const forbidden of [
    /insert\s+into\s+public\.products\b/i,
    /update\s+public\.products\b/i,
    /insert\s+into\s+public\.product_variants\b/i,
    /update\s+public\.product_variants\b/i,
    /insert\s+into\s+public\.variant_prices\b/i,
    /update\s+public\.variant_prices\b/i,
    /insert\s+into\s+public\.inventory_/i,
    /update\s+public\.inventory_/i,
    /insert\s+into\s+public\.catalog_class_members\b/i,
    /insert\s+into\s+public\.product_system_roles\b/i,
  ]) {
    assert(!forbidden.test(migration), `La migración toca una superficie prohibida: ${forbidden}`);
  }

  const projector = new GraphProjector({
    supabase: database,
    postgres: graphPostgres,
    driver,
    database: env.NEO4J_DATABASE || undefined,
  });
  const graphSync = await projector.sync();
  const graph = await projector.verify();
  assert(graph.ok, `Graph verify detectó divergencias: ${JSON.stringify(graph.verification)}`);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    stage: "controlled-system-expansion",
    projectorVersion: GRAPH_PROJECTOR_VERSION,
    runs,
    report,
    checks: {
      epistemicLeaks: leaks,
      commercialOrProductChanges: 0,
      commercialMigrationWrites: 0,
    },
    graphSync,
    graph,
  }, null, 2)}\n`);
} finally {
  client.release();
  await pool.end();
  await driver.close();
  await graphPostgres.end();
}
