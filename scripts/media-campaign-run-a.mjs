/**
 * Campaña Multimedia · carril A.
 *
 * Descarga las imágenes oficiales de los expedientes cuya identidad YA está
 * decidida. Este guion no reinterpreta de quién es una imagen: el dueño vino
 * congelado y se respeta. Si algo no cuadra, el expediente falla con causa
 * escrita; nunca se reasigna por su cuenta.
 *
 * Para cada expediente:
 *
 *   descargar original desde la fuente declarada
 *        ↓ validar respuesta, tipo y dimensiones
 *   SHA-256 exacto + hash perceptual
 *        ↓ deduplicar contra lo ya declarado
 *   conservar el original
 *        ↓ generar el derivado web
 *   vincular al dueño exacto y registrar procedencia
 *
 * El original se conserva en el almacén local, que es lo que el checkpoint sabe
 * restaurar. A Supabase Storage sube el derivado, que es lo que el catálogo
 * sirve y lo que el gate de patrimonio vigila: un objeto por medio declarado,
 * sin huérfanos.
 *
 * Uso:
 *   node scripts/media-campaign-run-a.mjs --key=campana-multimedia-1 \
 *     [--limite=N] --env .env.supabase.local
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "media-campaign-run-a",
  allowedFlags: ["--key", "--limite"],
});
if (!isLocal) throw new Error("La campaña multimedia solo corre contra Supabase local.");

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const campaignKey = argument("key");
if (!campaignKey) throw new Error("Falta --key con la clave de la campaña.");
const limit = Number(argument("limite") ?? 0) || Infinity;

const BUCKET = "catalog-assets";
const MEDIA_ROOT = path.join(catalogResearchStorageRoot(ROOT), "media");
const ORIGINALS_ROOT = path.join(catalogResearchStorageRoot(ROOT), "media-originales");
const TIMEOUT_MS = 30_000;
const MIN_SIDE = 120;

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/**
 * Hash perceptual de diferencias (dHash). Sirve para lo que el SHA-256 no
 * puede: reconocer que dos archivos distintos byte a byte son la misma foto
 * recomprimida. No se usa para decidir identidad —eso ya viene decidido— sino
 * para señalar parecidos sospechosos al auditar.
 */
