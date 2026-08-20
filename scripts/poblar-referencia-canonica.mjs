/**
 * Memoria de referencia: identificadores, precio histórico y presencia.
 *
 * Al promover el universo dejé el precio y los identificadores dentro del jsonb
 * `metadata`. Eso convertía el precio en ESTADO ACTUAL, y un estado actual se
 * pisa: el próximo rastreo habría sobrescrito el anterior y la historia se
 * habría perdido sin que saltara nada.
 *
 * Aquí `metadata` pasa a ser solo la ENTRADA del backfill. El destino son las
 * tres tablas que ya existían para esto y estaban vacías:
 *
 *   catalog_reference_identifiers     identificador con namespace y normalizado
 *   catalog_reference_prices          observación de precio, append-only
 *   catalog_reference_presence_events qué se vio, cuándo, y qué cambió
 *
 * Tres reglas que no se negocian:
 *
 * 1. La fecha es la REAL. Los seis catálogos se capturaron el 2026-08-10 a las
 *    11:07:39.904Z, en un único instante. Fechar el backfill con la hora de hoy
 *    inventaría ocho días de historia que nadie observó.
 *
 * 2. El precio nunca se actualiza. Mismo snapshot y mismo precio → misma clave →
 *    el segundo backfill escribe cero. Precio distinto → fila nueva. Un UPDATE
 *    sobre un precio observado sería falsificar lo que la tienda dijo.
 *
 * 3. Un GTIN no pertenece a quien lo observó. Cinco tiendas publicando el mismo
 *    EAN son cinco evidencias de un identificador, no cinco identificadores.
 *
 * Uso:
 *   node scripts/poblar-referencia-canonica.mjs             (ensayo)
 *   node scripts/poblar-referencia-canonica.mjs --aplicar
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

const refProductos = await todas("catalog_reference_products",
  "id, brand_id, primary_source_id, primary_source_record_id, primary_external_id, source_url, content_fingerprint, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata");
const refVariantes = await todas("catalog_reference_variants",
  "id, reference_product_id, primary_source_id, primary_source_record_id, primary_external_id, sku, barcode, presentation, content_fingerprint, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata");
const registros = await todas("catalog_source_records", "id, source_id, captured_at, snapshot_id",
  (q) => q.in("entity_type", ["product", "variant"]));
const marcas = await todas("brands", "id, name");
const fuentes = await todas("catalog_sources", "id, source_key, brand_id");

const marcaPorId = new Map(marcas.map((b) => [b.id, b.name]));
const fuentePorId = new Map(fuentes.map((f) => [f.id, f]));
const registroPorId = new Map(registros.map((r) => [r.id, r]));
const refProdPorId = new Map(refProductos.map((r) => [r.id, r]));

/** La fecha real del registro que lo produjo. Nunca now(). */
function cuandoSeVio(sourceRecordId, respaldo) {
  return registroPorId.get(sourceRecordId)?.captured_at ?? respaldo;
}

// ── Identificadores ─────────────────────────────────────────────────────────
const identificadores = [];

function apunta(base, kind, valor, namespaceKind, namespaceKey) {
  if (!valor || !String(valor).trim()) return;
  identificadores.push({
    ...base,
    identifier_kind: kind,
    observed_value: String(valor).trim(),
    normalized_value: normaliza(valor) || String(valor).trim().toUpperCase(),
    namespace_kind: namespaceKind,
    namespace_key: namespaceKey
  });
}

for (const rp of refProductos) {
  const visto = cuandoSeVio(rp.primary_source_record_id, rp.first_seen_at);
  const base = {
    reference_product_id: rp.id, reference_variant_id: null,
    source_id: rp.primary_source_id, source_record_id: rp.primary_source_record_id,
    first_seen_run_id: rp.first_seen_run_id, last_seen_run_id: rp.last_seen_run_id,
    first_seen_at: visto, last_seen_at: cuandoSeVio(rp.primary_source_record_id, rp.last_seen_at)
  };
  const fuente = fuentePorId.get(rp.primary_source_id);
  // El id interno y el handle pertenecen a la TIENDA, no a la marca: el mismo
  // producto en dos tiendas tendrá dos, y ninguno es más cierto que el otro.
  apunta(base, "external_id", rp.primary_external_id, "SOURCE", fuente?.source_key ?? "DESCONOCIDA");
  apunta(base, "handle", rp.metadata?.handle, "SOURCE", fuente?.source_key ?? "DESCONOCIDA");
  apunta(base, "source_url", rp.source_url, "SOURCE", fuente?.source_key ?? "DESCONOCIDA");

  // El código que la fuente escribe dentro del nombre o la descripción, cuando
  // publica productos sin variantes. `SH-496` es el mismo código que Bellaroshé
  // guarda como código de proveedor, y sin registrarlo aquí la reconciliación no
  // tiene por dónde entrar: 680 fichas REVEL quedaron sin resolver una sola.
  //
  // Va al namespace del SISTEMA, no de la tienda: `SH-*` cruza categorías y
  // marcas, y CHINO PUNO nos vende códigos del mismo sistema que REVEL.
  const codigo = rp.metadata?.codigoObservado;
  if (codigo) {
    const sistema = (String(codigo).match(/^([A-Za-z]{1,5})/) ?? [])[1]?.toUpperCase();
    apunta(base, "sku", codigo, sistema ? "CODE_SYSTEM" : "SOURCE",
      sistema ?? (fuente?.source_key ?? "DESCONOCIDA"));
  }
}

