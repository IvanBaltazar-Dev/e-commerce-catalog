/**
 * Campaña WooCommerce genérica. Cherimoya es su primera corrida, no su motivo.
 *
 * El orden es deliberado y no se puede alterar: primero se captura lo que la
 * plataforma publica, LITERAL; después se traduce al vocabulario canónico; y lo
 * que no tenga traducción se reporta como UNMAPPED en vez de inventarle una.
 *
 * La prioridad entre fuentes de un mismo dato también es fija: si «Tonos» viene
 * como atributo estructurado, ese es el tono. Solo se mira el título cuando el
 * dato estructurado falta — nunca al revés.
 *
 *   node --experimental-transform-types scripts/campana-woocommerce.mjs <source-key> [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { descubrirCatalogoWooCommerce, precioReal, atributosLiterales } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/catalog-intelligence/woocommerce-store-adapter.mjs")).href
);

const APLICAR = process.argv.includes("--aplicar");
const CLAVE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "cherimoya-pe-official";
const UA = "BellarosheCatalogResearch/1.0 (+local-read-only)";
const CONTRATO = "woo-v1";
const sha = (s) => crypto.createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex");

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/**
 * ATRIBUTO → DIMENSIÓN CANÓNICA · regla ATRIBUTOS_WOO_ES v1
 *
 * Es una regla de normalización con versión, no conocimiento de marca: mapea
 * nombres de atributo en español a dimensiones registradas, y sirve para
 * cualquier tienda WooCommerce en español. Cherimoya no aparece por ningún lado.
 *
 * La comparación es sobre el nombre en minúsculas y sin acentos, porque la misma
 * tienda escribe «CONTENIDO» y «Contenido», «COLOR» y «Color». Eso es una
 * normalización determinista, no una interpretación.
 *
 * Lo que no esté aquí NO se fuerza: sale como UNMAPPED_SOURCE_FIELD y se decide
 * después, con la lista de nombres reales delante.
 */
