// Verifica la conexión a Supabase: llaves, tablas (schema aplicado), seed y buckets.
// Uso: node scripts/check-supabase.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = env.SUPABASE_SERVICE_ROLE_KEY;

const pref = (k) => (k ? k.split("_").slice(0, 2).join("_") : "(vacío)");
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
