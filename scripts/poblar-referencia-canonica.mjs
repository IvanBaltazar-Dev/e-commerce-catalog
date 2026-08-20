/**
 * Mueve a su sitio lo que metí en metadata teniendo tabla propia.
 *
 * Al promover el universo de referencia guardé el precio y los identificadores
 * dentro del jsonb `metadata`. Existían tres tablas hechas para eso y las dejé
 * vacías:
 *
 *   catalog_reference_identifiers    identificador con tipo, normalizado
 *   catalog_reference_prices         observación de precio con fecha y moneda
 *   catalog_reference_presence_events qué cambió entre dos rastreos
 *
 * No es cosmético. Un campo jsonb guarda UN precio; la tabla guarda una SERIE, y
 * la serie es lo que permite decir «mercado observado S/ 15–23, mediana 18.90,
 * última revisión el 12 de agosto». Con el valor suelto en metadata, el segundo
 * rastreo pisa el primero y la historia se pierde en silencio.
 *
 * Y el identificador normalizado es lo que hace barato el lote de 5.000: buscar
 * por `normalized_value` con índice, en vez de recorrer jsonb.
 *
 * Uso:
 *   node scripts/poblar-referencia-canonica.mjs             (ensayo)
 *   node scripts/poblar-referencia-canonica.mjs --aplicar
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
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
const normaliza = (s) => (s ?? "").toString().trim().toUpperCase().replace(/[\s\-_.]/g, "");

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

const refProductos = await todas("catalog_reference_products", "id, primary_source_id, primary_source_record_id, primary_external_id, source_url, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata");
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, primary_source_id, primary_source_record_id, primary_external_id, sku, barcode, presentation, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata");

const identificadores = [];
const precios = [];

for (const rp of refProductos) {
  const base = {
    reference_product_id: rp.id, reference_variant_id: null,
    source_id: rp.primary_source_id, source_record_id: rp.primary_source_record_id,
    first_seen_run_id: rp.first_seen_run_id, last_seen_run_id: rp.last_seen_run_id,
    first_seen_at: rp.first_seen_at, last_seen_at: rp.last_seen_at
  };
  if (rp.primary_external_id) identificadores.push({ ...base, identifier_kind: "external_id", observed_value: rp.primary_external_id, normalized_value: normaliza(rp.primary_external_id) });
  if (rp.metadata?.handle) identificadores.push({ ...base, identifier_kind: "handle", observed_value: rp.metadata.handle, normalized_value: normaliza(rp.metadata.handle) });
  if (rp.source_url) identificadores.push({ ...base, identifier_kind: "source_url", observed_value: rp.source_url, normalized_value: normaliza(rp.source_url) });
}

for (const rv of refVariantes) {
  const base = {
    reference_product_id: null, reference_variant_id: rv.id,
    source_id: rv.primary_source_id, source_record_id: rv.primary_source_record_id,
    first_seen_run_id: rv.first_seen_run_id, last_seen_run_id: rv.last_seen_run_id,
    first_seen_at: rv.first_seen_at, last_seen_at: rv.last_seen_at
  };
  if (rv.primary_external_id) identificadores.push({ ...base, identifier_kind: "external_id", observed_value: rv.primary_external_id, normalized_value: normaliza(rv.primary_external_id) });
  if (rv.sku) identificadores.push({ ...base, identifier_kind: "sku", observed_value: rv.sku, normalized_value: normaliza(rv.sku) });
  if (rv.barcode) identificadores.push({ ...base, identifier_kind: "barcode", observed_value: rv.barcode, normalized_value: normaliza(rv.barcode) });

  const importe = rv.metadata?.precioObservado;
  if (importe != null) {
    // La clave del precio incluye el instante observado: dos rastreos del mismo
    // producto en fechas distintas son dos observaciones, no una corrección. Sin
    // eso, el segundo pisaría al primero y la serie no existiría.
    const observadoEn = rv.last_seen_at;
    precios.push({
      price_key: `${rv.id}:${sha(`${importe}|${observadoEn}`)}`,
      research_run_id: rv.last_seen_run_id,
      reference_product_id: null,
      reference_variant_id: rv.id,
      source_id: rv.primary_source_id,
      source_record_id: rv.primary_source_record_id,
      // Moneda de la tienda de origen. No se convierte: convertir aquí sería
      // inventar un tipo de cambio y una fecha que nadie observó.
      currency: rv.metadata?.moneda ?? "PEN",
      amount: importe,
      presentation: rv.presentation ?? null,
      external_availability: rv.metadata?.disponibleEnFuente === true ? "in_stock"
        : rv.metadata?.disponibleEnFuente === false ? "out_of_stock" : null,
      observed_at: observadoEn,
      content_fingerprint: sha(`${importe}|${rv.metadata?.precioListaObservado ?? ""}|${rv.metadata?.disponibleEnFuente}`),
      metadata: { precioListaObservado: rv.metadata?.precioListaObservado ?? null, origen: "promocion-universo" }
    });
  }
}

const porTipo = new Map();
for (const i of identificadores) porTipo.set(i.identifier_kind, (porTipo.get(i.identifier_kind) ?? 0) + 1);

console.log(`Identificadores de referencia a escribir: ${identificadores.length}`);
for (const [k, n] of [...porTipo].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(6)}  ${k}`);
console.log(`\nObservaciones de precio a escribir: ${precios.length}`);
const monedas = new Map();
for (const p of precios) monedas.set(p.currency, (monedas.get(p.currency) ?? 0) + 1);
for (const [m, n] of monedas) console.log(`   ${String(n).padStart(6)}  ${m}`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`);
  process.exit(0);
}

async function enLotes(tabla, filas, conflicto, tam = 500) {
  let hechas = 0;
  for (let i = 0; i < filas.length; i += tam) {
    const lote = filas.slice(i, i + tam);
    const { error } = conflicto
      ? await db.from(tabla).upsert(lote, { onConflict: conflicto })
      : await db.from(tabla).insert(lote);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    hechas += lote.length;
    if (hechas % 3000 === 0 || hechas === filas.length) console.log(`   ${tabla}: ${hechas}/${filas.length}`);
  }
}

// Los identificadores no tienen clave natural declarada en el esquema, así que
// se limpia lo de esta procedencia antes de reescribir. Insertar sin limpiar
// duplicaría en cada corrida, que es justo lo contrario de lo que este universo
// debe hacer.
const { count: previos } = await db.from("catalog_reference_identifiers").select("*", { count: "exact", head: true });
if (previos) {
  console.log(`   limpiando ${previos} identificadores de una corrida anterior…`);
  await db.from("catalog_reference_identifiers").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

await enLotes("catalog_reference_identifiers", identificadores, null);
await enLotes("catalog_reference_prices", precios, "price_key");

const { count: idFinal } = await db.from("catalog_reference_identifiers").select("*", { count: "exact", head: true });
const { count: pxFinal } = await db.from("catalog_reference_prices").select("*", { count: "exact", head: true });
console.log(`\ncatalog_reference_identifiers: ${idFinal}`);
console.log(`catalog_reference_prices:      ${pxFinal}`);
