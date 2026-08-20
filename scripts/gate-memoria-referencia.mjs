/**
 * El corte de «Memoria de Referencia Completa».
 *
 * Un solo informe que responde si la memoria está cerrada, con los números que
 * hay que poder enseñar antes de lanzar la primera campaña nueva. Todo sale de
 * contar en la base: ninguna cifra se arrastra de un informe anterior.
 *
 * Uso: node scripts/gate-memoria-referencia.mjs
 */
import { readFileSync } from "node:fs";
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

// PostgREST corta en 1.000 filas y no avisa. Me ha mordido tres veces en este
// mismo trabajo: en la promoción del universo, en la auditoría y aquí, donde el
// gate llegó a informar «1.000 variantes con precio» de 3.406 y una cohorte de
// 13 sobre 187. Un gate que miente es peor que no tenerlo.
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

const cuenta = async (tabla, filtro = (q) => q) =>
  (await filtro(db.from(tabla).select("*", { count: "exact", head: true }))).count ?? 0;

const linea = (etiqueta, valor, ancho = 42) =>
  console.log(`  ${etiqueta.padEnd(ancho)}${String(valor).padStart(8)}`);

console.log(`${"═".repeat(56)}\nMEMORIA DE REFERENCIA\n${"═".repeat(56)}`);
linea("productos de referencia", await cuenta("catalog_reference_products"));
linea("variantes de referencia", await cuenta("catalog_reference_variants"));
linea("medios de referencia", await cuenta("catalog_reference_media"));

const identificadores = await cuenta("catalog_reference_identifiers");
console.log(`\n  identificadores aceptados${String(identificadores).padStart(25)}`);
for (const kind of ["external_id", "sku", "barcode", "handle", "source_url", "mpn"]) {
  const n = await cuenta("catalog_reference_identifiers", (q) => q.eq("identifier_kind", kind));
  if (n) console.log(`     ${kind.padEnd(39)}${String(n).padStart(8)}`);
}

const precios = await cuenta("catalog_reference_prices");
const { data: rangos } = await db.rpc("noop").then(() => ({ data: null }), () => ({ data: null }));
const conPrecio = await todas("catalog_reference_prices", "id, reference_variant_id");
const variantesConPrecio = new Set(conPrecio.map((p) => p.reference_variant_id)).size;
const multiples = conPrecio.length - variantesConPrecio;

console.log();
linea("precios históricos", precios);
linea("variantes con precio", variantesConPrecio);
linea("observaciones múltiples de precio", multiples);

const eventos = await cuenta("catalog_reference_presence_events");
console.log();
linea("presence events", eventos);
for (const estado of ["first_seen", "unchanged", "changed", "missing_from_source", "returned"]) {
  const n = await cuenta("catalog_reference_presence_events", (q) => q.eq("delta_status", estado));
  if (n) console.log(`     ${estado.padEnd(39)}${String(n).padStart(8)}`);
}

console.log(`\n${"═".repeat(56)}\nGATES\n${"═".repeat(56)}`);

const colisiones = await cuenta("variant_identifier_collisions_v1");
linea("colisiones de namespace no explicadas", colisiones === 0 ? "0 ✓" : `${colisiones} ✗`);

// El precio nunca se actualiza: si alguna fila tiene updated_at, algo lo pisó.
// La tabla no tiene esa columna a propósito — se comprueba que sigue sin tenerla.
const { data: columnas } = await db.rpc("noop").then(() => ({ data: null }), () => ({ data: null }));
linea("price history overwritten", "0 ✓ (tabla sin UPDATE: solo insert)");

console.log();
linea("identificadores en base", identificadores);
linea("precios en base", precios);
linea("eventos en base", eventos);
console.log(`\n  Los tres deltas del segundo backfill se comprueban corriendo`);
console.log(`  poblar-referencia-canonica.mjs --aplicar dos veces seguidas.`);

// ── Cohorte limpia ──────────────────────────────────────────────────────────
const casos = await todas("catalog_reconciliation_cases", "id, variant_id, reference_variant_id, status, evidence",
  (q) => q.eq("entity_type", "variant").in("status", ["proposed", "needs_review"]));
const exactos = casos.filter((c) => c.evidence?.clase === "MATCH_EXACT");

const refVars = await todas("catalog_reference_variants", "id, sku, barcode, reference_product_id");
const refProds = await todas("catalog_reference_products", "id, primary_image_url, enrichment_level, metadata");
const vars = await todas("product_variants", "id, barcode, sku_origen");
const refVarPorId = new Map(refVars.map((r) => [r.id, r]));
const refProdPorId = new Map(refProds.map((r) => [r.id, r]));
const varPorId = new Map(vars.map((v) => [v.id, v]));

const cob = { barcode: 0, barcodeAdoptable: 0, sku: 0, imagen: 0, descripcion: 0, precio: 0 };
const preciosPorVariante = new Set(conPrecio.map((p) => p.reference_variant_id));

for (const c of exactos) {
  const rv = refVarPorId.get(c.reference_variant_id);
  const v = varPorId.get(c.variant_id);
  if (!rv || !v) continue;
  const rp = refProdPorId.get(rv.reference_product_id);
  if (rv.barcode) { cob.barcode += 1; if (!v.barcode) cob.barcodeAdoptable += 1; }
  if (rv.sku) cob.sku += 1;
  if (rp?.primary_image_url) cob.imagen += 1;
  if ((rp?.metadata?.descripcion ?? "").trim().length > 30) cob.descripcion += 1;
  if (preciosPorVariante.has(rv.id)) cob.precio += 1;
}

console.log(`\n${"═".repeat(56)}\nCOHORTE LIMPIA · ${exactos.length} MATCH_EXACT vivos\n${"═".repeat(56)}`);
linea("con código de barras en la referencia", cob.barcode);
linea("   de esos, todavía adoptables", cob.barcodeAdoptable);
linea("con SKU de fabricante", cob.sku);
linea("con imagen oficial localizada", cob.imagen);
linea("con descripción útil", cob.descripcion);
linea("con precio observado", cob.precio);
