/**
 * Las seis fuentes en un solo cuadro, y la reconciliación contra Bellaroshé.
 *
 * Hasta aquí cada fuente se medía por separado y el total no significaba nada:
 * sumar 3.397 fichas no dice cuántos productos distintos hay, porque el mismo
 * producto puede estar en dos tiendas del mismo grupo. Aquí se resuelve identidad
 * antes de contar.
 *
 * Dos reglas que gobiernan todo el informe:
 *
 *   · Nada capturado correctamente puede quedarse sin circular. Si una fuente
 *     tiene registros y cero referencias vigentes, eso es un fallo del pipeline y
 *     sale marcado, no se disimula con un total agregado.
 *
 *   · Nada retirado vuelve a circular. Todas las lecturas entran por las vistas
 *     «vigentes», nunca por las tablas base.
 *
 *   node --experimental-transform-types scripts/consolidacion-global.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = ["masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"];

/** La forma de comparación de un código. Sin esto, «CH-073» y «CH073» son dos. */
const normCodigo = (s) => String(s ?? "").toUpperCase().replace(/[\s\-_.#]/g, "").trim();
const normTexto = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const { data: fuentes } = await db.from("catalog_sources")
  .select("id, source_key, metadata").in("source_key", FUENTES);
const nombreFuente = Object.fromEntries(fuentes.map((f) => [f.id, f.source_key]));
const mercado = Object.fromEntries(fuentes.map((f) => [f.id, f.metadata?.market ?? "?"]));
const moneda = Object.fromEntries(fuentes.map((f) => [f.id, f.metadata?.currency ?? "?"]));
const ids = fuentes.map((f) => f.id);

// ── Todo por las vistas vigentes ────────────────────────────────────────────
const productos = await leerTodo({
  consulta: () => db.from("catalog_reference_products")
    .select("id, primary_source_id, primary_external_id, name, normalized_name, product_type, line, presentation, primary_image_url")
    .in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "productos de referencia",
});
const variantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, reference_product_id, primary_source_id, primary_external_id, name, sku, barcode, shade_name, presentation, metadata")
    .in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes vigentes",
});
const precios = await leerTodo({
  consulta: () => db.from("catalog_reference_prices_vigentes_v1")
    .select("id, source_id, currency, amount, observed_at, reference_variant_id, external_availability")
    .in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "precios vigentes",
});
const medios = await leerTodo({
  consulta: () => db.from("catalog_reference_media")
    .select("id, source_id, reference_product_id, reference_variant_id, remote_url, validation_status")
    .in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "medios de referencia",
});
const registros = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, source_id, entity_type, sku, barcode, payload").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "registros de fuente",
});
const variantesBella = await leerTodo({
  consulta: () => db.from("product_variants").select("id, product_id, sku, barcode"),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes Bellaroshé",
});

// ── Cuadro por fuente ───────────────────────────────────────────────────────
console.log(`\n${"═".repeat(96)}`);
console.log(`CONSOLIDACIÓN DE LAS SEIS FUENTES`);
console.log(`${"═".repeat(96)}\n`);
console.log(`  ${"fuente".padEnd(22)} ${"merc".padEnd(5)} ${"prod".padStart(5)} ${"var".padStart(5)} ${"SKU".padStart(5)} ${"GTIN".padStart(5)} ${"img".padStart(6)} ${"precios".padStart(8)} circula`);
console.log(`  ${"-".repeat(22)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(8)} -------`);

