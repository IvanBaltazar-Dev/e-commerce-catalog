/**
 * Fase 2 · Convertir el rastreo en conocimiento reutilizable.
 *
 * El rastreo YA está hecho y YA está en la base: catalog_source_records guarda
 * 12.520 filas —3.298 productos, 3.406 variantes, 5.787 imágenes y 29
 * documentos— de seis catálogos oficiales. Pero catalog_reference_products
 * tiene 2 filas, y las dos son de un fixture de ACRYLOVE.
 *
 * O sea: la fuente se investigó una vez, como debe ser, y nunca se convirtió en
 * memoria. Cada vez que alguien pregunta «¿tenemos ficha de esto?», el sistema
 * contesta que no, teniendo la respuesta guardada en la capa de al lado.
 *
 * Ese es el paso que falta entre «rastrear» y «reconciliar»:
 *
 *   source_records   lo que la fuente dijo el día que se miró (crudo, inmutable)
 *          ↓                       ESTE SCRIPT
 *   reference_*      lo que sabemos del producto (identidad estable, versionable)
 *          ↓
 *   reconciliación   cruzar un lote nuevo contra lo anterior
 *
 * Dos huellas, porque responden a preguntas distintas:
 *
 *   identity_fingerprint   ¿es el mismo producto?  → marca + SKU o id externo
 *   content_fingerprint    ¿ha cambiado?           → el payload entero
 *
 * Con esa pareja, volver a rastrear dentro de tres meses no duplica nada:
 * reconoce lo que ya estaba, actualiza lo que cambió y marca como ausente lo que
 * la fuente dejó de publicar. Es lo que permite que el lote de 5.000 del mes que
 * viene cueste menos que el de 1.255 de hoy.
 *
 * Uso:
 *   node scripts/promover-universo-referencia.mjs             (ensayo)
 *   node scripts/promover-universo-referencia.mjs --aplicar
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

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
const norm = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const fuentes = await todas("catalog_sources", "id, source_key, name, brand_id, authority");
const fuentePorId = new Map(fuentes.map((f) => [f.id, f]));
const marcas = await todas("brands", "id, name");
const marcaPorNombre = new Map(marcas.map((b) => [norm(b.name), b.id]));

// Solo catálogos de marca. Los documentos —FDA, NIOSH, fichas de acrílico— son
// evidencia de otra naturaleza: no describen UN producto, y meterlos aquí
// ensuciaría el universo con filas que nunca van a reconciliar con nada.
const registros = await todas(
  "catalog_source_records",
  "id, source_id, entity_type, external_id, title, source_url, payload, captured_at",
  (q) => q.in("entity_type", ["product", "variant", "image"])
);

console.log(`Registros de rastreo: ${registros.length}`);

const porTipo = { product: [], variant: [], image: [] };
for (const r of registros) porTipo[r.entity_type].push(r);
console.log(`  productos ${porTipo.product.length} · variantes ${porTipo.variant.length} · imágenes ${porTipo.image.length}\n`);

// ── Marca: la del payload, no la del source ────────────────────────────────
// Una fuente puede publicar más de una marca. Fiarse del brand_id de la fuente
// haría que todo lo de mcnails.mx fuese «MC NAILS» aunque la ficha diga otra.
const marcasNoResueltas = new Map();
function resolverMarca(payload, fuente) {
  const delPayload = norm(payload?.brand ?? payload?.vendor ?? "");
  if (delPayload && marcaPorNombre.has(delPayload)) return marcaPorNombre.get(delPayload);
  if (fuente?.brand_id) return fuente.brand_id;
  if (delPayload) marcasNoResueltas.set(payload.brand ?? payload.vendor, (marcasNoResueltas.get(payload.brand ?? payload.vendor) ?? 0) + 1);
  return null;
}

// ── Productos ───────────────────────────────────────────────────────────────
const productos = [];
const sinMarca = [];

for (const r of porTipo.product) {
  const fuente = fuentePorId.get(r.source_id);
  const p = r.payload ?? {};
  const brandId = resolverMarca(p, fuente);
  if (!brandId) { sinMarca.push({ titulo: r.title, fuente: fuente?.source_key }); continue; }

  const externo = p.external_product_id ?? r.external_id;
  const clave = `${fuente.source_key}:${externo}`;

  productos.push({
    reference_key: clave,
    brand_id: brandId,
    primary_source_id: r.source_id,
    primary_source_record_id: r.id,
    primary_external_id: String(externo),
    name: r.title,
    normalized_name: norm(r.title) || r.title.toLowerCase(),
    family: p.product_type ?? null,
    product_type: p.product_type ?? null,
    line: (p.tags ?? "").split("|").map((t) => t.trim()).find((t) => /gel|tradicional|polish|evolution|advanced|bases|brillos/i.test(t)) ?? null,
    presentation: null,
    source_url: p.source_product_url ?? r.source_url,
    primary_image_url: /^https?:\/\//.test(p.primary_image_url ?? "") ? p.primary_image_url : null,
    // La identidad es marca + id externo: es lo que no cambia aunque la tienda
    // reescriba el título o cambie la foto.
    identity_fingerprint: sha(`${brandId}|${fuente.source_key}|${externo}`),
    // El contenido es todo lo demás. Si esto cambia entre dos rastreos, la ficha
    // se movió y hay que volver a mirarla; si no, se puede saltar.
    content_fingerprint: sha(JSON.stringify(p)),
    enrichment_level: (p.description ?? "").trim().length > 30 ? "REFERENCE_ENRICHED" : "REFERENCE_LIGHT",
    knowledge_status: "observed",
    presence_status: "present",
    first_seen_at: r.captured_at,
    last_seen_at: r.captured_at,
    metadata: {
      fuente: fuente.source_key,
      autoridad: fuente.authority,
      handle: p.handle ?? null,
      etiquetas: p.tags ?? null,
      descripcion: p.description ?? null,
      variantesEnFuente: p.variant_count ? Number(p.variant_count) : null,
      imagenesEnFuente: p.image_count ? Number(p.image_count) : null,
      publicadoEn: p.published_at ?? null,
      actualizadoEn: p.updated_at ?? null,
      confianza: p.confidence ?? null
    }
  });
}

const porExterno = new Map(productos.map((p) => [`${p.metadata.fuente}:${p.primary_external_id}`, p]));

// ── Variantes ───────────────────────────────────────────────────────────────
const variantes = [];
const variantesHuerfanas = [];

for (const r of porTipo.variant) {
  const fuente = fuentePorId.get(r.source_id);
  const p = r.payload ?? {};
  const padre = porExterno.get(`${fuente.source_key}:${p.external_product_id}`);
  if (!padre) { variantesHuerfanas.push({ titulo: r.title, fuente: fuente?.source_key }); continue; }

  const externo = p.external_variant_id ?? r.external_id;
  const nombre = p.variant_title && p.variant_title !== "Default Title" ? p.variant_title : (p.product_title ?? r.title);

  variantes.push({
    _padre: padre.reference_key,
    reference_key: `${fuente.source_key}:v:${externo}`,
    primary_source_id: r.source_id,
    primary_source_record_id: r.id,
    primary_external_id: String(externo),
    name: nombre,
    normalized_name: norm(nombre) || String(externo),
    // El SKU del fabricante es lo que de verdad identifica. Va también a la
    // huella: dos variantes con el mismo SKU son la misma aunque la tienda les
    // cambie el id interno al reindexar.
    sku: (p.sku ?? "").trim() || null,
    barcode: (p.barcode ?? "").trim() || null,
    shade_name: p.option1 && p.option1 !== "Default Title" ? p.option1 : null,
    presentation: p.option2 && p.option2 !== "Default Title" ? p.option2 : null,
    source_url: p.source_product_url ?? r.source_url,
    primary_image_url: null,
    identity_fingerprint: sha(`${padre.identity_fingerprint}|${(p.sku ?? "").trim() || externo}`),
    content_fingerprint: sha(JSON.stringify(p)),
    enrichment_level: p.sku ? "REFERENCE_ENRICHED" : "REFERENCE_LIGHT",
    knowledge_status: "observed",
    presence_status: p.available === "false" ? "missing_from_source" : "present",
    first_seen_at: r.captured_at,
    last_seen_at: r.captured_at,
    metadata: {
      fuente: fuente.source_key,
      // El precio observado NO es el precio Bellaroshé. Vive aquí, en la capa de
      // referencia, para poder enseñar «mercado observado» sin tocar el precio
      // de venta ni confundir las dos cosas.
      precioObservado: p.price ? Number(p.price) : null,
      precioListaObservado: p.compare_at_price ? Number(p.compare_at_price) : null,
      disponibleEnFuente: p.available === "true",
      opciones: [p.option1, p.option2, p.option3].filter((o) => o && o !== "Default Title"),
      confianza: p.confidence ?? null
    }
  });
}

// ── Imágenes ────────────────────────────────────────────────────────────────
const medios = [];
const mediosHuerfanos = [];

for (const r of porTipo.image) {
  const fuente = fuentePorId.get(r.source_id);
  const p = r.payload ?? {};
  const padre = porExterno.get(`${fuente.source_key}:${p.external_product_id}`);
  if (!padre) { mediosHuerfanos.push({ url: p.image_url, fuente: fuente?.source_key }); continue; }
  const url = p.image_url ?? r.source_url;
  if (!/^https?:\/\//.test(url ?? "")) continue;

  medios.push({
    _padre: padre.reference_key,
    media_key: `${fuente.source_key}:i:${sha(url)}`,
    source_id: r.source_id,
    source_record_id: r.id,
    media_kind: "image",
    remote_url: url,
    content_hash: null,
    mime_type: null,
    // Encontrar una URL no la convierte en imagen publicable. La validación de
    // derechos y de correspondencia es una decisión aparte, igual que en la
    // campaña multimedia: aquí solo se inventaría.
    validation_status: "remote_reference",
    first_seen_at: r.captured_at,
    last_seen_at: r.captured_at,
    metadata: { fuente: fuente.source_key, posicion: p.image_position ? Number(p.image_position) : null, rol: p.role ?? null }
  });
}

// Una misma URL puede aparecer en dos fichas de la misma tienda: la foto de
// familia que comparten seis tonos, o la misma imagen repetida en la galería.
// La clave del medio es la URL, así que hay que quedarse con una — si no,
// Postgres rechaza el lote entero por tocar la misma fila dos veces.
//
// Se queda la primera aparición, que es la de posición más baja del producto que
// la publicó antes. Que dos productos compartan foto no es un error de la
// fuente: es información, y por eso se cuenta.
const mediosPorClave = new Map();
let mediosCompartidos = 0;
for (const m of medios) {
  if (mediosPorClave.has(m.media_key)) { mediosCompartidos += 1; continue; }
  mediosPorClave.set(m.media_key, m);
}
const mediosUnicos = [...mediosPorClave.values()];

console.log(`A promover:`);
console.log(`  productos de referencia: ${productos.length}`);
console.log(`  variantes de referencia: ${variantes.length}`);
console.log(`  medios de referencia:      ( URL compartidas entre fichas)`);
console.log(`\nDescartes:`);
console.log(`  productos sin marca resoluble: ${sinMarca.length}`);
console.log(`  variantes sin producto padre:  ${variantesHuerfanas.length}`);
console.log(`  imágenes sin producto padre:   ${mediosHuerfanos.length}`);
if (marcasNoResueltas.size) {
  console.log(`\n  marcas del payload que no existen en brands:`);
  for (const [m, n] of [...marcasNoResueltas].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`     ${String(n).padStart(4)}  ${m}`);
}

const conSku = variantes.filter((v) => v.sku).length;
const conPrecio = variantes.filter((v) => v.metadata.precioObservado != null).length;
const enriquecidos = productos.filter((p) => p.enrichment_level === "REFERENCE_ENRICHED").length;
console.log(`\nRiqueza del universo resultante:`);
console.log(`  variantes con SKU de fabricante: ${conSku} (${Math.round(conSku / variantes.length * 100)}%)`);
console.log(`  variantes con precio observado:  ${conPrecio} (${Math.round(conPrecio / variantes.length * 100)}%)`);
console.log(`  productos con descripción útil:  ${enriquecidos} (${Math.round(enriquecidos / productos.length * 100)}%)`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`);
  process.exit(0);
}

// ── Escritura ───────────────────────────────────────────────────────────────
// La corrida se identifica por la huella de lo que entra, no por la hora: dos
// promociones de los mismos registros son la misma corrida conceptual, y
// distinguirlas por reloj llenaría el historial de ruido.
const huellaEntrada = sha(
  JSON.stringify([productos.length, variantes.length, medios.length,
    productos.map((p) => p.content_fingerprint).sort().join("").slice(0, 4096)])
);

const { data: corrida, error: errCorrida } = await db
  .from("catalog_research_runs")
  .upsert({
    run_key: `promocion-universo-${huellaEntrada.slice(0, 12)}`,
    run_kind: "baseline",
    actor_kind: "system",
    actor_label: "promover-universo-referencia.mjs",
    status: "running",
    // Reabrir una corrida ya cerrada exige limpiar la fecha de fin: la
    // restricción prohíbe «en curso» con finished_at puesto, y sin esto el
    // segundo intento revienta después de haber escrito todos los casos.
    finished_at: null,
    result_fingerprint: null,
    input_fingerprint: huellaEntrada,
    scope: { fuentes: [...new Set(productos.map((p) => p.metadata.fuente))] },
    metrics: { productos: productos.length, variantes: variantes.length, medios: mediosUnicos.length }
  }, { onConflict: "run_key" })
  .select("id").single();
if (errCorrida) throw new Error(`catalog_research_runs: ${errCorrida.message}`);
const runId = corrida.id;

async function enLotes(tabla, filas, conflicto, tam = 400) {
  let hechas = 0;
  for (let i = 0; i < filas.length; i += tam) {
    const lote = filas.slice(i, i + tam);
    const { error } = await db.from(tabla).upsert(lote, { onConflict: conflicto });
    if (error) throw new Error(`${tabla}: ${error.message}`);
    hechas += lote.length;
    if (hechas % 2000 === 0 || hechas === filas.length) console.log(`   ${tabla}: ${hechas}/${filas.length}`);
  }
}

await enLotes("catalog_reference_products", productos.map((p) => ({ ...p, first_seen_run_id: runId, last_seen_run_id: runId })), "reference_key");

// PostgREST corta en 1.000 filas por respuesta y no avisa. La primera versión
// de esto leyó los 3.298 productos con .limit(20000), recibió 1.000, y las
// variantes cuyo padre no estaba en ese primer millar se filtraron en silencio:
// se escribieron 1.011 de 3.406 y el script terminó diciendo que todo fue bien.
const guardados = await todas("catalog_reference_products", "id, reference_key");
const idPorClave = new Map(guardados.map((g) => [g.reference_key, g.id]));
// La condición no es que el total coincida —la tabla puede traer filas de otras
// corridas, como los dos fixtures de ACRYLOVE— sino que TODOS los que acabo de
// escribir tengan id. Si falta uno, sus variantes se caerían sin ruido.
const faltantes = productos.filter((p) => !idPorClave.has(p.reference_key));
if (faltantes.length) {
  throw new Error(
    `${faltantes.length} de ${productos.length} productos no se releyeron ` +
    `(p. ej. ${faltantes[0].reference_key}): no sigo, sus variantes quedarían huérfanas`
  );
}

await enLotes(
  "catalog_reference_variants",
  variantes.map(({ _padre, ...v }) => ({ ...v, reference_product_id: idPorClave.get(_padre), first_seen_run_id: runId, last_seen_run_id: runId }))
    .filter((v) => v.reference_product_id),
  "reference_key"
);

await enLotes(
  "catalog_reference_media",
  mediosUnicos.map(({ _padre, ...m }) => ({ ...m, reference_product_id: idPorClave.get(_padre), first_seen_run_id: runId, last_seen_run_id: runId }))
    .filter((m) => m.reference_product_id),
  "media_key"
);

await db.from("catalog_research_runs").update({
  status: "succeeded",
  finished_at: new Date().toISOString(),
  result_fingerprint: huellaEntrada,
  result: { promovidos: { productos: productos.length, variantes: variantes.length, medios: mediosUnicos.length } }
}).eq("id", runId);

console.log(`\nUniverso de referencia promovido. Corrida ${runId}`);
console.log(`Siguiente: npm run graph:sync`);
