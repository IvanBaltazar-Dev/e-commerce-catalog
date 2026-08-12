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
const action = process.argv.slice(2).find((argument) => !argument.startsWith("--"));

if (!action || !["status", "sync", "verify", "rebuild"].includes(action)) {
  throw new Error("Uso: graph-projector.mjs <status|sync|verify|rebuild> [--env archivo]");
}

const { env } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: `graph:${action}`,
  allowedFlags: ["--database"],
});

for (const key of ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "NEO4J_DATABASE", "POSTGRES_URL"]) {
  if (env[key]) process.env[key] = env[key];
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const driver = createGraphDriverFromEnv();
const postgres = createPostgresPoolFromEnv();
const projector = new GraphProjector({
  supabase,
  postgres,
  driver,
  database: process.env.NEO4J_DATABASE || undefined,
});

try {
  const result = await projector[action]();
  console.log(JSON.stringify(result, null, 2));
  if (action === "verify" && !result.ok) process.exitCode = 1;
} finally {
  await driver.close();
  await postgres.end();
}