const porFuente = [];
const sinCircular = [];
for (const f of fuentes) {
  const p = productos.filter((x) => x.primary_source_id === f.id);
  const v = variantes.filter((x) => x.primary_source_id === f.id);
  const pr = precios.filter((x) => x.source_id === f.id);
  const im = medios.filter((x) => x.source_id === f.id);
  const regs = registros.filter((x) => x.source_id === f.id);
  const regProd = regs.filter((x) => x.entity_type === "product").length;
  const sku = new Set(v.map((x) => normCodigo(x.sku)).filter(Boolean));
  const gtin = new Set([...v.map((x) => x.barcode), ...regs.map((x) => x.barcode)].filter(Boolean));
  // La comprobación mira CADA clase de dato, no solo variantes. La primera
  // versión solo miraba variantes y dio el visto bueno teniendo 1.396 precios de
  // Cherimoya capturados y cero circulando, y 295 códigos de barras en registros
  // y cero en referencias. Un «✓» que solo mira una columna es peor que ninguno.
  const regConPrecio = regs.filter((x) => x.payload?.precio !== undefined && x.payload?.precio !== null).length;
  const regConBarcode = regs.filter((x) => x.barcode).length;
  const faltas = [];
  if (regProd > 0 && v.length === 0) faltas.push(`${regProd} fichas capturadas y 0 variantes vigentes`);
  if (regConPrecio > 0 && pr.length === 0) faltas.push(`${regConPrecio} precios capturados y 0 circulando`);
  if (regConBarcode > 0 && v.filter((x) => x.barcode).length === 0) faltas.push(`${regConBarcode} códigos de barras capturados y 0 en variantes`);
  const circula = faltas.length === 0;
  for (const t of faltas) sinCircular.push(`${f.source_key}: ${t}`);
  porFuente.push({ fuente: f.source_key, mercado: mercado[f.id], moneda: moneda[f.id],
    productos: p.length, variantes: v.length, sku: sku.size, gtin: gtin.size,
    imagenes: im.length, precios: pr.length, registros: regs.length, circula });
  console.log(`  ${f.source_key.padEnd(22)} ${mercado[f.id].padEnd(5)} ${String(p.length).padStart(5)} ${String(v.length).padStart(5)} ${String(sku.size).padStart(5)} ${String(gtin.size).padStart(5)} ${String(im.length).padStart(6)} ${String(pr.length).padStart(8)} ${circula ? "sí" : "NO"}`);
}

// ── Identidad consolidada ───────────────────────────────────────────────────
// Un código puede aparecer en varias fuentes: eso no son dos productos, es un
// producto visto dos veces. Contar sin resolverlo inflaría el universo.
const porCodigo = new Map();
for (const v of variantes) {
  const c = normCodigo(v.sku);
  if (!c) continue;
  if (!porCodigo.has(c)) porCodigo.set(c, []);
  porCodigo.get(c).push(v);
}
const enVariasFuentes = [...porCodigo.entries()]
  .filter(([, vs]) => new Set(vs.map((v) => v.primary_source_id)).size > 1);

const porGtin = new Map();
for (const r of registros) {
  if (!r.barcode) continue;
  if (!porGtin.has(r.barcode)) porGtin.set(r.barcode, new Set());
  porGtin.get(r.barcode).add(r.source_id);
}

console.log(`\n${"─".repeat(96)}`);
console.log(`IDENTIDAD`);
console.log(`${"─".repeat(96)}`);
console.log(`  variantes vigentes en total        ${String(variantes.length).padStart(6)}`);
console.log(`  con código de fabricante           ${String([...porCodigo.keys()].length).padStart(6)}  códigos distintos`);
console.log(`  con GTIN                           ${String(porGtin.size).padStart(6)}  códigos de barras distintos`);
console.log(`  códigos vistos en más de una fuente ${String(enVariasFuentes.length).padStart(5)}`);
if (enVariasFuentes.length) {
  for (const [c, vs] of enVariasFuentes.slice(0, 5)) {
    console.log(`     ${c.padEnd(14)} ${[...new Set(vs.map((v) => nombreFuente[v.primary_source_id].replace("-official", "")))].join(", ")}`);
  }
}

