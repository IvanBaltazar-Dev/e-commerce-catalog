/**
 * Pasada exclusivamente sobre huecos que todavía se pueden resolver.
 *
 * Antes de pedir nada a internet se separa lo que falta de verdad de lo que ya
 * teníamos y no circulaba. Esa distinción es la que evita gastar peticiones en
 * datos que están en la base:
 *
 *   RESOLUBLE EN INTERNET
 *     Cherimoya publica sus variaciones como productos consultables
 *     (?type=variation) y ahí SÍ traen SKU, precio propio e imagen. El listado de
 *     productos padre solo devolvía id y atributos, así que teníamos 231
 *     variaciones sin código, sin precio y sin foto. La API declara 281: hay 50
 *     que ni siquiera habíamos visto.
 *
 *   YA CAPTURADO, SIN CIRCULAR
 *     2.104 variantes Shopify traen su propia URL de imagen en el registro de
 *     fuente y ninguna llegó a catalog_reference_media como imagen de variante.
 *
 *   NO RESOLUBLE POR ESTA VÍA
 *     De esas 2.104, solo 110 son distintas de la foto del producto padre. En las
 *     cuatro tiendas que modelan cada tono como producto suelto, la imagen de la
 *     variante ES la del producto. El swatch por tono no existe en la fuente, y
 *     ninguna cantidad de peticiones lo va a crear.
 *
 *   node --experimental-transform-types scripts/pasada-huecos.mjs [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const UA = "BellarosheCatalogResearch/1.0 (+local-read-only)";
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── Hueco 1 · las variaciones de Cherimoya, con su ficha completa ───────────
const { data: fuente } = await db.from("catalog_sources")
  .select("id, source_key, base_url, metadata").eq("source_key", "cherimoya-pe-official").single();
const { data: snap } = await db.from("catalog_source_snapshots")
  .select("id").eq("source_id", fuente.id)
  .eq("metadata->>via", "woocommerce_store_api").order("created_at", { ascending: false }).limit(1).single();

console.log(`Hueco 1 · variaciones de Cherimoya con ficha completa`);
const variaciones = [];
let declarado = null;
for (let pagina = 1; ; pagina += 1) {
  const url = `${fuente.base_url}/wp-json/wc/store/v1/products?type=variation&per_page=100&page=${pagina}`;
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) { console.log(`  página ${pagina} → ${r.status}`); break; }
  if (declarado === null) declarado = Number(r.headers.get("x-wp-total"));
  const lote = await r.json();
  variaciones.push(...lote);
  if (lote.length < 100) break;
  await espera(500);
}
console.log(`  declaradas por la API: ${declarado} · capturadas: ${variaciones.length}`);
console.log(`  con SKU ${variaciones.filter((v) => v.sku).length} · con precio ${variaciones.filter((v) => v.prices?.price != null).length} · con imagen ${variaciones.filter((v) => (v.images ?? []).length).length}`);

const yaTeniamos = await leerTodo({
  consulta: () => db.from("catalog_source_records").select("id, external_id")
    .eq("snapshot_id", snap.id).eq("entity_type", "variant"),
  orden: ["id"], clave: (r) => r.external_id, nombre: "variaciones ya capturadas",
});
const conocidas = new Set(yaTeniamos.map((r) => r.external_id));
const nuevas = variaciones.filter((v) => !conocidas.has(`woo-variation:${v.id}`));
console.log(`  ya conocidas ${variaciones.length - nuevas.length} · NUEVAS ${nuevas.length}`);

// ── Hueco 2 · las imágenes de variante que ya teníamos ──────────────────────
console.log(`\nHueco 2 · imágenes propias de variante, ya capturadas`);
const vigentes = await leerTodo({
  consulta: () => db.from("catalog_source_snapshots").select("id, source_id").order("created_at"),
  orden: ["id"], clave: (r) => r.id, nombre: "snapshots",
});
const snapVigente = new Map();
for (const s of vigentes) snapVigente.set(s.source_id, s.id);

const regsVariante = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, source_id, snapshot_id, entity_type, external_id, external_parent_id, primary_image_url")
    .eq("entity_type", "variant").not("primary_image_url", "is", null),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes con imagen",
});
const regsProducto = await leerTodo({
  consulta: () => db.from("catalog_source_records")
    .select("id, source_id, snapshot_id, external_id, primary_image_url").eq("entity_type", "product"),
  orden: ["id"], clave: (r) => r.id, nombre: "productos",
});
const imagenPadre = new Map(regsProducto.map((r) => [`${r.snapshot_id}|${r.external_id}`, r.primary_image_url]));

const refVariantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, primary_source_record_id, primary_source_id"),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes vigentes",
});
const refPorRegistro = new Map(refVariantes.map((r) => [r.primary_source_record_id, r]));

const mediosNuevos = [];
let heredadas = 0;
for (const r of regsVariante) {
  if (snapVigente.get(r.source_id) !== r.snapshot_id) continue;
  const ref = refPorRegistro.get(r.id);
  if (!ref) continue;
  const padre = imagenPadre.get(`${r.snapshot_id}|${r.external_parent_id}`);
  // Solo la que de verdad es de la variante. Registrar la del padre como si fuera
  // suya haría creer que hay swatch por tono donde solo hay una foto repetida.
  if (padre && padre === r.primary_image_url) { heredadas += 1; continue; }
  mediosNuevos.push({
    media_key: `variant-media-v1:${ref.id}:${sha(r.primary_image_url).slice(0, 16)}`,
    reference_product_id: null,
    reference_variant_id: ref.id,
    source_id: r.source_id,
    source_record_id: r.id,
    media_kind: "image",
    remote_url: r.primary_image_url,
    validation_status: "remote_reference",
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    metadata: { alcance: "variante", nota: "distinta de la imagen del producto padre" },
  });
}
console.log(`  variantes con imagen propia distinta: ${mediosNuevos.length}`);
console.log(`  descartadas por ser la del padre:     ${heredadas}`);

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

// ── Escribir ────────────────────────────────────────────────────────────────
const ahora = new Date().toISOString();
const registros = variaciones.map((v) => ({
  snapshot_id: snap.id, source_id: fuente.id, entity_type: "variant",
  external_id: `woo-variation:${v.id}`, external_parent_id: `woo-product:${v.parent}`,
  title: `${v.name}${v.variation ? ` · ${v.variation}` : ""}`,
  sku: v.sku || null,
  source_url: v.permalink ?? null,
  primary_image_url: v.images?.[0]?.src ?? null,
  captured_at: ahora,
  payload: {
    id: v.id, parent: v.parent, name: v.name, variation: v.variation,
    sku: v.sku, permalink: v.permalink,
    attributes: (v.attributes ?? []).map((a) => ({ name: a.name, value: (a.terms ?? [])[0]?.name ?? null })),
    images: (v.images ?? []).map((i) => i.src),
    precio: v.prices?.price != null ? Number(v.prices.price) / 10 ** Number(v.prices.currency_minor_unit ?? 0) : null,
    moneda: v.prices?.currency_code ?? null,
    precio_crudo: v.prices?.price ?? null,
    escala_moneda: v.prices?.currency_minor_unit ?? null,
    is_in_stock: v.is_in_stock,
    source_type: "woocommerce_store_api", contrato: "woo-v2-variaciones",
  },
}));
for (let i = 0; i < registros.length; i += 100) {
  const { error } = await db.from("catalog_source_records")
    .upsert(registros.slice(i, i + 100), { onConflict: "snapshot_id,entity_type,external_id" });
  if (error) throw new Error(`registros: ${error.message}`);
}
console.log(`\n  registros de variación escritos: ${registros.length}`);

// Los medios exigen run: es una puesta en circulación, no una captura.
const { data: runMedio, error: eRunMedio } = await db.from("catalog_research_runs").insert({
  run_key: `pasada-huecos-medios:${snap.id}`,
  run_kind: "targeted", actor_kind: "system", actor_label: "pasada-huecos",
  input_fingerprint: sha({ medios: mediosNuevos.length }),
  scope: { proposito: "imagenes de variante realmente distintas de la del padre" },
}).select("id").single();
if (eRunMedio && !/duplicate|unique/i.test(eRunMedio.message)) throw new Error(`run: ${eRunMedio.message}`);
const runMedioId = runMedio?.id ?? (await db.from("catalog_research_runs").select("id")
  .eq("run_key", `pasada-huecos-medios:${snap.id}`).single()).data.id;
for (const m of mediosNuevos) { m.first_seen_run_id = runMedioId; m.last_seen_run_id = runMedioId; }

for (let i = 0; i < mediosNuevos.length; i += 100) {
  const { error } = await db.from("catalog_reference_media")
    .upsert(mediosNuevos.slice(i, i + 100), { onConflict: "target_ref,remote_url", ignoreDuplicates: true });
  if (error) throw new Error(`medios: ${error.message}`);
}
console.log(`  imágenes de variante puestas en circulación: ${mediosNuevos.length}`);
console.log(`\nAhora hay que rematerializar las variantes de Cherimoya para que recojan SKU e imagen.`);