for (const rv of refVariantes) {
  const rp = refProdPorId.get(rv.reference_product_id);
  const visto = cuandoSeVio(rv.primary_source_record_id, rv.first_seen_at);
  const base = {
    reference_product_id: null, reference_variant_id: rv.id,
    source_id: rv.primary_source_id, source_record_id: rv.primary_source_record_id,
    first_seen_run_id: rv.first_seen_run_id, last_seen_run_id: rv.last_seen_run_id,
    first_seen_at: visto, last_seen_at: cuandoSeVio(rv.primary_source_record_id, rv.last_seen_at)
  };
  const fuente = fuentePorId.get(rv.primary_source_id);
  const marca = marcaPorId.get(rp?.brand_id) ?? "DESCONOCIDA";

  apunta(base, "external_id", rv.primary_external_id, "SOURCE", fuente?.source_key ?? "DESCONOCIDA");
  // El SKU lo emite el fabricante: su namespace es la marca, no la tienda.
  apunta(base, "sku", rv.sku, "BRAND", marca);
  // El código de barras es global. Ponerle la tienda como namespace haría que
  // el mismo EAN visto en dos sitios pareciera dos códigos distintos.
  apunta(base, "barcode", rv.barcode, "GLOBAL_GS1", "GS1");
}

// ── Precios: observaciones, no estado ───────────────────────────────────────
const precios = [];
for (const rv of refVariantes) {
  const importe = rv.metadata?.precioObservado;
  if (importe == null) continue;
  const observadoEn = cuandoSeVio(rv.primary_source_record_id, rv.last_seen_at);

  // La clave incluye instante Y precio. Mismo instante y mismo precio → misma
  // clave → rerun cero. Precio distinto en el mismo instante sería una
  // corrección de la fuente, y merece fila propia porque también es un hecho.
  precios.push({
    price_key: `${rv.id}:${sha(`${rv.primary_source_record_id}|${importe}|${observadoEn}`)}`,
    research_run_id: rv.last_seen_run_id,
    reference_product_id: null,
    reference_variant_id: rv.id,
    source_id: rv.primary_source_id,
    source_record_id: rv.primary_source_record_id,
    // Moneda de la tienda de origen, sin convertir: un tipo de cambio inventado
    // aquí contaminaría toda comparación posterior.
    currency: rv.metadata?.moneda ?? "PEN",
    amount: importe,
    presentation: rv.presentation ?? null,
    external_availability: rv.metadata?.disponibleEnFuente === true ? "available"
      : rv.metadata?.disponibleEnFuente === false ? "out_of_stock" : null,
    observed_at: observadoEn,
    content_fingerprint: sha(`${importe}|${rv.metadata?.precioListaObservado ?? ""}|${rv.metadata?.disponibleEnFuente}`),
    metadata: {
      precioListaObservado: rv.metadata?.precioListaObservado ?? null,
      origen: "backfill-desde-metadata-de-promocion"
    }
  });
}

const instantes = new Set(precios.map((p) => p.observed_at));

console.log(`Identificadores de referencia: ${identificadores.length}`);
const porKind = new Map();
for (const i of identificadores) porKind.set(`${i.identifier_kind} · ${i.namespace_kind}`, (porKind.get(`${i.identifier_kind} · ${i.namespace_kind}`) ?? 0) + 1);
for (const [k, n] of [...porKind].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(6)}  ${k}`);

console.log(`\nObservaciones de precio: ${precios.length}`);
console.log(`   instantes de observación distintos: ${instantes.size}`);
for (const i of [...instantes].sort()) console.log(`      ${i}`);
console.log(`   (una sola captura: la serie empieza aquí y crece con el próximo rastreo)`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`);
  process.exit(0);
}

