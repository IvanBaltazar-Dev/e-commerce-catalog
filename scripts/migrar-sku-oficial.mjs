/**
 * Sustituye el correlativo interno por el SKU del fabricante donde exista.
 *
 * Hoy la columna `sku` mezcla dos cosas que no son lo mismo:
 *
 *   310028, 311428   SKU real de Masglo
 *   CHE017, MAS014   correlativo NUESTRO (prefijo de marca + 3 dígitos)
 *
 * Mientras eso siga así, nada externo se puede contrastar: los correlativos no
 * significan nada fuera de esta base, y encima chocan (CHE017 es «Base Coat»
 * nuestro y «Polvo Compacto Facial» en el catálogo de Cherimoya).
 *
  * El correlativo no se tira: pasa a `sku_interno` (columna abierta por 0137),
  * porque las hojas de la dueña y los albaranes viejos lo usan. Lo que cambia
  * es cuál de los dos manda.
 *
 * Solo migra lo que ya está confirmado en outputs/plan-imagenes-oficiales.json,
 * que aplica SKU_OFICIAL > NOMBRE_EN_LINEA > NOMBRE_DE_PRODUCTO con corroboración
 * de nombre y guarda de color. Este script no inventa emparejamientos nuevos.
 *
 * Uso:
 *   node scripts/migrar-sku-oficial.mjs             (ensayo)
 *   node scripts/migrar-sku-oficial.mjs --aplicar
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "research", "catalog-master", "data");
const APLICAR = process.argv.includes("--aplicar");

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function parseCsv(texto) {
  const filas = [];
  let campo = "", fila = [], comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i += 1; } else comillas = false; }
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas;
  return resto.filter((f) => f.length === cab.length).map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i]])));
}

const oficialesProd = parseCsv(readFileSync(path.join(DATA, "external_official_products.csv"), "utf8"));
const oficialesVar = parseCsv(readFileSync(path.join(DATA, "external_official_variants.csv"), "utf8"));
const { plan } = JSON.parse(readFileSync(path.join(ROOT, "outputs", "plan-imagenes-oficiales.json"), "utf8"));

const prodPorUrl = new Map(oficialesProd.map((p) => [p.source_product_url, p]));
const skuPorProductoExterno = new Map();
for (const v of oficialesVar) {
  const sku = (v.sku ?? "").trim();
  if (!sku) continue;
  if (!skuPorProductoExterno.has(v.external_product_id)) skuPorProductoExterno.set(v.external_product_id, sku);
}

// Correlativo nuestro: prefijo de marca + dígitos, o el código generado a
// partir del código de producto. Un SKU de fabricante no tiene esa forma.
const esCorrelativoInterno = (sku) =>
  /^[A-Z]{2,5}\d{2,4}$/.test(sku ?? "") || /^[A-Z]{3}-[A-Z]{3}-[0-9A-F]{6}/.test(sku ?? "");

const migraciones = [];
const yaOficial = [];
const sinSkuOficial = [];

for (const item of plan) {
  const oficial = prodPorUrl.get(item.url);
  const skuOficial = oficial ? skuPorProductoExterno.get(oficial.external_product_id) : null;
  if (!skuOficial) { sinSkuOficial.push(item); continue; }
  if (item.sku === skuOficial) { yaOficial.push(item); continue; }
  if (!esCorrelativoInterno(item.sku)) {
    // Nuestro SKU no es un correlativo y tampoco es el oficial: son dos códigos
    // de fabricante distintos. Eso no se pisa sin mirar — se enumera.
    sinSkuOficial.push({ ...item, motivo: `nuestro «${item.sku}» no parece correlativo y difiere del oficial «${skuOficial}»` });
    continue;
  }
  migraciones.push({ ...item, skuOficial });
}

console.log(`Emparejamientos confirmados en el plan: ${plan.length}`);
console.log(`  ya llevan el SKU oficial:        ${yaOficial.length}`);
console.log(`  a migrar (correlativo → oficial): ${migraciones.length}`);
console.log(`  sin SKU oficial utilizable:      ${sinSkuOficial.length}`);

const porNivel = new Map();
for (const m of migraciones) porNivel.set(m.nivel, (porNivel.get(m.nivel) ?? 0) + 1);
for (const [n, c] of porNivel) console.log(`     ${String(c).padStart(4)}  ${n}`);

console.log(`\nMuestra:`);
for (const m of migraciones.slice(0, 12)) {
  console.log(`  ${m.marca.padEnd(11)} ${String(m.sku).padEnd(24)} → ${String(m.skuOficial).padEnd(14)} ${m.variante.slice(0, 20).padEnd(22)} ${m.tituloOficial.slice(0, 42)}`);
}

writeFileSync(path.join(ROOT, "outputs", "plan-migracion-sku.json"), JSON.stringify({ migraciones, yaOficial: yaOficial.length, sinSkuOficial }, null, 2), "utf8");

if (!APLICAR) {
  console.log(`\nEnsayo. → outputs/plan-migracion-sku.json`);
  process.exit(0);
}

// ── Aplicación ──────────────────────────────────────────────────────────────
// Un SKU repetido dentro de la misma marca sería peor que el correlativo: dos
// variantes distintas contestando al mismo código. Se comprueba antes.
const porNuevoSku = new Map();
for (const m of migraciones) {
  const k = `${m.marca}::${m.skuOficial}`;
  if (!porNuevoSku.has(k)) porNuevoSku.set(k, []);
  porNuevoSku.get(k).push(m);
}
const colisiones = [...porNuevoSku].filter(([, v]) => v.length > 1);
if (colisiones.length) {
  console.log(`\n⚠ ${colisiones.length} SKU oficiales reclamados por más de una variante. Esos NO se migran:`);
  for (const [k, v] of colisiones.slice(0, 8)) console.log(`   ${k} ← ${v.map((x) => x.variante).join(", ")}`);
}
const seguras = migraciones.filter((m) => porNuevoSku.get(`${m.marca}::${m.skuOficial}`).length === 1);

let hechas = 0, fallos = 0;
for (const m of seguras) {
  const { data: actual, error: errLeer } = await db
    .from("product_variants").select("id, sku, sku_interno").eq("id", m.variantId).single();
  if (errLeer) { fallos += 1; console.error(`   ✗ ${m.sku}: ${errLeer.message}`); continue; }

  const { error } = await db.from("product_variants").update({
    sku: m.skuOficial,
    sku_interno: actual.sku_interno ?? actual.sku,
    sku_origen: "OFICIAL_MARCA"
  }).eq("id", m.variantId);

  if (error) { fallos += 1; console.error(`   ✗ ${m.sku} → ${m.skuOficial}: ${error.message}`); continue; }
  hechas += 1;
}

console.log(`\nMigradas: ${hechas}`);
console.log(`No migradas por colisión: ${migraciones.length - seguras.length}`);
console.log(`Fallos: ${fallos}`);
