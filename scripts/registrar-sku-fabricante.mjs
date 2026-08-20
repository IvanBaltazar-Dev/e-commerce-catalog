/**
 * Registra el SKU del fabricante SIN tocar product_variants.sku.
 *
 * La auditoría del 2026-08-20 decidió esto y conviene dejar dicho por qué, para
 * que nadie lo «arregle» dentro de seis meses:
 *
 *   · de 1.570 variantes, 1.351 llevan un código generado por nosotros. Solo
 *     189 son numéricos de fabricante. Convertir en regla global el criterio
 *     que se aplicó a Masglo sería repetir el error de origen al revés.
 *
 *   · la directriz V2 define `sku` como el identificador único de la unidad
 *     comprable. No dice «del fabricante». Y la historia del proyecto contiene
 *     las dos decisiones: una plantilla de Masglo declaraba el SKU como interno
 *     y explícitamente distinto del fabricante; otra posterior lo sustituyó por
 *     el oficial.
 *
 *   · `sku` está denormalizado a propósito en siete tablas transaccionales
 *     —sale_lines, inventory_movements, goods_receipt_lines, return_lines,
 *     reservation_lines, inventory_transfer_lines, low_stock_alerts— porque
 *     cada una congela el código del día de la operación. Hoy están vacías;
 *     cambiarlo entonces sería gratis, pero la primera venta lo vuelve caro.
 *
 * Así que el código de fabricante entra como MANUFACTURER_SKU en el contrato de
 * identificadores, junto al nuestro y sin desplazarlo. Los dos son ciertos: uno
 * es lo que teclea la dueña, el otro lo que imprime el fabricante.
 *
 * Uso:
 *   node scripts/registrar-sku-fabricante.mjs             (previsualización)
 *   node scripts/registrar-sku-fabricante.mjs --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const casos = await todas(
  "catalog_reconciliation_cases",
  "id, variant_id, reference_variant_id, evidence, research_run_id",
  (q) => q.eq("entity_type", "variant").in("status", ["proposed", "needs_review"])
);
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, sku, primary_source_id, primary_source_record_id");
const refProductos = await todas("catalog_reference_products", "id, brand_id");
const variantes = await todas("product_variants", "id, product_id, name, sku, sku_origen, is_active");
const marcas = await todas("brands", "id, name");
const fuentes = await todas("catalog_sources", "id, source_key, authority");
const yaRegistrados = await todas("variant_identifiers", "variant_id, identifier_type, value", (q) => q.eq("identifier_type", "MANUFACTURER_SKU"));

const refPorId = new Map(refVariantes.map((r) => [r.id, r]));
const refProdPorId = new Map(refProductos.map((r) => [r.id, r]));
const varPorId = new Map(variantes.map((v) => [v.id, v]));
const marcaPorId = new Map(marcas.map((b) => [b.id, b.name]));
const fuentePorId = new Map(fuentes.map((f) => [f.id, f]));
const yaTiene = new Set(yaRegistrados.map((r) => `${r.variant_id}::${r.value}`));

const registrar = [];
const rechazos = new Map();
const anota = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const c of casos) {
  const rv = refPorId.get(c.reference_variant_id);
  const v = varPorId.get(c.variant_id);
  if (!rv || !v || !v.is_active) { anota(rechazos, "variante o referencia ausente"); continue; }
  if (c.evidence?.clase !== "MATCH_EXACT") { anota(rechazos, "la identidad no es exacta"); continue; }
  const fuente = fuentePorId.get(rv.primary_source_id);
  if (fuente?.authority !== "official") { anota(rechazos, "la fuente no es oficial"); continue; }
  const sku = (rv.sku ?? "").trim();
  if (!sku) { anota(rechazos, "la ficha no publica SKU"); continue; }
  if (yaTiene.has(`${v.id}::${sku}`)) { anota(rechazos, "ya registrado"); continue; }

  const rp = refProdPorId.get(rv.reference_product_id);
  registrar.push({
    variantId: v.id, variante: v.name, sku,
    emisor: marcaPorId.get(rp?.brand_id) ?? "desconocido",
    refVariantId: rv.id, sourceId: rv.primary_source_id, sourceRecordId: rv.primary_source_record_id,
    casoId: c.id,
    // Vale la pena dejar constancia de si nuestro sku ya coincidía: es la
    // diferencia entre «lo confirmamos» y «lo aprendimos».
    coincideConNuestroSku: (v.sku ?? "").trim().toUpperCase() === sku.toUpperCase()
  });
}

const huella = sha(JSON.stringify(registrar.map((r) => `${r.variantId}:${r.sku}`).sort()));
const nuevos = registrar.filter((r) => !r.coincideConNuestroSku);

console.log(`Casos examinados: ${casos.length}`);
console.log(`  a registrar como MANUFACTURER_SKU: ${registrar.length}`);
console.log(`    de ellos, nuestro sku ya coincidía: ${registrar.length - nuevos.length}`);
console.log(`    conocimiento nuevo:                ${nuevos.length}`);
console.log(`\nDescartes:`);
for (const [m, n] of [...rechazos].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${m}`);
console.log(`\nMuestra de lo nuevo:`);
for (const r of nuevos.slice(0, 8)) {
  const v = varPorId.get(r.variantId);
  console.log(`   nuestro ${String(v.sku).padEnd(24)} → fabricante ${r.sku.padEnd(12)} ${r.variante.slice(0, 24)}`);
}
console.log(`\nproduct_variants.sku NO se toca. Los dos códigos conviven.`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "registro-sku-fabricante.json"), JSON.stringify({ huella, registrar }, null, 2), "utf8");

if (!APLICAR) {
  console.log(`\nPrevisualización. Añade --aplicar.`);
  process.exit(0);
}
if (!registrar.length) { console.log(`\nNada nuevo. Run limpio.`); process.exit(0); }

let hechos = 0, fallos = 0;
for (const r of registrar) {
  const { error } = await db.from("variant_identifiers").upsert({
    variant_id: r.variantId,
    identifier_type: "MANUFACTURER_SKU",
    value: r.sku,
    issuer: r.emisor,
    reference_variant_id: r.refVariantId,
    source_id: r.sourceId,
    source_record_id: r.sourceRecordId,
    reconciliation_case_id: r.casoId,
    is_primary: true,
    status: "active",
    metadata: { huellaRegistro: huella, coincidiaConNuestroSku: r.coincideConNuestroSku }
  }, { onConflict: "variant_id,identifier_type,value" });
  if (error) { fallos += 1; console.error(`   ✗ ${r.sku}: ${error.message}`); continue; }
  hechos += 1;
}

console.log(`\nRegistrados: ${hechos} · fallos: ${fallos}`);