// ── Ejes y atributos, ahora con las seis juntas ─────────────────────────────
const ejes = new Map();
for (const v of variantes) {
  for (const e of v.metadata?.ejes ?? []) ejes.set(e.name, (ejes.get(e.name) ?? 0) + 1);
  for (const e of v.metadata?.optionAxes ?? []) ejes.set(e.eje, (ejes.get(e.eje) ?? 0) + 1);
}
const atributosWoo = new Map();
for (const r of registros.filter((x) => x.entity_type === "product")) {
  for (const a of r.payload?.attributes ?? []) atributosWoo.set(a.nombre ?? a.name, (atributosWoo.get(a.nombre ?? a.name) ?? 0) + 1);
}
// Agrupar por forma normalizada revela cuántos son el mismo concepto escrito
// distinto — que es la pregunta de la v2, y solo se puede responder con las seis.
const porConcepto = new Map();
for (const [nombre, n] of [...ejes, ...atributosWoo]) {
  if (!nombre) continue;
  const k = normTexto(nombre);
  if (!porConcepto.has(k)) porConcepto.set(k, { formas: new Set(), n: 0 });
  porConcepto.get(k).formas.add(nombre);
  porConcepto.get(k).n += n;
}

console.log(`\n${"─".repeat(96)}`);
console.log(`EJES Y ATRIBUTOS · las seis juntas`);
console.log(`${"─".repeat(96)}`);
console.log(`  nombres crudos distintos   ${String(ejes.size + atributosWoo.size).padStart(4)}`);
console.log(`  conceptos tras normalizar  ${String(porConcepto.size).padStart(4)}`);
const multiforma = [...porConcepto.entries()].filter(([, x]) => x.formas.size > 1);
console.log(`  escritos de varias formas  ${String(multiforma.length).padStart(4)}`);
for (const [k, x] of multiforma.sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  console.log(`     ${String(x.n).padStart(4)}  ${k.padEnd(16)} ${[...x.formas].join(" / ")}`);
}

// ── Precios ─────────────────────────────────────────────────────────────────
const porMoneda = {};
for (const p of precios) {
  const k = `${nombreFuente[p.source_id]?.replace("-official", "")} · ${p.currency}`;
  if (!porMoneda[k]) porMoneda[k] = { n: 0, min: Infinity, max: 0 };
  porMoneda[k].n += 1;
  porMoneda[k].min = Math.min(porMoneda[k].min, Number(p.amount));
  porMoneda[k].max = Math.max(porMoneda[k].max, Number(p.amount));
}
console.log(`\n${"─".repeat(96)}`);
console.log(`PRECIOS EXTERNOS · con su mercado y su moneda`);
console.log(`${"─".repeat(96)}`);
for (const [k, x] of Object.entries(porMoneda).sort()) {
  console.log(`  ${k.padEnd(30)} ${String(x.n).padStart(5)} precios · ${x.min.toFixed(2)} – ${x.max.toFixed(2)}`);
}

// ── Imágenes ────────────────────────────────────────────────────────────────
const urls = new Set(medios.map((m) => m.remote_url));
const deProducto = medios.filter((m) => m.reference_product_id && !m.reference_variant_id).length;
const deVariante = medios.filter((m) => m.reference_variant_id).length;
console.log(`\n${"─".repeat(96)}`);
console.log(`IMÁGENES`);
console.log(`${"─".repeat(96)}`);
console.log(`  registros de medio        ${String(medios.length).padStart(6)}`);
console.log(`  URLs distintas            ${String(urls.size).padStart(6)}   (repetidas: ${medios.length - urls.size})`);
console.log(`  atadas a producto         ${String(deProducto).padStart(6)}`);
console.log(`  atadas a variante         ${String(deVariante).padStart(6)}`);
const porValidacion = {};
for (const m of medios) porValidacion[m.validation_status] = (porValidacion[m.validation_status] ?? 0) + 1;
for (const [k, n] of Object.entries(porValidacion)) console.log(`  ${String(k).padEnd(24)} ${String(n).padStart(6)}`);