async function perceptualHash(buffer) {
  const pixels = await sharp(buffer).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits += pixels[row * 9 + column] < pixels[row * 9 + column + 1] ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

async function fetchOriginal(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "BellarosheCatalogBot/1.0 (+campaña multimedia local)" },
    });
    if (!response.ok) return { error: `la fuente respondió ${response.status}` };
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return { error: `la fuente devolvió «${type || "sin tipo"}», no una imagen` };
    return { buffer: Buffer.from(await response.arrayBuffer()), declaredMime: type.split(";")[0].trim() };
  } catch (error) {
    return { error: error.name === "AbortError" ? `sin respuesta en ${TIMEOUT_MS} ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function writeLocal(root, relative, buffer) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
}

async function settle(item, state, patch = {}, cause = null) {
  must(
    await service.from("catalog_media_campaign_items")
      .update({ state, cause, processed_at: new Date().toISOString(), ...patch })
      .eq("id", item.id),
    `cerrar el expediente ${item.id}`
  );
}

// ---------------------------------------------------------------------------

const campaign = must(
  await service.from("catalog_media_campaigns").select("id, campaign_key, status")
    .eq("campaign_key", campaignKey).single(),
  "campaña"
);

const pending = must(
  await service.from("catalog_media_campaign_items")
    .select("id, variant_id, official_url, provenance")
    .eq("campaign_id", campaign.id).eq("lane", "A").eq("state", "PENDING")
    .order("id"),
  "expedientes del carril A"
);

console.log(`Carril A · ${Math.min(pending.length, limit)} de ${pending.length} expedientes pendientes\n`);

if (campaign.status === "frozen") {
  must(await service.from("catalog_media_campaigns").update({ status: "running" }).eq("id", campaign.id),
    "marcar la campaña en marcha");
}

const tally = { DOWNLOADED: 0, DEDUPLICATED: 0, DOWNLOAD_FAILED: 0, INVALID_IMAGE: 0 };
let processed = 0;

for (const item of pending) {
  if (processed >= limit) break;
  processed += 1;
  const label = item.provenance?.sku ?? item.variant_id;

  const fetched = await fetchOriginal(item.official_url);
  if (fetched.error) {
    await settle(item, "DOWNLOAD_FAILED", {}, fetched.error);
    tally.DOWNLOAD_FAILED += 1;
    console.log(`  ✗ ${label} · ${fetched.error}`);
    continue;
  }

  let metadata;
  try {
    metadata = await sharp(fetched.buffer).metadata();
  } catch (error) {
    await settle(item, "INVALID_IMAGE", {}, `no se pudo leer como imagen: ${error.message}`);
    tally.INVALID_IMAGE += 1;
    console.log(`  ✗ ${label} · ilegible`);
    continue;
  }

  if (!metadata.width || !metadata.height || metadata.width < MIN_SIDE || metadata.height < MIN_SIDE) {
    await settle(item, "INVALID_IMAGE", {},
      `dimensiones insuficientes: ${metadata.width ?? "?"}×${metadata.height ?? "?"}, mínimo ${MIN_SIDE}`);
    tally.INVALID_IMAGE += 1;
    console.log(`  ✗ ${label} · ${metadata.width}×${metadata.height}`);
    continue;
  }

  const digest = sha256(fetched.buffer);
  const phash = await perceptualHash(fetched.buffer).catch(() => null);

  const extension = (metadata.format ?? "bin").replace("jpeg", "jpg");
  const originalRelative = `${item.variant_id}/original.${extension}`;
  await writeLocal(ORIGINALS_ROOT, originalRelative, fetched.buffer);

  // Derivado web: un solo formato, tamaño acotado, sin ampliar lo pequeño.
  const derivative = await sharp(fetched.buffer)
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const derivativeMeta = await sharp(derivative).metadata();

  // Ciento dos de estos expedientes NO son altas: son medios ya declarados que
  // se quedaron sin bytes. Se recuperan EN SU SITIO —misma fila, misma ruta,
  // mismo identificador— porque su historia y sus referencias siguen siendo
  // válidas; lo único que faltaba era el archivo. Crear un medio nuevo al lado
  // dejaría el fantasma intacto y sumaría un duplicado.
  const existing = must(
    await service.from("product_media")
      .select("media_asset_id, media_assets(storage_path)")
      .eq("variant_id", item.variant_id).eq("media_role", "main").eq("is_primary", true)
      .maybeSingle(),
    "medio principal ya declarado"
  );
  const existingAsset = existing
    ? {
        id: existing.media_asset_id,
        path: Array.isArray(existing.media_assets)
          ? existing.media_assets[0]?.storage_path
          : existing.media_assets?.storage_path,
      }
    : null;

  // Deduplicación por contenido del derivado, que es lo que se guarda y lo que
  // el índice único protege. Aparece más de lo esperado: cuando la fuente solo
  // publica una foto de producto, esa misma imagen sirve a varios tonos. El
  // sistema lo modela como un medio compartido por varias variantes, no como
  // copias.
  const derivativeChecksum = sha256(derivative);
  const twin = must(
    await service.from("media_assets").select("id, storage_path").eq("checksum", derivativeChecksum).maybeSingle(),
    "medio con el mismo contenido"
  );

  // La identidad editorial manda sobre el contenido. Si esta variante ya tiene
  // su medio principal declarado, se recupera ESE, aunque exista otro archivo
  // con los mismos bytes: el otro puede ser el rastro de una corrida anterior
  // que no llegó a terminar, y confundirlo con «otra variante comparte esta
  // imagen» deja a la variante apuntando a un artefacto y a su medio de verdad
  // sin dueño. Solo se comparte cuando la variante no tiene medio propio.
  if (twin && !existingAsset) {
    must(
      await service.from("product_media").insert({
        media_asset_id: twin.id, variant_id: item.variant_id,
        media_role: "main", is_primary: true, sort_order: 0,
      }),
      "compartir el medio ya existente"
    );

    await settle(item, "DEDUPLICATED", {
      sha256: digest, perceptual_hash: phash, bytes: fetched.buffer.byteLength,
      mime: fetched.declaredMime, width: metadata.width, height: metadata.height,
      original_path: originalRelative, media_asset_id: twin.id,
      provenance: {
        ...item.provenance,
        compartidoCon: twin.storage_path,
        fetchedAt: new Date().toISOString(),
      },
    });
    tally.DEDUPLICATED += 1;
    console.log(`  = ${label} · comparte imagen con ${twin.storage_path}`);
    continue;
  }

  const storagePath = existingAsset?.path ?? `campana-1/${item.variant_id}.webp`;

  const uploaded = await service.storage.from(BUCKET)
    .upload(storagePath, derivative, { contentType: "image/webp", upsert: true });
  if (uploaded.error) {
    await settle(item, "DOWNLOAD_FAILED", { sha256: digest, original_path: originalRelative },
      `no se pudo guardar el derivado: ${uploaded.error.message}`);
    tally.DOWNLOAD_FAILED += 1;
    console.log(`  ✗ ${label} · ${uploaded.error.message}`);
    continue;
  }
  await writeLocal(MEDIA_ROOT, `${BUCKET}/${storagePath}`, derivative);

  const assetPayload = {
    bucket: BUCKET, storage_path: storagePath,
    file_name: `${item.provenance?.sku ?? item.variant_id}.webp`,
    mime_type: "image/webp", size_bytes: derivative.byteLength,
    width: derivativeMeta.width, height: derivativeMeta.height,
    checksum: derivativeChecksum,
    metadata: {
      campaign: campaignKey,
      officialUrl: item.official_url,
      evidenceUrl: item.provenance?.evidenceUrl ?? null,
      originalSha256: digest,
      originalMime: fetched.declaredMime,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      perceptualHash: phash,
      capturedAt: new Date().toISOString(),
      recovered: Boolean(existingAsset),
    },
  };

  let assetId;
  if (existingAsset) {
    must(await service.from("media_assets").update(assetPayload).eq("id", existingAsset.id),
      "recuperar el medio declarado");
    assetId = existingAsset.id;
  } else {
    assetId = must(
      await service.from("media_assets").insert(assetPayload).select("id").single(),
      "registrar el medio"
    ).id;
    must(
      await service.from("product_media").insert({
        media_asset_id: assetId, variant_id: item.variant_id,
        media_role: "main", is_primary: true, sort_order: 0,
      }),
      "vincular el medio a su variante"
    );
  }

  await settle(item, "DOWNLOADED", {
    sha256: digest, perceptual_hash: phash, bytes: fetched.buffer.byteLength,
    mime: fetched.declaredMime, width: metadata.width, height: metadata.height,
    original_path: originalRelative, derivative_path: storagePath, media_asset_id: assetId,
    provenance: {
      ...item.provenance,
      fetchedAt: new Date().toISOString(),
      recuperado: Boolean(existingAsset),
    },
  });
  tally.DOWNLOADED += 1;
  console.log(`  ✓ ${label} · ${metadata.width}×${metadata.height} → ${derivativeMeta.width}×${derivativeMeta.height}`);
}

console.log(`\n${JSON.stringify({ procesados: processed, ...tally }, null, 2)}`);