async function enLotes(tabla, filas, conflicto, tam = 500) {
  let escritas = 0;
  for (let i = 0; i < filas.length; i += tam) {
    const lote = filas.slice(i, i + tam);
    const { error } = conflicto
      ? await db.from(tabla).upsert(lote, { onConflict: conflicto, ignoreDuplicates: true })
      : await db.from(tabla).insert(lote);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    escritas += lote.length;
    if (escritas % 4000 === 0 || escritas === filas.length) console.log(`   ${tabla}: ${escritas}/${filas.length}`);
  }
}

const antesId = (await db.from("catalog_reference_identifiers").select("*", { count: "exact", head: true })).count ?? 0;
const antesPx = (await db.from("catalog_reference_prices").select("*", { count: "exact", head: true })).count ?? 0;

await enLotes("catalog_reference_identifiers", identificadores,
  "target_ref,identifier_kind,normalized_value");
await enLotes("catalog_reference_prices", precios, "price_key");

// ── Presencia ───────────────────────────────────────────────────────────────
// El evento necesita una corrida-por-fuente, y esa tabla estaba vacía. Se crea
// una por fuente con la fecha real de su captura, no con la de hoy.
const porFuente = new Map();
for (const rp of refProductos) {
  if (!porFuente.has(rp.primary_source_id)) porFuente.set(rp.primary_source_id, []);
  porFuente.get(rp.primary_source_id).push(rp);
}

const { data: corrida } = await db.from("catalog_research_runs")
  .select("id").eq("actor_label", "promover-universo-referencia.mjs").limit(1).maybeSingle();

let eventos = 0, corridasFuente = 0;
if (corrida) {
  for (const [sourceId, productos] of porFuente) {
    const cuando = cuandoSeVio(productos[0].primary_source_record_id, productos[0].first_seen_at);
    const { data: rs, error: errRs } = await db.from("catalog_research_run_sources").upsert({
      research_run_id: corrida.id,
      source_id: sourceId,
      brand_id: fuentePorId.get(sourceId)?.brand_id ?? productos[0].brand_id,
      scope_key: `backfill:${fuentePorId.get(sourceId)?.source_key ?? sourceId}`,
      status: "succeeded",
      input_fingerprint: sha(`${sourceId}|${productos.length}`),
      started_at: cuando,
      finished_at: cuando,
      metrics: { productos: productos.length }
    }, { onConflict: "research_run_id,source_id,scope_key" }).select("id").single();
    if (errRs) { console.error(`   run_source ${sourceId}: ${errRs.message}`); continue; }
    corridasFuente += 1;

    const variantesDeFuente = refVariantes.filter((rv) => rv.primary_source_id === sourceId);
    const lote = [
      ...productos.map((rp) => ({
        research_run_source_id: rs.id, reference_product_id: rp.id, reference_variant_id: null,
        source_record_id: rp.primary_source_record_id,
        delta_status: "first_seen", current_fingerprint: rp.content_fingerprint,
        observed_at: cuandoSeVio(rp.primary_source_record_id, rp.first_seen_at),
        metadata: { origen: "backfill" }
      })),
      ...variantesDeFuente.map((rv) => ({
        research_run_source_id: rs.id, reference_product_id: null, reference_variant_id: rv.id,
        source_record_id: rv.primary_source_record_id,
        delta_status: "first_seen", current_fingerprint: rv.content_fingerprint,
        observed_at: cuandoSeVio(rv.primary_source_record_id, rv.first_seen_at),
        metadata: { origen: "backfill" }
      }))
    ];
    // La unicidad (research_run_source_id, target_ref) ya la impone el esquema:
    // una corrida no puede observar dos veces lo mismo. Se declara ignoreDuplicates
    // para que el segundo backfill sea silenciosamente limpio en vez de reventar —
    // «delta 0 porque está protegido» y «delta 0 porque falló» se leen igual en el
    // recuento y significan cosas opuestas.
    for (let i = 0; i < lote.length; i += 500) {
      const trozo = lote.slice(i, i + 500);
      const { data: escritos, error } = await db
        .from("catalog_reference_presence_events")
        .upsert(trozo, { onConflict: "research_run_source_id,target_ref", ignoreDuplicates: true })
        .select("id");
      if (error) { console.error(`   eventos: ${error.message}`); break; }
      eventos += escritos?.length ?? 0;
    }
  }
}

const despuesId = (await db.from("catalog_reference_identifiers").select("*", { count: "exact", head: true })).count ?? 0;
const despuesPx = (await db.from("catalog_reference_prices").select("*", { count: "exact", head: true })).count ?? 0;

console.log(`\ncatalog_reference_identifiers: ${antesId} → ${despuesId}  (delta ${despuesId - antesId})`);
console.log(`catalog_reference_prices:      ${antesPx} → ${despuesPx}  (delta ${despuesPx - antesPx})`);
console.log(`catalog_research_run_sources:  ${corridasFuente}`);
console.log(`catalog_reference_presence_events: ${eventos}`);