const REGLA_ATRIBUTOS = "ATRIBUTOS_WOO_ES";
const REGLA_ATRIBUTOS_VERSION = 1;
const ATRIBUTO_A_DIMENSION = {
  "tonos": "subtype", "tono": "subtype", "color": "subtype", "colores": "subtype",
  "contenido": "packaging", "tamano": "packaging", "medidas": "dimensions",
  "peso": "dimensions", "cantidad": "packaging",
  "aroma": "benefit", "tipo": "type", "tipo de piel": "concern",
  "material": "composition", "acabado": "finish",
};
const normalizarNombre = (s) => String(s ?? "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const { data: fuente, error: eF } = await db.from("catalog_sources")
  .select("id, source_key, base_url, adapter, authority, metadata").eq("source_key", CLAVE).single();
if (eF) throw new Error(`fuente ${CLAVE}: ${eF.message}`);
if (fuente.adapter !== "woocommerce_store_api") {
  throw new Error(`${CLAVE} usa el adaptador ${fuente.adapter}; esta campaña es para woocommerce_store_api.`);
}

console.log(`${CLAVE} · ${fuente.base_url}`);
console.log(`  capturando por Store API…`);
const captura = await descubrirCatalogoWooCommerce({
  raiz: fuente.base_url, ua: UA,
  alProgresar: ({ pagina, productos, declarado }) => console.log(`   página ${pagina} · ${productos}/${declarado}`),
});

console.log(`\n  declarado por la API (X-WP-Total): ${captura.declarado}`);
console.log(`  capturado:                         ${captura.productos.length}`);
if (captura.paginasFallidas.length) console.log(`  páginas fallidas: ${captura.paginasFallidas.length}`);
const r = captura.resumen;
console.log(`  simples ${r.simples} · variables ${r.variables} · otros ${r.otros}`);
console.log(`  con atributos ${r.conAtributos} · con variaciones ${r.conVariaciones} (${r.variacionesTotales} variaciones)`);
console.log(`  con SKU ${r.conSku} · imágenes ${r.imagenes}`);
console.log(`  categorías distintas ${r.categoriasDistintas} · nombres de atributo distintos ${r.atributosDistintos}`);

// ── Traducción a canónico ───────────────────────────────────────────────────
const observaciones = [];
const sinMapear = new Map();
const atributosVistos = new Map();

function anotar(sujeto, predicado, valor, extra = {}) {
  if (valor === null || valor === undefined || valor === "") return;
  observaciones.push({ sujeto, predicado, valor, ...extra });
}

for (const p of captura.productos) {
  const s = { tipo: "product", id: p.id };

  // Literales: lo que la plataforma publica en su propio campo.
  anotar(s, "identity.source_external_id", String(p.id), { dimension: "identity", clase: "OBSERVATION_LITERAL", campo: "woocommerce.id" });
  anotar(s, "identity.name", p.name, { dimension: "identity", clase: "OBSERVATION_LITERAL", campo: "woocommerce.name" });
  anotar(s, "identity.manufacturer_sku", p.sku, { dimension: "identity", clase: "OBSERVATION_LITERAL", campo: "woocommerce.sku" });
  for (const img of p.images ?? []) {
    anotar(s, "media.image", img.src, { dimension: "media", clase: "OBSERVATION_LITERAL", campo: "woocommerce.images" });
  }
  // La categoría más específica es la última de la cadena que devuelve la API.
  for (const c of p.categories ?? []) {
    anotar(s, "semantic.type", c.name, { dimension: "type", clase: "OBSERVATION_LITERAL", campo: "woocommerce.categories", categoriaId: c.id });
  }
  if (p.brands?.length) {
    for (const b of p.brands) anotar(s, "identity.brand_declared", b.name, { dimension: "identity", clase: "OBSERVATION_LITERAL", campo: "woocommerce.brands" });
  }

  // Atributos estructurados: MANDAN sobre cualquier lectura del título.
  for (const a of atributosLiterales(p)) {
    const clave = normalizarNombre(a.nombre);
    atributosVistos.set(clave, (atributosVistos.get(clave) ?? 0) + 1);
    const dimension = ATRIBUTO_A_DIMENSION[clave];
    if (!dimension) {
      sinMapear.set(a.nombre, (sinMapear.get(a.nombre) ?? 0) + 1);
      continue;
    }
    for (const t of a.terminos) {
      anotar(s, `semantic.${dimension}`, t.nombre, {
        dimension, campo: `woocommerce.attributes:${a.nombre}`,
        // El valor es literal de la fuente; lo normalizado es a QUÉ dimensión
        // pertenece, y eso lo decide una regla nuestra con versión.
        clase: "NORMALIZED_SOURCE_CLAIM",
        regla: REGLA_ATRIBUTOS, reglaVersion: REGLA_ATRIBUTOS_VERSION,
        derivadoDe: { campo: "attributes", nombreOriginal: a.nombre, valor: t.nombre },
      });
    }
  }

  // Las variaciones son sujetos aparte. Nunca productos.
  for (const v of p.variations ?? []) {
    const sv = { tipo: "variant", id: v.id, padre: p.id };
    anotar(sv, "identity.source_external_id", String(v.id), { dimension: "identity", clase: "OBSERVATION_LITERAL", campo: "woocommerce.variations" });
    for (const a of v.attributes ?? []) {
      const dimension = ATRIBUTO_A_DIMENSION[normalizarNombre(a.name)];
      if (!dimension) { sinMapear.set(a.name, (sinMapear.get(a.name) ?? 0) + 1); continue; }
      anotar(sv, `semantic.${dimension}`, a.value, {
        dimension, campo: `woocommerce.variations:${a.name}`, clase: "NORMALIZED_SOURCE_CLAIM",
        regla: REGLA_ATRIBUTOS, reglaVersion: REGLA_ATRIBUTOS_VERSION,
        derivadoDe: { campo: "variations.attributes", nombreOriginal: a.name, valor: a.value },
      });
    }
  }
}

const precios = captura.productos
  .map((p) => ({ id: p.id, ...(precioReal(p.prices) ?? {}) }))
  .filter((x) => x.importe !== undefined && x.importe !== null);

const porClase = {};
for (const o of observaciones) porClase[o.clase] = (porClase[o.clase] ?? 0) + 1;

console.log(`\n  observaciones: ${observaciones.length}`);
for (const [k, v] of Object.entries(porClase)) console.log(`     ${String(v).padStart(6)}  ${k}`);
console.log(`  precios con escala corregida: ${precios.length}`);
if (precios.length) {
  const imp = precios.map((x) => x.importe);
  console.log(`     rango ${Math.min(...imp).toFixed(2)} – ${Math.max(...imp).toFixed(2)} ${precios[0].moneda} (crudo ${precios[0].crudo}, escala 10^${precios[0].escala})`);
}
console.log(`\n  nombres de atributo sin mapear: ${sinMapear.size}`);
for (const [n, c] of [...sinMapear].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`     ${String(c).padStart(4)}  ${n}`);
}

