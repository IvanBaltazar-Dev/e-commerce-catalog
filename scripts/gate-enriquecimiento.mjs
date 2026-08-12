import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const { env } = loadSupabaseScriptEnv({
  rootDir: process.cwd(),
  scriptName: "gate-enriquecimiento",
});

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: checks, error } = await service
  .from("catalog_knowledge_gate_v2")
  .select("check_code,severity,passed,violations,description")
  .order("severity")
  .order("check_code");

if (error) throw new Error(`catalog_knowledge_gate_v2: ${error.message}`);

const projectionViews = [
  "graph_product_nodes_v1",
  "graph_variant_nodes_v1",
  "graph_class_nodes_v1",
  "graph_system_nodes_v1",
  "graph_stage_nodes_v1",
  "graph_class_membership_edges_v1",
  "graph_system_role_edges_v1",
  "graph_relation_edges_v1",
];
const projectionCounts = {};
for (const view of projectionViews) {
  const result = await service.from(view).select("*", { count: "exact", head: true });
  if (result.error) throw new Error(`${view}: ${result.error.message}`);
  projectionCounts[view] = result.count ?? 0;
}

console.table(checks.map((check) => ({
  check: check.check_code,
  severity: check.severity,
  passed: check.passed,
  violations: Number(check.violations),
})));
console.log(JSON.stringify({ projectionCounts }, null, 2));

const blockers = checks.filter((check) => check.severity === "blocking" && !check.passed);
if (blockers.length) {
  console.error("La compuerta de conocimiento encontró bloqueos:");
  for (const blocker of blockers) {
    console.error(`- ${blocker.check_code}: ${blocker.violations} · ${blocker.description}`);
  }
  process.exitCode = 1;
} else {
  console.log("gate:enriquecimiento OK · ninguna afirmación aprobada carece de evidencia.");
}
