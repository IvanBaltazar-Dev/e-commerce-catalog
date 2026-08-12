import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, envPath } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "test-catalog-review-rerun",
});
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

async function selectAll(table, columns, size = 1000) {
  const rows = [];

  for (let offset = 0; ; offset += size) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .range(offset, offset + size - 1);

    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < size) return rows;
  }
}

function canonicalHash(rows) {
  const ordered = [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(ordered))
    .digest("hex");
}

async function snapshot() {
  const [workItems, events, dependencies] = await Promise.all([
    selectAll(
      "catalog_review_work_items",
      "id,work_key,problem_version,status,row_version,resolution_code,resolution_payload,resolved_by,resolved_at,material_fingerprint,supersedes_work_item_id",
    ),
    selectAll(
      "catalog_review_events",
      "id,work_item_id,work_key,event_type,action_code,actor_id,idempotency_key,request_fingerprint,prior_version,new_version,payload,evidence",
    ),
    selectAll(
      "catalog_review_dependencies",
      "dependent_work_item_id,prerequisite_work_item_id,dependency_type,group_key,condition,origin",
    ),
  ]);

  return {
    workItems: workItems.length,
    terminalWorkItems: workItems.filter((item) =>
      ["resolved", "superseded", "cancelled"].includes(item.status),
    ).length,
    events: events.length,
    dependencies: dependencies.length,
    workHash: canonicalHash(workItems),
    eventHash: canonicalHash(events),
    dependencyHash: canonicalHash(dependencies),
  };
}

function runStage() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "catalog-enrichment-stage.mjs"), "--env", envPath],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    throw new Error(
      ["Falló catalog-enrichment-stage.", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

runStage();
const first = await snapshot();
runStage();
const second = await snapshot();

assert.deepEqual(
  second,
  first,
  "Una recarga idéntica alteró trabajos, decisiones, eventos o dependencias.",
);

console.log(
  JSON.stringify(
    {
      result: "PASS",
      assertion: "dos recargas idénticas conservan estado, historia y proyección",
      snapshot: second,
    },
    null,
    2,
  ),
);