const salida = {
  fuente: CLAVE, contrato: CONTRATO, capturadoEn: captura.capturadoEn,
  declarado: captura.declarado, capturado: captura.productos.length,
  resumen: captura.resumen, porClase, precios: precios.length,
  reglaAtributos: `${REGLA_ATRIBUTOS} v${REGLA_ATRIBUTOS_VERSION}`,
  atributosSinMapear: Object.fromEntries(sinMapear),
  atributosVistos: Object.fromEntries(atributosVistos),
  paginasFallidas: captura.paginasFallidas,
};
fs.writeFileSync(path.join(ROOT, "outputs", `campana-woo-${CLAVE}.json`), JSON.stringify(salida, null, 2), "utf8");
console.log(`\n→ outputs/campana-woo-${CLAVE}.json`);

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

// ── Persistencia ────────────────────────────────────────────────────────────
const { data: snap, error: eS } = await db.from("catalog_source_snapshots").insert({
  source_id: fuente.id, status: "succeeded",
  started_at: captura.capturadoEn, completed_at: new Date().toISOString(),
  http_status: 200, content_hash: sha(captura.productos.map((p) => p.id).sort().join("|")),
  product_count: captura.productos.length,
  variant_count: captura.resumen.variacionesTotales,
  image_count: captura.resumen.imagenes,
  metadata: {
    via: "woocommerce_store_api", contrato: CONTRATO,
    declared_total: captura.declarado, items_captured: captura.productos.length,
    regla_atributos: `${REGLA_ATRIBUTOS} v${REGLA_ATRIBUTOS_VERSION}`,
    atributos_sin_mapear: [...sinMapear.keys()],
  },
}).select("id").single();
// Una captura idéntica reutiliza su snapshot en vez de crear otro. La huella es
// del contenido, así que si coincide es literalmente la misma captura — y una
// corrida que falló más adelante no debe dejar un snapshot huérfano que bloquee
// el reintento.
let snapshotId = snap?.id ?? null;
if (eS) {
  if (!/duplicate|unique/i.test(eS.message)) throw new Error(`snapshot: ${eS.message}`);
  const huella = sha(captura.productos.map((p) => p.id).sort().join("|"));
  const { data: previo } = await db.from("catalog_source_snapshots")
    .select("id").eq("source_id", fuente.id).eq("content_hash", huella).maybeSingle();
  snapshotId = previo?.id ?? null;
  if (!snapshotId) throw new Error(`snapshot: ${eS.message}`);
  console.log(`  captura idéntica a una anterior: se reutiliza su snapshot`);
}

const registros = [];
for (const p of captura.productos) {
  const pr = precioReal(p.prices);
  registros.push({
    snapshot_id: snapshotId, source_id: fuente.id, entity_type: "product",
    external_id: `woo-product:${p.id}`, title: p.name ?? null, sku: p.sku || null,
    source_url: p.permalink ?? null, primary_image_url: p.images?.[0]?.src ?? null,
    captured_at: captura.capturadoEn,
    payload: {
      id: p.id, name: p.name, slug: p.slug, type: p.type, parent: p.parent,
      permalink: p.permalink, sku: p.sku,
      short_description: p.short_description, description: p.description,
      categories: p.categories, tags: p.tags, brands: p.brands,
      attributes: atributosLiterales(p),
      variations: p.variations,
      images: (p.images ?? []).map((i) => i.src),
      // El precio, con su escala resuelta y el crudo al lado para poder rehacerlo.
      precio: pr?.importe ?? null, moneda: pr?.moneda ?? null,
      precio_crudo: pr?.crudo ?? null, escala_moneda: pr?.escala ?? null,
      is_in_stock: p.is_in_stock, stock_availability: p.stock_availability,
      source_type: "woocommerce_store_api", contrato: CONTRATO,
    },
  });
  for (const v of p.variations ?? []) {
    registros.push({
      snapshot_id: snapshotId, source_id: fuente.id, entity_type: "variant",
      external_id: `woo-variation:${v.id}`, external_parent_id: `woo-product:${p.id}`,
      title: p.name ?? null,
      // La variación tiene URL propia: es la del producto con su variation_id.
      // No es un relleno para satisfacer un NOT NULL, es dónde está publicada.
      source_url: p.permalink ? `${p.permalink}?variation_id=${v.id}` : null,
      captured_at: captura.capturadoEn,
      payload: { id: v.id, parent: p.id, attributes: v.attributes, source_type: "woocommerce_store_api", contrato: CONTRATO },
    });
  }
  for (const [i, img] of (p.images ?? []).entries()) {
    registros.push({
      snapshot_id: snapshotId, source_id: fuente.id, entity_type: "image",
      // El id de media en WordPress es GLOBAL: la misma imagen reutilizada en dos
      // productos daría el mismo external_id y una sobrescribiría a la otra. El
      // registro es del producto, así que la llave lleva el producto dentro.
      external_id: `woo-image:${p.id}:${img.id ?? sha(img.src).slice(0, 16)}`,
      external_parent_id: `woo-product:${p.id}`,
      // title es NOT NULL. Una imagen no tiene título propio en la Store API, así
      // que hereda el del producto con su posición: identifica la fila sin
      // inventarle un nombre que la fuente no da.
      title: `${p.name ?? "(sin nombre)"} · imagen ${i + 1}`,
      source_url: img.src,
      primary_image_url: img.src, captured_at: captura.capturadoEn,
      payload: { src: img.src, alt: img.alt ?? null, posicion: i + 1, source_type: "woocommerce_store_api" },
    });
  }
}

