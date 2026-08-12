import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import {
  createGraphDriverFromEnv,
  createPostgresPoolFromEnv,
  GraphProjector,
} from "../src/lib/catalog-intelligence/graph-projector.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test:graph-projector" });
for (const key of ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE", "POSTGRES_URL"]) {
  if (env[key]) process.env[key] = env[key];
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv();
const postgres = createPostgresPoolFromEnv();
const projector = new GraphProjector({ supabase, postgres, driver, database: env.NEO4J_DATABASE || undefined });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const first = await projector.rebuild();
  const second = await projector.rebuild();
  const verification = await projector.verify();
  assert(first.ok && second.ok && verification.ok, "rebuild/verify debe quedar en cero diferencias");
  assert(first.nodes === second.nodes && first.edges === second.edges, "la segunda ejecución no puede duplicar filas");
  assert(first.graphFingerprint === second.graphFingerprint, "la proyección idempotente debe conservar fingerprint");

  const session = driver.session(env.NEO4J_DATABASE ? { database: env.NEO4J_DATABASE } : undefined);
  let divergent;
  let repaired;
  let afterSync;
  try {
    const result = await session.run(
      `MATCH (reference:ReferenceProduct {key:'reference_product:11000000-0000-4000-8000-000000000030'})
       OPTIONAL MATCH (identity:IdentityMatch)-[:CATALOG_RELATION {kind:'ABOUT_REFERENCE'}]->(reference)
       OPTIONAL MATCH (identity)-[match:CATALOG_RELATION {kind:'CONFIRMED_MATCH'}]->(:Product)
       WITH reference, count(match) AS matches
       OPTIONAL MATCH (observation:Observation)-[:CATALOG_RELATION {kind:'OBSERVES'}]->(reference)
       WITH reference, matches, count(observation) AS directObservations
       OPTIONAL MATCH (candidate:RelationCandidate)
       WITH reference, matches, directObservations, count(candidate) AS candidates
       RETURN labels(reference) AS labels, matches, directObservations, candidates,
              EXISTS { MATCH (:ReferenceVariant) },
              EXISTS { MATCH (:EvidenceSet) },
              EXISTS { MATCH (:PresenceEvent) },
              EXISTS { MATCH (:ExternalPrice) },
              EXISTS { MATCH (:ReferenceMedia) },
              EXISTS { MATCH (:Product {key:reference.key}) }`,
    );
    const record = result.records[0];
    const labels = record.get("labels");
    assert(labels.includes("ReferenceProduct") && labels.includes("CatalogEntity"), "ReferenceProduct necesita label explícito");
    assert(record.get("matches").toNumber() === 1, "IdentityMatch aprobado debe proyectarse por separado");
    assert(record.get("candidates").toNumber() >= 1, "las candidatas deben tener label propio");
    assert(record.get(4) === true, "debe existir ReferenceVariant");
    assert(record.get(5) === true, "debe existir EvidenceSet");
    assert(record.get(6) === true, "deben existir deltas PresenceEvent");
    assert(record.get(7) === true, "debe existir ExternalPrice");
    assert(record.get(8) === true, "debe existir ReferenceMedia");
    assert(record.get(9) === false, "una referencia nunca puede adquirir label Product");

    await session.run(
      "MATCH (node:CatalogEntity {key:'reference_media:11000000-0000-4000-8000-000000000071'}) DETACH DELETE node",
    );
    divergent = await projector.verify();
    assert(!divergent.ok, "verify debe detectar divergencia deliberada");
    assert(
      divergent.differences.missingNodes.includes("reference_media:11000000-0000-4000-8000-000000000071"),
      "verify debe identificar el nodo faltante",
    );

    repaired = await projector.sync();
    afterSync = await projector.verify();
    assert(repaired.ok && afterSync.ok, "sync incremental debe reparar la divergencia sin duplicados");
    assert(repaired.graphFingerprint === second.graphFingerprint, "sync reparado debe recuperar el mismo fingerprint");
  } finally {
    await session.close();
  }

  console.log(JSON.stringify({ first, second, verification, divergent, repaired, afterSync }, null, 2));
} finally {
  await driver.close();
  await postgres.end();
}
