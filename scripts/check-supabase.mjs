// Verifica la conexión a Supabase: llaves, tablas (schema aplicado), seed y buckets.
// Uso local: node scripts/check-supabase.mjs --env .env.supabase.local
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "check-supabase" });

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = env.SUPABASE_SERVICE_ROLE_KEY;

const pref = (key) => (key ? `${key.slice(0, 12)}…` : "(vacío)");
console.log("URL:", url);
console.log("anon prefix:", pref(anon));
console.log("service prefix:", pref(svc), svc === anon ? "  ⚠️ IGUAL A ANON" : "  ✓ distinto de anon");
console.log("DATABASE_URL presente:", Boolean(env.DATABASE_URL));

const admin = createClient(url, svc, { auth: { persistSession: false } });

async function count(table) {
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true });
  return error ? `ERROR (${error.code}: ${error.message})` : `${count} filas`;
}

console.log("\n== Tablas (schema) ==");
for (const t of ["brands", "categories", "products", "product_images", "store_settings", "admin_profiles"]) {
  console.log(`  ${t}: ${await count(t)}`);
}

console.log("\n== Storage buckets ==");
const { data: buckets, error: bErr } = await admin.storage.listBuckets();
if (bErr) console.log("  ERROR:", bErr.message);
else buckets.forEach((b) => console.log(`  ${b.name} (public: ${b.public})`));
