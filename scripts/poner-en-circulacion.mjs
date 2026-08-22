/**
 * Lleva a la capa de referencia lo que se capturó bien y se quedó sin circular.
 *
 * La regla del bloque es que nada capturado correctamente puede quedarse fuera
 * por un fallo del pipeline. Dos casos la incumplían, y los dos son del mismo
 * tipo: el dato existe en catalog_source_records, la campaña cerró COMPLETE, y
 * la capa que todo el mundo lee no lo tiene.
 *
 *   295 códigos de barras   cosechados uno a uno de las fichas de Masglo, en los
 *                           registros de fuente y en cero variantes de referencia.
 *                           Con eso, la reconciliación por GTIN estaba CIEGA: daba
 *                           0 coincidencias teniendo 295 códigos y 147 nuestros.
 *
 *   1.396 precios           de Cherimoya, ya con la escala corregida, capturados
 *                           en el payload y sin una sola fila en precios de
 *                           referencia — porque los anteriores se retiraron por
 *                           estar multiplicados por 100 y nadie puso los buenos.
 *
 * Retirar lo malo sin poner lo bueno deja un agujero peor que el original: antes
 * había precios equivocados, después no había ninguno.
 *
 *   node --experimental-transform-types scripts/poner-en-circulacion.mjs [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 1 · Los códigos de barras, arrastrados por IDENTIDAD ───────────────────
//
// No por id de registro: el enriquecimiento no sobrevive a una recaptura. Los
// 295 códigos de Masglo se cosecharon uno a uno contra el snapshot de entonces,
// y las recargas posteriores crearon registros nuevos sin ellos. El snapshot
// vigente tenía 0 y los 295 seguían en snapshots anteriores.
//
// Un código de barras es propiedad de la VARIANTE —identificada por (fuente,
// id externo)— y no del snapshot en que se capturó, así que se arrastra por ahí.
const registros = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, source_id, entity_type, external_id, barcode").not("barcode", "is", null),
  orden: ["id"], clave: (r) => r.id, nombre: "registros con código de barras",
});
// El id externo ha cambiado de forma entre snapshots —«v:123» y
// «shopify-variant:123» son la misma variante— así que la identidad se compara
// por el número, no por la cadena entera. Comparar la cadena daba 0 coincidencias
// teniendo los 295 códigos delante.
const idNumerico = (externo) => String(externo ?? "").split(":").pop();
const identidadDe = (r) => `${r.source_id}|${r.entity_type}|${idNumerico(r.external_id)}`;
const barcodePorIdentidad = new Map(registros.map((r) => [identidadDe(r), r.barcode]));

// Y para poder cruzar, hace falta saber la identidad del registro al que apunta
// cada variante vigente.
const registrosVariante = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, source_id, entity_type, external_id").eq("entity_type", "variant"),
  orden: ["id"], clave: (r) => r.id, nombre: "registros de variante",
});
const identidadPorRegistro = new Map(registrosVariante.map((r) => [r.id, identidadDe(r)]));

const variantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, primary_source_record_id, barcode, sku"),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes vigentes",
});
const aPropagar = variantes
  .map((v) => {
    if (v.barcode) return null;
    const identidad = identidadPorRegistro.get(v.primary_source_record_id);
    const codigo = identidad ? barcodePorIdentidad.get(identidad) : null;
    return codigo ? { id: v.id, barcode: codigo } : null;
  })
  .filter(Boolean);

console.log(`Códigos de barras`);
console.log(`  en registros de fuente     ${String(registros.length).padStart(6)}`);
console.log(`  variantes vigentes         ${String(variantes.length).padStart(6)}`);
console.log(`  ya con código              ${String(variantes.filter((v) => v.barcode).length).padStart(6)}`);
console.log(`  a propagar                 ${String(aPropagar.length).padStart(6)}`);

// ── 2 · Los precios de la campaña WooCommerce ───────────────────────────────
const { data: fuenteWoo } = await db.from("catalog_sources")
  .select("id, source_key, metadata").eq("source_key", "cherimoya-pe-official").single();
const { data: snapWoo } = await db.from("catalog_source_snapshots")
  .select("id").eq("source_id", fuenteWoo.id)
  .eq("metadata->>via", "woocommerce_store_api").order("created_at", { ascending: false }).limit(1).single();

const fichas = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, external_id, payload").eq("snapshot_id", snapWoo.id).eq("entity_type", "product"),
  orden: ["id"], clave: (r) => r.external_id, nombre: "fichas woo",
});
const refsWoo = await leerTodo({
  consulta: () => db.from("catalog_reference_products")
    .select("id, primary_external_id").eq("primary_source_id", fuenteWoo.id),
  orden: ["id"], clave: (r) => r.primary_external_id, nombre: "referencias woo",
});
const refPorExterno = new Map(refsWoo.map((r) => [r.primary_external_id, r.id]));

const filasPrecio = [];
let sinReferencia = 0;
for (const f of fichas) {
  const p = f.payload ?? {};
  if (p.precio === null || p.precio === undefined) continue;
  const refId = refPorExterno.get(String(p.id));
  if (!refId) { sinReferencia += 1; continue; }
  filasPrecio.push({
    // La llave lleva el importe: si mañana cambia el precio, es otra observación
    // y no una corrección de la anterior.
    price_key: `woo-price-v1:${fuenteWoo.source_key}:${p.id}:${sha({ precio: p.precio, moneda: p.moneda })}`,
    reference_product_id: refId,
    reference_variant_id: null,
    source_id: fuenteWoo.id,
    source_record_id: f.id,
    currency: p.moneda ?? fuenteWoo.metadata?.currency ?? "PEN",
    amount: p.precio,
    external_availability: p.is_in_stock ? "available" : "out_of_stock",
    observed_at: new Date().toISOString(),
    content_fingerprint: sha({ id: p.id, precio: p.precio, moneda: p.moneda }),
    metadata: {
      origen: "woocommerce_store_api",
      // Deja el crudo y la escala: sin ellos, un precio corregido y uno mal
      // capturado son indistinguibles a simple vista.
      precio_crudo: p.precio_crudo ?? null,
      escala_moneda: p.escala_moneda ?? null,
      mercado: fuenteWoo.metadata?.market ?? null,
      nota: "importe ya dividido por 10^currency_minor_unit segun declara la API",
    },
  });
}

console.log(`\nPrecios de ${fuenteWoo.source_key}`);
console.log(`  fichas con precio          ${String(filasPrecio.length).padStart(6)}`);
if (sinReferencia) console.log(`  sin referencia de producto ${String(sinReferencia).padStart(6)}`);
if (filasPrecio.length) {
  const imp = filasPrecio.map((x) => Number(x.amount));
  console.log(`  rango                      ${Math.min(...imp).toFixed(2)} – ${Math.max(...imp).toFixed(2)} ${filasPrecio[0].currency}`);
}

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

// Los precios exigen un run: esto es una puesta en circulación, no una captura,
// y conviene poder distinguirlas después.
const { data: run, error: eRun } = await db.from("catalog_research_runs").insert({
  run_key: `poner-en-circulacion:${snapWoo.id}`,
  run_kind: "targeted", actor_kind: "system", actor_label: "poner-en-circulacion",
  input_fingerprint: sha({ snapshot: snapWoo.id, precios: filasPrecio.length }),
  scope: { fuente: fuenteWoo.source_key, snapshot: snapWoo.id },
}).select("id").single();
if (eRun && !/duplicate|unique/i.test(eRun.message)) throw new Error(`run: ${eRun.message}`);
const runId = run?.id ?? (await db.from("catalog_research_runs").select("id")
  .eq("run_key", `poner-en-circulacion:${snapWoo.id}`).single()).data.id;
for (const fila of filasPrecio) fila.research_run_id = runId;

let propagados = 0;
for (const v of aPropagar) {
  const { error } = await db.from("catalog_reference_variants").update({ barcode: v.barcode }).eq("id", v.id);
  if (error) throw new Error(`barcode: ${error.message}`);
  propagados += 1;
}
console.log(`\n  códigos de barras propagados: ${propagados}`);

let escritos = 0;
for (let i = 0; i < filasPrecio.length; i += 200) {
  const { error } = await db.from("catalog_reference_prices")
    .upsert(filasPrecio.slice(i, i + 200), { onConflict: "price_key", ignoreDuplicates: true });
  if (error) throw new Error(`precios: ${error.message}`);
  escritos += Math.min(200, filasPrecio.length - i);
}
console.log(`  precios puestos en circulación: ${escritos}`);

const { count: gtinAhora } = await db.from("catalog_reference_variants_vigentes_v1")
  .select("*", { count: "exact", head: true }).not("barcode", "is", null);
const { count: preciosAhora } = await db.from("catalog_reference_prices_vigentes_v1")
  .select("*", { count: "exact", head: true }).eq("source_id", fuenteWoo.id);
console.log(`\n  variantes vigentes con GTIN: ${gtinAhora}`);
console.log(`  precios vigentes de Cherimoya: ${preciosAhora}`);
