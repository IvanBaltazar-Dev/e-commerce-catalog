/**
 * ¿Qué más produjo un match contaminado, además de las nueve fotos?
 *
 * Retirar los medios y superseder los casos no basta. Un falso MATCH_EXACT pudo
 * haber alimentado cualquier derivación posterior: código de barras,
 * identificador de fabricante, cobertura, precio, atributo o candidato. Y como
 * cada una se escribió confiando en el caso sin volver a preguntar por su
 * calidad, hay que recorrer la cadena entera hacia adelante.
 *
 * La evidencia NO se borra. Un caso superado sigue ahí diciendo qué se creyó y
 * cuándo; lo que se invalida es la derivación, no la historia. Reescribir el
 * pasado dejaría el sistema sin forma de explicar cómo llegó aquí.
 *
 * Uso:
 *   node scripts/auditar-contaminacion.mjs             (informe)
 *   node scripts/auditar-contaminacion.mjs --invalidar
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVALIDAR = process.argv.includes("--invalidar");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { evaluarIdentidadPorIdentificador } = await import("../src/lib/catalog-intelligence/identidad-guardas.ts");

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

// ── 1 · Qué casos están contaminados, según el gate de HOY ─────────────────
// No se confía en la marca que se puso a mano: se vuelve a pasar el gate por
// TODOS los casos vivos. Si el criterio nuevo rechaza uno que sigue activo, es
// contaminación que la limpieza manual no vio.
const casos = await todas("catalog_reconciliation_cases",
  "id, entity_type, product_id, variant_id, reference_variant_id, reference_product_id, algorithm, status, evidence");
const variantes = await todas("product_variants", "id, product_id, name, sku, sku_origen, barcode");
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, sku, name, shade_name");
const refProductos = await todas("catalog_reference_products", "id, brand_id, name");
const productos = await todas("products", "id, name, brand_id, brands(name)");
const marcas = await todas("brands", "id, name");

const varPorId = new Map(variantes.map((v) => [v.id, v]));
const refVarPorId = new Map(refVariantes.map((r) => [r.id, r]));
const refProdPorId = new Map(refProductos.map((r) => [r.id, r]));
const prodPorId = new Map(productos.map((p) => [p.id, p]));
const marcaPorId = new Map(marcas.map((b) => [b.id, b.name]));

const contaminados = [];
const limpios = new Set();

for (const c of casos) {
  if (c.entity_type !== "variant" || !c.reference_variant_id) continue;
  const v = varPorId.get(c.variant_id);
  const rv = refVarPorId.get(c.reference_variant_id);
  if (!v || !rv) continue;
  const p = prodPorId.get(v.product_id);
  const rp = refProdPorId.get(rv.reference_product_id);

  const veredicto = evaluarIdentidadPorIdentificador(
    {
      valor: v.sku ?? "",
      clase: v.sku_origen === "OFICIAL_MARCA" ? "MANUFACTURER_SKU" : "BELLAROSHE_SKU",
      emisor: v.sku_origen === "OFICIAL_MARCA" ? (p?.brands?.name ?? null) : "Bellaroshé",
      nombre: `${p?.name ?? ""} ${v.name}`.trim(),
    },
    {
      valor: rv.sku ?? "",
      clase: "MANUFACTURER_SKU",
      emisor: marcaPorId.get(rp?.brand_id) ?? null,
      nombre: `${rp?.name ?? ""} ${rv.shade_name ?? ""}`.trim() || rv.name,
    },
  );

  const declaradoExacto = c.evidence?.clase === "MATCH_EXACT";
  const vivo = ["proposed", "needs_review", "approved"].includes(c.status);

  if (declaradoExacto && veredicto.veredicto !== "MATCH_EXACT") {
    contaminados.push({
      casoId: c.id, variantId: v.id, sigueVivo: vivo, status: c.status,
      nuestro: `${p?.name ?? ""} · ${v.name}`, oficial: rv.name,
      marca: p?.brands?.name ?? "—", razon: veredicto.razon
    });
  } else if (declaradoExacto) {
    limpios.add(c.id);
  }
}

console.log(`Casos de variante examinados: ${casos.filter((c) => c.entity_type === "variant").length}`);
console.log(`  declarados exactos y que el gate de hoy CONFIRMA: ${limpios.size}`);
console.log(`  declarados exactos que el gate de hoy RECHAZA:    ${contaminados.length}`);
const vivosContaminados = contaminados.filter((c) => c.sigueVivo);
console.log(`     de esos, todavía vivos: ${vivosContaminados.length}`);
if (vivosContaminados.length) {
  for (const c of vivosContaminados.slice(0, 10)) {
    console.log(`       ${c.marca.padEnd(12)} ${c.nuestro.slice(0, 34).padEnd(36)} → ${c.oficial.slice(0, 30)}`);
  }
}

// ── 2 · Qué derivaciones cuelgan de casos contaminados ─────────────────────
const idsContaminados = new Set(contaminados.map((c) => c.casoId));
const variantesContaminadas = new Set(contaminados.map((c) => c.variantId));

const identificadores = await todas("variant_identifiers",
  "id, variant_id, identifier_type, value, status, reconciliation_case_id, reference_variant_id");
const medios = await todas("media_assets", "id, metadata, checksum", (q) => q.not("metadata->>origen", "is", null));
const enlacesMedios = await todas("product_media", "media_asset_id, variant_id");

// Se invalida lo que DEPENDE del match, no todo lo que toca la misma variante.
//
// Un BELLAROSHE_SKU salió de nuestra propia columna en 0139: su cadena causal no
// pasa por ninguna reconciliación y sigue siendo cierto aunque el match fuera
// falso. Barrerlo por vivir en la misma variante sería destruir dato bueno para
// castigar un error ajeno — y dejaría a esas variantes sin su único código.
//
// Lo que sí depende del match es lo que llegó DESDE la referencia: el
// MANUFACTURER_SKU que registramos porque creímos que esa ficha era esta
// variante. Eso es exactamente lo que resultó falso.
const dependeDelMatch = (i) =>
  idsContaminados.has(i.reconciliation_case_id)
  || (i.reference_variant_id != null && variantesContaminadas.has(i.variant_id))
  || (i.identifier_type !== "BELLAROSHE_SKU" && variantesContaminadas.has(i.variant_id)
      && i.reconciliation_case_id == null && i.reference_variant_id == null
      && i.identifier_type === "MANUFACTURER_SKU");

const idsSospechosos = identificadores.filter((i) => i.status === "active" && dependeDelMatch(i));
const idsIndependientes = identificadores.filter(
  (i) => i.status === "active" && variantesContaminadas.has(i.variant_id) && !dependeDelMatch(i)
);
const barcodesSospechosos = variantes.filter((v) => v.barcode && variantesContaminadas.has(v.id));
const variantesConMedio = new Set(enlacesMedios.filter((e) => e.variant_id).map((e) => e.variant_id));
const mediosSospechosos = [...variantesContaminadas].filter((vid) => variantesConMedio.has(vid));

console.log(`\nDERIVACIONES que cuelgan de un caso contaminado:`);
console.log(`   identificadores activos:   ${idsSospechosos.length}`);
console.log(`   códigos de barras escritos: ${barcodesSospechosos.length}`);
console.log(`   variantes con medio:        ${mediosSospechosos.length}`);
console.log(`   (${idsIndependientes.length} identificadores tocan esas variantes pero NO dependen del match: se conservan)`);

if (idsSospechosos.length) {
  const porTipo = new Map();
  for (const i of idsSospechosos) porTipo.set(i.identifier_type, (porTipo.get(i.identifier_type) ?? 0) + 1);
  console.log(`\n   por tipo de identificador:`);
  for (const [t, n] of porTipo) console.log(`      ${String(n).padStart(4)}  ${t}`);
  for (const i of idsSospechosos.slice(0, 8)) {
    const v = varPorId.get(i.variant_id);
    console.log(`      ${i.identifier_type.padEnd(18)} ${i.value.padEnd(14)} ${String(v?.name ?? "").slice(0, 28)}`);
  }
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "auditoria-contaminacion.json"),
  JSON.stringify({ contaminados, idsSospechosos, barcodesSospechosos: barcodesSospechosos.map((v) => ({ id: v.id, sku: v.sku, barcode: v.barcode })), mediosSospechosos }, null, 2), "utf8");

if (!INVALIDAR) {
  console.log(`\nInforme. Nada invalidado. Añade --invalidar.`);
  console.log(`→ outputs/auditoria-contaminacion.json`);
  process.exit(0);
}

let casosCerrados = 0, idsInvalidados = 0;

for (const c of vivosContaminados) {
  const { error } = await db.from("catalog_reconciliation_cases").update({
    status: "superseded", decided_at: new Date().toISOString(),
    decision_reason: `invalidado por el gate de identidad: ${c.razon}`
  }).eq("id", c.casoId);
  if (!error) casosCerrados += 1;
}

// El identificador no se borra: se marca rechazado con el motivo. Borrarlo
// dejaría el sistema sin memoria de que una vez creyó esto.
for (const i of idsSospechosos) {
  const { error } = await db.from("variant_identifiers").update({
    status: "rejected", is_primary: false,
    metadata: { invalidadoPor: "auditoria-contaminacion", motivo: "su cadena causal pasa por un match que el gate de identidad rechaza" }
  }).eq("id", i.id);
  if (!error) idsInvalidados += 1;
}

console.log(`\nCasos cerrados como superados: ${casosCerrados}`);
console.log(`Identificadores marcados rechazados: ${idsInvalidados}`);
console.log(`La evidencia se conserva: nada se borró, solo dejó de contar.`);
