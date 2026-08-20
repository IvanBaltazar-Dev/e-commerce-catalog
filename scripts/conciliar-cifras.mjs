/**
 * Por qué cada cifra no coincide con la anterior.
 *
 * Después del incidente Cherimoya no se infiere ninguna explicación: cada
 * diferencia entre dos números del informe tiene que salir de contar, con un
 * código de razón por caso. Las tres que quedaron sin explicar:
 *
 *   152 adoptables  →  147 adoptados       ¿qué pasó con 5?
 *   197 MATCH_EXACT →  139 MANUFACTURER_SKU  ¿y los 58?
 *
 * Uso: node scripts/conciliar-cifras.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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

function digitoValido(codigo) {
  if (!/^\d+$/.test(codigo ?? "")) return false;
  if (![8, 12, 13, 14].includes(codigo.length)) return false;
  const d = codigo.split("").map(Number);
  const control = d.pop();
  let suma = 0;
  for (let i = d.length - 1, peso = 3; i >= 0; i -= 1, peso = peso === 3 ? 1 : 3) suma += d[i] * peso;
  return (10 - (suma % 10)) % 10 === control;
}

const casos = await todas("catalog_reconciliation_cases",
  "id, entity_type, variant_id, reference_variant_id, status, evidence");
const variantes = await todas("product_variants", "id, name, sku, sku_origen, barcode, barcode_origen, is_active");
const refVariantes = await todas("catalog_reference_variants", "id, sku, barcode, primary_source_id");
const fuentes = await todas("catalog_sources", "id, authority");
const identificadores = await todas("variant_identifiers", "variant_id, identifier_type, value, status");

const varPorId = new Map(variantes.map((v) => [v.id, v]));
const refPorId = new Map(refVariantes.map((r) => [r.id, r]));
const fuentePorId = new Map(fuentes.map((f) => [f.id, f]));
const manuf = new Set(identificadores.filter((i) => i.identifier_type === "MANUFACTURER_SKU" && i.status === "active").map((i) => i.variant_id));

const casosVar = casos.filter((c) => c.entity_type === "variant" && c.reference_variant_id);
const anota = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

// ── A · Los códigos de barras: de candidatos a escritos ────────────────────
const razonBarcode = new Map();
const detalleBarcode = [];

for (const c of casosVar) {
  const v = varPorId.get(c.variant_id);
  const rv = refPorId.get(c.reference_variant_id);
  if (!v || !rv) { anota(razonBarcode, "REFERENCIA_AUSENTE"); continue; }
  if (!rv.barcode) continue;   // no era candidato: la ficha no publica código

  let razon;
  if (["superseded", "rejected"].includes(c.status)) razon = "MATCH_SUPERSEDED";
  else if (c.evidence?.clase !== "MATCH_EXACT") razon = "INSUFFICIENT_PROVENANCE";
  else if (fuentePorId.get(rv.primary_source_id)?.authority !== "official") razon = "SOURCE_NOT_OFFICIAL";
  else if (!digitoValido(rv.barcode.replace(/[\s-]/g, ""))) razon = "INVALID_GTIN";
  else if (v.barcode === rv.barcode) razon = "ALREADY_PRESENT";
  else if (v.barcode) razon = "NOT_EMPTY_CONTRADICTION";
  else razon = "PENDIENTE_DE_ADOPTAR";

  anota(razonBarcode, razon);
  if (razon !== "ALREADY_PRESENT") detalleBarcode.push({ sku: v.sku, variante: v.name, barcode: rv.barcode, razon });
}

console.log(`${"═".repeat(74)}`);
console.log(`A · CÓDIGOS DE BARRAS · por qué 152 candidatos dieron 147 escritos`);
console.log(`${"═".repeat(74)}`);
for (const [r, n] of [...razonBarcode].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${r}`);
if (detalleBarcode.length) {
  console.log(`\n   los que no son ALREADY_PRESENT:`);
  for (const d of detalleBarcode.slice(0, 10)) console.log(`      ${d.razon.padEnd(24)} ${String(d.sku).padEnd(12)} ${d.variante.slice(0, 24)}`);
}
const escritos = variantes.filter((v) => v.barcode && v.barcode_origen === "FICHA_OFICIAL").length;
console.log(`\n   escritos con barcode_origen=FICHA_OFICIAL: ${escritos}`);

// ── B · MANUFACTURER_SKU: de matches a identificadores ─────────────────────
const razonManuf = new Map();
const detalleManuf = [];

for (const c of casosVar) {
  const v = varPorId.get(c.variant_id);
  const rv = refPorId.get(c.reference_variant_id);
  if (!v || !rv) continue;
  if (c.evidence?.clase !== "MATCH_EXACT") continue;

  let razon;
  if (["superseded", "rejected"].includes(c.status)) razon = "MATCH_SUPERSEDED";
  else if (!rv.sku) razon = "FICHA_SIN_SKU";
  else if (manuf.has(v.id)) razon = "REGISTRADO";
  else razon = "SIN_REGISTRAR";

  anota(razonManuf, razon);
  if (razon !== "REGISTRADO") detalleManuf.push({ sku: v.sku, skuOficial: rv.sku, variante: v.name, razon });
}

console.log(`\n${"═".repeat(74)}`);
console.log(`B · MANUFACTURER_SKU · por qué 197 matches exactos dieron 139 identificadores`);
console.log(`${"═".repeat(74)}`);
for (const [r, n] of [...razonManuf].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${r}`);
if (detalleManuf.length) {
  console.log(`\n   muestra de los no registrados:`);
  for (const d of detalleManuf.slice(0, 8)) console.log(`      ${d.razon.padEnd(20)} nuestro ${String(d.sku).padEnd(12)} oficial ${String(d.skuOficial ?? "—").padEnd(12)} ${d.variante.slice(0, 20)}`);
}

// La cifra de la base, para cerrar contra ella y no contra el recuerdo.
const activos = identificadores.filter((i) => i.identifier_type === "MANUFACTURER_SKU" && i.status === "active").length;
const rechazados = identificadores.filter((i) => i.identifier_type === "MANUFACTURER_SKU" && i.status === "rejected").length;
console.log(`\n   MANUFACTURER_SKU en base: ${activos} activos · ${rechazados} rechazados por la auditoría de contaminación`);
console.log(`   (los 139 originales venían de 0139, poblados desde sku_origen=OFICIAL_MARCA;`);
console.log(`    los añadidos después vienen de la reconciliación)`);

// ── C · El estado de los casos, que explica el resto ───────────────────────
const porEstado = new Map();
for (const c of casosVar) anota(porEstado, `${c.status} · ${c.evidence?.clase ?? "?"}`);
console.log(`\n${"═".repeat(74)}`);
console.log(`C · ESTADO DE LOS 228 CASOS DE VARIANTE`);
console.log(`${"═".repeat(74)}`);
for (const [e, n] of [...porEstado].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${e}`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "conciliacion-cifras.json"), JSON.stringify({
  barcode: Object.fromEntries(razonBarcode), detalleBarcode,
  manufacturerSku: Object.fromEntries(razonManuf), detalleManuf,
  estados: Object.fromEntries(porEstado)
}, null, 2), "utf8");
console.log(`\n→ outputs/conciliacion-cifras.json`);
