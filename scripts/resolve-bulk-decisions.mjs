// Aplica el expediente de decisiones (decisiones-67.json) a través del
// mecanismo del importador: resolveBulkReviewRow + commit por lote. Nada toca
// el catálogo por fuera del staging.
//
//   node --conditions=react-server --experimental-transform-types \
//     scripts/resolve-bulk-decisions.mjs --env .env.supabase.local

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "resolve-bulk-decisions" });
if (!isLocal) throw new Error("Solo local.");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});
const { resolveBulkReviewRow, commitBulkBatch } = await import("../src/lib/admin/catalog-bulk-import/service.ts");

const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const login = await developer.auth.signInWithPassword({ email: "bulk-dev@local.invalid", password: "Bulk-Dev-2026!" });
if (login.error) throw login.error;

const dossier = JSON.parse(await fs.readFile(path.join(root, "docs", "evidencia-certificacion-1c", "decisiones-67.json"), "utf8"));
const results = [];
const touchedBatches = new Set();
for (const item of dossier.decisiones) {
  if (!item.decision) throw new Error(`Fila ${item.fila} sin decisión en el expediente.`);
  const result = await resolveBulkReviewRow(developer, item.fila, item.decision, "certificacion-1c");
  results.push({ fila: item.fila, grupo: item.grupo, ...result });
  if (result.batchId && result.status === "approved") touchedBatches.add(result.batchId);
}

console.log("== RESOLUCIONES ==");
const porResultado = {};
for (const r of results) porResultado[`${r.grupo}:${r.applied}`] = (porResultado[`${r.grupo}:${r.applied}`] ?? 0) + 1;
console.log(JSON.stringify(porResultado, null, 2));
const noop = results.filter((r) => r.applied === "noop");
if (noop.length) console.log("NOOP:", JSON.stringify(noop));

console.log(`\n== COMMIT de ${touchedBatches.size} lotes con filas aprobadas ==`);
for (const batchId of touchedBatches) {
  try {
    const report = await commitBulkBatch(developer, login.data.user.id, batchId, "IMPORTAR LOTE");
    console.log(batchId, "→", JSON.stringify({ filas: report.counts.filasProcesadas, productos: report.counts.productosNuevos, reutilizados: report.counts.productosReutilizados, variantes: report.counts.variantesCreadas, rechazadas: report.counts.filasRechazadas }));
    if (report.rechazadas.length) console.log("  rechazadas:", JSON.stringify(report.rechazadas.slice(0, 6)));
  } catch (error) {
    console.log(batchId, "→ ERROR:", error.message);
  }
}

// Registro de aplicación junto al expediente.
await fs.writeFile(
  path.join(root, "docs", "evidencia-certificacion-1c", "decisiones-67-aplicadas.json"),
  JSON.stringify({ aplicado: new Date().toISOString(), resultados: results }, null, 2),
  "utf8"
);
console.log("\nRegistro: docs/evidencia-certificacion-1c/decisiones-67-aplicadas.json");