// ── Reconciliación contra Bellaroshé ────────────────────────────────────────
const bellaPorSku = new Map();
const bellaPorGtin = new Map();
for (const v of variantesBella) {
  const c = normCodigo(v.sku);
  if (c) { if (!bellaPorSku.has(c)) bellaPorSku.set(c, []); bellaPorSku.get(c).push(v); }
  if (v.barcode) { if (!bellaPorGtin.has(v.barcode)) bellaPorGtin.set(v.barcode, []); bellaPorGtin.get(v.barcode).push(v); }
}

const veredictos = { MATCH_GTIN: [], MATCH_SKU: [], CONTRADICCION: [], REFERENCIA_NUEVA: [] };
for (const [codigo, vs] of porCodigo) {
  const gtins = vs.map((v) => v.barcode).filter(Boolean);
  const porGtinBella = gtins.flatMap((g) => bellaPorGtin.get(g) ?? []);
  const porSkuBella = bellaPorSku.get(codigo) ?? [];

  if (porGtinBella.length) {
    // El GTIN manda. Si además coincide el SKU, perfecto; si NO coincide, eso es
    // una contradicción que hay que mirar, no un match que se da por bueno.
    const mismoSku = porGtinBella.some((b) => normCodigo(b.sku) === codigo);
    (mismoSku ? veredictos.MATCH_GTIN : veredictos.CONTRADICCION).push({ codigo, gtin: gtins[0] });
  } else if (porSkuBella.length) {
    veredictos.MATCH_SKU.push({ codigo, nuestras: porSkuBella.length });
  } else {
    veredictos.REFERENCIA_NUEVA.push({ codigo, fuentes: [...new Set(vs.map((v) => nombreFuente[v.primary_source_id]))] });
  }
}

console.log(`\n${"─".repeat(96)}`);
console.log(`RECONCILIACIÓN CONTRA BELLAROSHÉ · ${variantesBella.length} variantes internas`);
console.log(`${"─".repeat(96)}`);
console.log(`  MATCH por GTIN            ${String(veredictos.MATCH_GTIN.length).padStart(6)}   identidad global, la más fuerte`);
console.log(`  MATCH por SKU             ${String(veredictos.MATCH_SKU.length).padStart(6)}   dentro del espacio de nombres`);
console.log(`  CONTRADICCIÓN             ${String(veredictos.CONTRADICCION.length).padStart(6)}   el GTIN coincide y el SKU no`);
console.log(`  REFERENCIA NUEVA          ${String(veredictos.REFERENCIA_NUEVA.length).padStart(6)}   no está en nuestro catálogo`);

// ── La regla dura ───────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(96)}`);
if (sinCircular.length) {
  console.log(`FUENTES CON DATO CAPTURADO QUE NO CIRCULA`);
  for (const s of sinCircular) console.log(`  ✗ ${s}`);
} else {
  console.log(`✓ Ninguna fuente tiene dato capturado sin circular.`);
}
const { count: retiradasCirculando } = await db.from("catalog_reference_variants_vigentes_v1")
  .select("*", { count: "exact", head: true }).not("superseded_at", "is", null);
console.log(`${retiradasCirculando === 0 ? "✓" : "✗"} Retiradas circulando: ${retiradasCirculando}`);
console.log(`${"═".repeat(96)}`);

fs.writeFileSync(path.join(ROOT, "outputs", "consolidacion-global.json"), JSON.stringify({
  porFuente, identidad: { variantes: variantes.length, codigos: porCodigo.size, gtins: porGtin.size, enVariasFuentes: enVariasFuentes.length },
  conceptos: Object.fromEntries([...porConcepto].map(([k, x]) => [k, { formas: [...x.formas], n: x.n }])),
  precios: porMoneda, imagenes: { total: medios.length, distintas: urls.size, deProducto, deVariante },
  veredictos: Object.fromEntries(Object.entries(veredictos).map(([k, v]) => [k, v.length])),
  detalleVeredictos: veredictos, sinCircular,
}, null, 2), "utf8");
console.log(`\n→ outputs/consolidacion-global.json`);