// Lotes pequeños, por lo mismo que en la campaña Shopify: hay triggers que
// trabajan fila a fila y un lote grande agota el tiempo de la petición.
// Deduplicar antes de escribir. Un ON CONFLICT no puede tocar la misma fila dos
// veces en la misma sentencia, y con llaves derivadas de la fuente conviene
// comprobarlo aquí en vez de descubrirlo por el error de Postgres.
const porLlave = new Map();
for (const reg of registros) porLlave.set(`${reg.entity_type}:${reg.external_id}`, reg);
if (porLlave.size !== registros.length) {
  console.log(`  ${registros.length - porLlave.size} registros con llave repetida: se conserva uno de cada`);
}
const unicos = [...porLlave.values()];

let escritos = 0;
for (let i = 0; i < unicos.length; i += 200) {
  const { error } = await db.from("catalog_source_records")
    .upsert(unicos.slice(i, i + 200), { onConflict: "snapshot_id,entity_type,external_id" });
  if (error) throw new Error(`catalog_source_records: ${error.message}`);
  escritos += Math.min(200, unicos.length - i);
}
console.log(`\n  registros escritos: ${escritos}`);

// ── Libro mayor y cierre ────────────────────────────────────────────────────
const libro = captura.productos.map((p) => ({
  snapshot_id: snapshotId, source_id: fuente.id,
  url: p.permalink, url_sha256: sha(p.permalink),
  outcome: "CAPTURED", http_status: 200, attempts: 1,
  first_attempt_at: captura.capturadoEn, last_attempt_at: new Date().toISOString(),
  artifact_sha256: sha(p.permalink), artifact_bytes: null,
  metadata: { via: "store_api", tipo: p.type, variaciones: (p.variations ?? []).length },
}));
for (const f of captura.paginasFallidas) {
  const u = `${fuente.base_url}/wp-json/wc/store/v1/products?page=${f.pagina}`;
  libro.push({
    snapshot_id: snapshotId, source_id: fuente.id, url: u, url_sha256: sha(u),
    outcome: f.clase, http_status: Number.isFinite(f.status) ? f.status : null,
    error_class: `HTTP_${f.status}`, attempts: 4,
    first_attempt_at: captura.capturadoEn, last_attempt_at: new Date().toISOString(),
    metadata: { pagina: f.pagina },
  });
}
for (let i = 0; i < libro.length; i += 400) {
  const { error } = await db.from("capture_url_ledger")
    .upsert(libro.slice(i, i + 400), { onConflict: "snapshot_id,url_sha256" });
  if (error) throw new Error(`capture_url_ledger: ${error.message}`);
}

const { data: auditoria } = await db.from("capture_closure_audit_v1").select("*").eq("snapshot_id", snapshotId).single();
console.log(`\n  descubiertas ${auditoria.descubiertas} = intentadas ${auditoria.intentadas}`);
console.log(`  capturadas ${auditoria.capturadas} + ausencias ${auditoria.ausencias} + permanentes ${auditoria.permanentes} + pendientes ${auditoria.pendientes}`);
console.log(`  CIERRE: ${auditoria.puede_declararse_completa ? "COMPLETE" : "INCOMPLETE_CAPTURE"} — ${auditoria.motivo}`);

// ── Verificación de lectura masiva sobre lo que acabamos de escribir ────────
const releidos = await leerTodo({
  consulta: () => db.from("catalog_source_records").select("id, external_id").eq("snapshot_id", snapshotId),
  orden: ["id"], clave: (f) => f.external_id, nombre: "registros de la campaña",
});
console.log(`\n  relectura verificada: ${releidos.length} filas = ${new Set(releidos.map((x) => x.external_id)).size} identidades`);
console.log(`\nsnapshot ${snap.id}`);
