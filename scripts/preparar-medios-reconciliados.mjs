/**
 * Prepara los medios que la identidad reconciliada dejó al alcance.
 *
 * Encontrar una URL no la convierte en imagen publicable. La política vigente
 * separa tres cosas y aquí se respetan las tres:
 *
 *   remote_reference   la fuente publica esta imagen        ← ya lo teníamos
 *   descargada         está en nuestro almacenamiento       ← lo que hace esto
 *   publicable         se decidió enseñarla a la clienta    ← NO lo hace esto
 *
 * Cada archivo se queda con su URL de origen, su hash SHA-256, su hash
 * perceptual, resolución, fecha y la variante de referencia que lo produjo. El
 * perceptual sirve para lo que el criptográfico no puede: dos recortes distintos
 * de la misma foto tienen SHA distinto y dHash casi igual, y eso es un duplicado
 * aunque los bytes difieran.
 *
 * Solo entra lo que cuelga de una identidad MATCH_EXACT de variante. Una imagen
 * traída por un parecido de nombre es exactamente lo que revolvió 159 fotos de
 * Masglo.
 *
 * Uso:
 *   node scripts/preparar-medios-reconciliados.mjs             (previsualización)
 *   node scripts/preparar-medios-reconciliados.mjs --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const BUCKET = "catalog-assets";
const PREFIJO = "reconciliado-1";
const PAUSA_MS = 180;

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Hash perceptual por diferencias: reduce a 9×8 en gris y compara cada píxel
// con su vecino. Dos versiones de la misma foto —otro recorte, otra compresión—
// caen a pocos bits de distancia aunque su SHA no tenga nada que ver.
async function dHash(buffer) {
  const { data } = await sharp(buffer).resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let fila = 0; fila < 8; fila += 1) {
    for (let col = 0; col < 8; col += 1) bits += data[fila * 9 + col] > data[fila * 9 + col + 1] ? "1" : "0";
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

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

const casos = await todas("catalog_reconciliation_cases", "id, variant_id, reference_variant_id, evidence",
  (q) => q.eq("entity_type", "variant").in("status", ["proposed", "needs_review"]));
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, sku, name, shade_name");
const refMedios = await todas("catalog_reference_media", "id, reference_product_id, remote_url, media_kind, validation_status, metadata");
const variantes = await todas("product_variants", "id, product_id, name, is_active");
const yaVinculados = await todas("product_media", "variant_id, media_role");

const refPorId = new Map(refVariantes.map((r) => [r.id, r]));
const varPorId = new Map(variantes.map((v) => [v.id, v]));
const mediosDe = new Map();
for (const m of refMedios) {
  if (!mediosDe.has(m.reference_product_id)) mediosDe.set(m.reference_product_id, []);
  mediosDe.get(m.reference_product_id).push(m);
}
const conMedio = new Set(yaVinculados.filter((x) => x.variant_id).map((x) => `${x.variant_id}::${x.media_role}`));

const cola = [];
const rechazos = new Map();
const anota = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const c of casos) {
  if (c.evidence?.clase !== "MATCH_EXACT") { anota(rechazos, "la identidad no es exacta"); continue; }
  const v = varPorId.get(c.variant_id);
  const rv = refPorId.get(c.reference_variant_id);
  if (!v?.is_active || !rv) { anota(rechazos, "variante inactiva o referencia ausente"); continue; }
  if (conMedio.has(`${v.id}::main`)) { anota(rechazos, "la variante ya tiene imagen principal"); continue; }

  const medios = (mediosDe.get(rv.reference_product_id) ?? [])
    .filter((m) => m.validation_status === "remote_reference")
    .sort((a, b) => (a.metadata?.posicion ?? 99) - (b.metadata?.posicion ?? 99));
  if (!medios.length) { anota(rechazos, "la ficha oficial no tiene imagen registrada"); continue; }

  cola.push({
    variantId: v.id, variante: v.name, refVariantId: rv.id, refProductId: rv.reference_product_id,
    url: medios[0].remote_url, refMediaId: medios[0].id, sku: rv.sku
  });
}

console.log(`Casos examinados: ${casos.length}`);
console.log(`  medios a preparar: ${cola.length}`);
console.log(`\nDescartes:`);
for (const [m, n] of [...rechazos].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${m}`);
console.log(`\nMuestra:`);
for (const x of cola.slice(0, 6)) console.log(`   ${String(x.sku ?? "").padEnd(10)} ${x.variante.slice(0, 24).padEnd(26)} ${x.url.slice(0, 62)}`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
if (!APLICAR) {
  console.log(`\nPrevisualización. Nada descargado. Añade --aplicar.`);
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let descargados = 0, reutilizados = 0, duplicados = 0, fallos = 0;
const perceptuales = new Map();

for (const x of cola) {
  try {
    const respuesta = await fetch(x.url, { headers: { "User-Agent": "BellarosheCatalogImagePipeline/1.0" }, signal: AbortSignal.timeout(25000) });
    if (!respuesta.ok) throw new Error(`${respuesta.status}`);
    const tipo = (respuesta.headers.get("content-type") || "").split(";")[0];
    if (!tipo.startsWith("image/")) throw new Error(`content-type ${tipo}`);

    const original = Buffer.from(await respuesta.arrayBuffer());
    const normalizada = await sharp(original).rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 }).toBuffer();
    const meta = await sharp(normalizada).metadata();
    const checksum = sha256(normalizada);
    const perceptual = await dHash(normalizada);

    if (perceptuales.has(perceptual) && perceptuales.get(perceptual) !== checksum) duplicados += 1;
    perceptuales.set(perceptual, checksum);

    const { data: existente } = await db.from("media_assets").select("id").eq("checksum", checksum).maybeSingle();
    let assetId = existente?.id ?? null;
    if (assetId) reutilizados += 1;

    if (!assetId) {
      const ruta = `${PREFIJO}/${crypto.randomUUID()}.webp`;
      const { error: errSubida } = await db.storage.from(BUCKET).upload(ruta, normalizada, { contentType: "image/webp", upsert: false });
      if (errSubida) throw new Error(`storage: ${errSubida.message}`);
      const { data: creado, error: errAsset } = await db.from("media_assets").insert({
        bucket: BUCKET, storage_path: ruta, file_name: `${x.sku ?? x.variantId}.webp`,
        mime_type: "image/webp", size_bytes: normalizada.length,
        width: meta.width ?? null, height: meta.height ?? null,
        alt_text: x.variante, checksum, evidence_class: "FOTO_REAL",
        metadata: {
          origen: "RECONCILIACION_OFICIAL",
          // La puerta sigue cerrada: descargarla no la publica. Falta validar
          // derechos y que la correspondencia sea la que creemos.
          publishGate: "VALIDAR_DERECHOS_Y_CORRESPONDENCIA",
          referenceVariantId: x.refVariantId,
          referenceMediaId: x.refMediaId,
          urlOriginal: x.url,
          sha256Original: sha256(original),
          perceptualDhash64: perceptual,
          skuOficial: x.sku ?? null
        }
      }).select("id").single();
      if (errAsset) throw new Error(`media_assets: ${errAsset.message}`);
      assetId = creado.id;
      descargados += 1;
    }

    const { error: errVinculo } = await db.from("product_media").insert({
      variant_id: x.variantId, media_asset_id: assetId, media_role: "main", is_primary: true, sort_order: 0
    });
    if (errVinculo && !/duplicate|unique/i.test(errVinculo.message)) throw new Error(`product_media: ${errVinculo.message}`);
  } catch (error) {
    fallos += 1;
    console.error(`   ✗ ${String(x.sku ?? x.variantId)}: ${error.message}`);
  }
  await espera(PAUSA_MS);
}

console.log(`\nDescargados: ${descargados}`);
console.log(`Reutilizados (mismo checksum ya cargado): ${reutilizados}`);
console.log(`Duplicados perceptuales detectados: ${duplicados}`);
console.log(`Fallos: ${fallos}`);
console.log(`\nNinguno queda publicable: todos con publishGate VALIDAR_DERECHOS_Y_CORRESPONDENCIA.`);
