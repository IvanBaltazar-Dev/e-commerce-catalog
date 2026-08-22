/**
 * Pone en circulación las variaciones reales de una campaña WooCommerce.
 *
 * Cherimoya quedó en una situación que no podía sostenerse: sus 1.395 «variantes»
 * falsas están retiradas —eran una por producto, artefacto de aplanar cada ficha—
 * y las 231 reales están capturadas en catalog_source_records pero no en la capa
 * de referencia. Resultado: cero variantes en circulación para esa fuente.
 *
 * Capturado correctamente y sin circular es tan malo como no haberlo capturado, y
 * peor de detectar: el dato existe, el cierre dice COMPLETE y nadie lo ve.
 *
 * Lo que este script NO hace, a propósito:
 *   · no revive ninguna retirada. Las 1.395 siguen con superseded_at puesto y las
 *     nuevas se crean aparte, con su propia identidad.
 *   · no promueve nada a catálogo comercial. Sigue siendo capa de referencia.
 *
 *   node --experimental-transform-types scripts/materializar-variantes-woo.mjs <source-key> [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const CLAVE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "cherimoya-pe-official";
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: fuente } = await db.from("catalog_sources").select("id, source_key").eq("source_key", CLAVE).single();
const { data: snap } = await db.from("catalog_source_snapshots")
  .select("id, created_at").eq("source_id", fuente.id)
  .eq("metadata->>via", "woocommerce_store_api").order("created_at", { ascending: false }).limit(1).single();

const variaciones = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, external_id, external_parent_id, title, source_url, primary_image_url, payload")
    .eq("snapshot_id", snap.id).eq("entity_type", "variant"),
  orden: ["id"], clave: (r) => r.external_id, nombre: "variaciones woo",
});
const productos = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, external_id, title, payload")
    .eq("snapshot_id", snap.id).eq("entity_type", "product"),
  orden: ["id"], clave: (r) => r.external_id, nombre: "productos woo",
});
const productoPorExterno = new Map(productos.map((p) => [p.external_id, p]));

const referencias = await leerTodo({
  consulta: () => db.from("catalog_reference_products")
    .select("id, primary_external_id, name").eq("primary_source_id", fuente.id),
  orden: ["id"], clave: (r) => r.primary_external_id, nombre: "referencias de producto",
});
const referenciaPorExterno = new Map(referencias.map((r) => [r.primary_external_id, r]));

console.log(`${CLAVE}`);
console.log(`  variaciones capturadas: ${variaciones.length}`);
console.log(`  productos de referencia: ${referencias.length}`);

const filas = [];
const huerfanas = [];
for (const v of variaciones) {
  const idPadre = String(v.external_parent_id ?? "").split(":")[1];
  const ref = referenciaPorExterno.get(idPadre);
  if (!ref) { huerfanas.push(v.external_id); continue; }
  const prod = productoPorExterno.get(v.external_parent_id);
  // Los atributos vienen con dos formas según de dónde salió la variación: del
  // listado del producto padre («name»/«value») o de su ficha completa, donde el
  // valor está en terms[0]. Se acepta cualquiera de las dos sin preferir ninguna.
  let ejes = (v.payload?.attributes ?? []).map((a) => ({
    name: a.name ?? null,
    value: a.value ?? a.terms?.[0]?.name ?? null,
  })).filter((a) => a.name && a.value);

  // Cuando la variación viene de ?type=variation, attributes llega vacío y el eje
  // está en el campo «variation» como cadena: «Colores: Plomo 06», «TONOS: NUDE
  // COFFEE». No es una convención que asumamos nosotros: es la propia API
  // rindiendo nombre y valor, así que partirla es NORMALIZACIÓN y no inferencia.
  // Se conserva la cadena cruda al lado para poder rehacerlo si cambia el formato.
  if (!ejes.length && v.payload?.variation) {
    ejes = String(v.payload.variation).split(",").map((trozo) => {
      const i = trozo.indexOf(":");
      if (i < 0) return null;
      return { name: trozo.slice(0, i).trim(), value: trozo.slice(i + 1).trim() };
    }).filter((a) => a && a.name && a.value);
  }
  // El nombre de la variante lo forma su eje, que es lo que la distingue de sus
  // hermanas. «Base Cushion · Tonos 001» y no «Base Cushion» repetido seis veces.
  const etiquetaEjes = ejes.map((a) => `${a.name}: ${a.value}`).join(" · ");
  const nombre = etiquetaEjes ? `${prod?.title ?? ref.name} · ${etiquetaEjes}` : (prod?.title ?? ref.name);
  const externo = String(v.payload?.id ?? v.external_id);
  filas.push({
    reference_product_id: ref.id,
    reference_key: `${CLAVE}:variant:${externo}`,
    primary_source_id: fuente.id,
    primary_source_record_id: v.id,
    primary_external_id: externo,
    name: nombre,
    normalized_name: normalizar(nombre),
    // El eje va en shade_name solo si la fuente lo llama tono; si no, se queda en
    // metadata. Meter «Medidas: 46cm» en shade_name sería inventar.
    shade_name: ejes.find((a) => /^tono/i.test(a.name ?? ""))?.value ?? null,
    // La ficha completa de la variación SÍ trae SKU, precio e imagen propios; el
    // listado del producto padre no. Se recogen cuando están, y cuando no, se
    // queda a null en vez de heredar los del padre: heredarlos haría creer que la
    // variación tiene código propio cuando no lo tiene.
    sku: v.payload?.sku || null,
    primary_image_url: v.primary_image_url ?? null,
    source_url: v.source_url,
    identity_fingerprint: sha({ producto: ref.id, externo }),
    content_fingerprint: sha({ externo, ejes }),
    enrichment_level: "REFERENCE_LIGHT",
    metadata: {
      origen: "woocommerce_store_api",
      ejes,
      ejes_crudo: v.payload?.variation ?? null,
      ejes_regla: (v.payload?.attributes ?? []).length ? "attributes estructurados" : "EJE_DESDE_VARIATION v1",
      materializado_por: "materializar-variantes-woo",
      // Deja constancia de que estas sustituyen a las retiradas, sin revivirlas.
      sustituye_a: "las 1.395 variantes aplanadas retiradas en 0152",
    },
  });
}

console.log(`  variantes a materializar: ${filas.length}`);
if (huerfanas.length) console.log(`  huérfanas (sin producto de referencia): ${huerfanas.length}`);
const porEje = {};
for (const f of filas) for (const a of f.metadata.ejes) porEje[a.name] = (porEje[a.name] ?? 0) + 1;
console.log(`  ejes:`);
for (const [k, n] of Object.entries(porEje).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);
console.log(`  productos padre distintos: ${new Set(filas.map((f) => f.reference_product_id)).size}`);

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

// Un run propio: esto es una materialización, no una captura, y conviene poder
// distinguirla después.
const ahora = new Date().toISOString();
const { data: run, error: eR } = await db.from("catalog_research_runs").insert({
  run_key: `materializar-variantes-woo:${CLAVE}:${snap.id}`,
  run_kind: "targeted", actor_kind: "system",
  actor_label: "materializar-variantes-woo",
  input_fingerprint: sha({ snapshot: snap.id, variaciones: variaciones.length }),
  scope: { fuente: CLAVE, snapshot: snap.id },
}).select("id").single();
if (eR && !/duplicate|unique/i.test(eR.message)) throw new Error(`run: ${eR.message}`);
const runId = run?.id ?? (await db.from("catalog_research_runs").select("id")
  .eq("run_key", `materializar-variantes-woo:${CLAVE}:${snap.id}`).single()).data.id;

const conRun = filas.map((f) => ({
  ...f, first_seen_run_id: runId, last_seen_run_id: runId,
  first_seen_at: ahora, last_seen_at: ahora,
}));

let escritas = 0;
for (let i = 0; i < conRun.length; i += 100) {
  const { error } = await db.from("catalog_reference_variants")
    .upsert(conRun.slice(i, i + 100), { onConflict: "reference_key" });
  if (error) throw new Error(`catalog_reference_variants: ${error.message}`);
  escritas += Math.min(100, conRun.length - i);
}
console.log(`\n  variantes materializadas: ${escritas}`);

// ── Verificación: circulan las nuevas y siguen retiradas las viejas ─────────
const { count: vigentes } = await db.from("catalog_reference_variants_vigentes_v1")
  .select("*", { count: "exact", head: true }).eq("primary_source_id", fuente.id);
const { count: retiradas } = await db.from("catalog_reference_variants")
  .select("*", { count: "exact", head: true })
  .eq("primary_source_id", fuente.id).not("superseded_at", "is", null);
console.log(`  vigentes ahora: ${vigentes} · retiradas conservadas: ${retiradas}`);
if (vigentes !== filas.length) {
  console.error(`\nSe esperaban ${filas.length} vigentes y hay ${vigentes}.`);
  process.exit(1);
}
