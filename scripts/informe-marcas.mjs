/**
 * El estado de cada fuente, marca por marca y dato por dato.
 *
 * Un total agregado no sirve para decidir nada: «3.400 productos de referencia»
 * no dice si falta identidad, si faltan fotos o si lo que falta es que alguna de
 * esas fuentes ni siquiera cerró. Aquí cada columna responde a una pregunta
 * distinta y las que van en cero son justamente las accionables.
 *
 *   node --experimental-transform-types scripts/informe-marcas.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = [
  "masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"
];

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(desde, desde + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const { data: fuentes } = await db.from("catalog_sources")
  .select("id, source_key, metadata").in("source_key", FUENTES);
const porId = Object.fromEntries(fuentes.map((f) => [f.id, f.source_key]));
const idPorClave = Object.fromEntries(fuentes.map((f) => [f.source_key, f.id]));

const registros = await todas("catalog_source_records",
  "source_id, entity_type, sku, barcode, primary_image_url",
  (q) => q.in("source_id", Object.keys(porId)));
const refProd = await todas("catalog_reference_products", "id, primary_source_id, created_at",
  (q) => q.in("primary_source_id", Object.keys(porId)));
const refVar = await todas("catalog_reference_variants", "id, reference_product_id");
const refIdent = await todas("catalog_reference_identifiers", "reference_product_id, identifier_kind, normalized_value, namespace_key");
const precios = await todas("catalog_reference_prices", "source_id, currency, amount",
  (q) => q.in("source_id", Object.keys(porId)), "price_key");
const medios = await todas("catalog_reference_media", "source_id, validation_status",
  (q) => q.in("source_id", Object.keys(porId)), "media_key");
const claims = await todas("catalog_semantic_claims", "source_id, claim_status",
  (q) => q.in("source_id", Object.keys(porId)), "claim_key");
const evidencia = await todas("code_evidence", "source_id, normalized_code, evidence_type",
  (q) => q.in("source_id", Object.keys(porId)), "evidence_key");
const { data: auditorias } = await db.from("capture_closure_audit_v1").select("*").in("source_key", FUENTES);

// Los códigos internos de Bellaroshé, para poder decir con cuántos coincide cada
// marca. Coincidencia EXACTA de código normalizado: nada de parecidos, que es
// como se coló el choque CHE011.
const variantesBella = await todas("product_variants", "id, sku");
const skusBella = new Set(variantesBella.map((v) => (v.sku ?? "").toUpperCase().replace(/[\s\-_.#]/g, "")).filter(Boolean));

const refPorProducto = new Map();
for (const v of refVar) refPorProducto.set(v.reference_product_id, (refPorProducto.get(v.reference_product_id) ?? 0) + 1);
const identPorProducto = new Map();
for (const i of refIdent) {
  if (!identPorProducto.has(i.reference_product_id)) identPorProducto.set(i.reference_product_id, []);
  identPorProducto.get(i.reference_product_id).push(i);
}

const norm = (s) => String(s ?? "").toUpperCase().replace(/[\s\-_.#]/g, "");

console.log(`\n${"═".repeat(78)}`);
console.log(`INFORME POR MARCA`);
console.log(`${"═".repeat(78)}\n`);

const resumen = [];
for (const clave of FUENTES) {
  const id = idPorClave[clave];
  const f = fuentes.find((x) => x.id === id);
  const regs = registros.filter((r) => r.source_id === id);
  const prods = regs.filter((r) => r.entity_type === "product");
  const vars = regs.filter((r) => r.entity_type === "variant");
  const imgs = regs.filter((r) => r.entity_type === "image");
  const aud = auditorias.find((a) => a.source_key === clave) ?? {};
  const refs = refProd.filter((r) => r.primary_source_id === id);
  const pre = precios.filter((p) => p.source_id === id);
  const med = medios.filter((m) => m.source_id === id);
  const cl = claims.filter((c) => c.source_id === id);
  const ev = evidencia.filter((e) => e.source_id === id);

  const codigos = new Set([...vars, ...prods].map((r) => norm(r.sku)).filter(Boolean));
  const barcodes = new Set([...vars, ...prods].map((r) => r.barcode).filter(Boolean));
  const coincidencias = [...codigos].filter((c) => skusBella.has(c));
  const variantesRef = refs.reduce((a, r) => a + (refPorProducto.get(r.id) ?? 0), 0);
  const refConIdent = refs.filter((r) => (identPorProducto.get(r.id) ?? []).length > 0).length;

  resumen.push({
    clave, mercado: f.metadata?.market ?? "?", moneda: f.metadata?.currency ?? "?",
    descubiertos: aud.descubiertas ?? 0, fichas: prods.length,
    ausencias: aud.ausencias ?? 0, permanentes: aud.permanentes ?? 0, pendientes: aud.pendientes ?? 0,
    completa: aud.puede_declararse_completa, codigos: codigos.size, barcodes: barcodes.size,
    variantes: vars.length, imagenes: imgs.length, precios: pre.length,
    claims: cl.length, evidencias: ev.length,
    referencias: refs.length, refVariantes: variantesRef, refConIdent,
    coincidencias: coincidencias.length, ejemploCoincidencia: coincidencias.slice(0, 3)
  });
}

for (const r of resumen) {
  console.log(`── ${r.clave}  ·  mercado ${r.mercado} · moneda ${r.moneda} ──`);
  console.log(`   CIERRE                ${r.completa ? "COMPLETE" : "INCOMPLETO"}`);
  console.log(`   descubiertos          ${String(r.descubiertos).padStart(6)}`);
  console.log(`   fichas válidas        ${String(r.fichas).padStart(6)}`);
  console.log(`   ausencias válidas     ${String(r.ausencias).padStart(6)}   errores perm. ${r.permanentes} · pendientes ${r.pendientes}`);
  console.log(`   códigos (SKU)         ${String(r.codigos).padStart(6)}`);
  console.log(`   códigos de barras     ${String(r.barcodes).padStart(6)}${r.barcodes ? "   ← identidad fuerte" : "   ← la tienda no los expone"}`);
  console.log(`   variantes             ${String(r.variantes).padStart(6)}`);
  console.log(`   imágenes              ${String(r.imagenes).padStart(6)}   (referencia remota, no publicables)`);
  console.log(`   precios externos      ${String(r.precios).padStart(6)}   en ${r.moneda}`);
  console.log(`   claims semánticos     ${String(r.claims).padStart(6)}`);
  console.log(`   evidencias de código  ${String(r.evidencias).padStart(6)}`);
  console.log(`   referencias           ${String(r.referencias).padStart(6)}   variantes ${r.refVariantes} · con identificador ${r.refConIdent}`);
  console.log(`   coincide con Bellaroshé ${String(r.coincidencias).padStart(4)}${r.ejemploCoincidencia.length ? `   p.ej. ${r.ejemploCoincidencia.join(", ")}` : ""}`);
  console.log();
}

const suma = (k) => resumen.reduce((a, r) => a + (r[k] ?? 0), 0);
console.log(`${"═".repeat(78)}`);
console.log(`TOTALES  descubiertos ${suma("descubiertos")} · fichas ${suma("fichas")} · códigos ${suma("codigos")} · barcodes ${suma("barcodes")}`);
console.log(`         variantes ${suma("variantes")} · imágenes ${suma("imagenes")} · precios ${suma("precios")} · claims ${suma("claims")}`);
console.log(`         referencias ${suma("referencias")} · coincidencias con Bellaroshé ${suma("coincidencias")}`);
console.log(`${"═".repeat(78)}\n`);

fs.writeFileSync(path.join(ROOT, "outputs", "informe-marcas.json"), JSON.stringify(resumen, null, 2), "utf8");
console.log(`→ outputs/informe-marcas.json`);
