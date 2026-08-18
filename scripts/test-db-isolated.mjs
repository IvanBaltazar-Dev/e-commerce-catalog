/** Ejecuta pgTAP con productos DEMO temporales y los retira incluso al fallar. */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const requestedPaths = process.argv.slice(2);
function run(command, args, inherit = true) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
}

const load = run(process.execPath, ["scripts/manage-demo-test-fixtures.mjs", "--load"]);
if (load.status !== 0) process.exit(load.status ?? 1);

let testStatus = 1;
try {
  const tests = run(process.execPath, [
    "node_modules/supabase/dist/supabase.js",
    "test",
    "db",
    ...requestedPaths,
    "--local",
  ]);
  if (tests.error) console.error(tests.error);
  testStatus = tests.status ?? 1;
} finally {
  const cleanup = run(process.execPath, ["scripts/manage-demo-test-fixtures.mjs", "--cleanup"]);
  if (cleanup.status !== 0) testStatus = cleanup.status ?? 1;
}

process.exit(testStatus);
