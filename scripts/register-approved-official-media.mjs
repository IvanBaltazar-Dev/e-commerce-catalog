// Registra en el catálogo comercial las imágenes oficiales de identidades ya
// aprobadas. Nunca reemplaza un medio existente y solo enlaza tonos cuando la
// reconciliación apunta a una única variante activa.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const { env } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "register-approved-official-media",
  allowedFlags: ["--apply"],
});

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function inChunks(table, select, column, values, extra = (query) => query) {
  const rows = [];
  for (let offset = 0; offset < values.length; offset += 100) {
    const batch = values.slice(offset, offset + 100);
    if (!batch.length) continue;
    rows.push(...must(await extra(service.from(table).select(select).in(column, batch)), table));
  }
  return rows;
}

const reconciliations = must(await service
  .from("catalog_reconciliation_cases")
  .select("id,entity_type,product_id,shade_id,evidence,status")
  .eq("status", "approved")
  .in("entity_type", ["product", "shade"]), "reconciliaciones aprobadas")
  .filter((row) => typeof row.evidence?.official_image_url === "string" && row.evidence.official_image_url.trim());

const shadeIds = [...new Set(reconciliations.flatMap((row) => row.shade_id ? [row.shade_id] : []))];
const shadeVariants = await inChunks(
  "product_variants",
  "id,product_id,name,sku,color_shade_id,is_active",
  "color_shade_id",
  shadeIds,
  (query) => query.eq("is_active", true),
);
const variantsByShade = new Map();
for (const variant of shadeVariants) {
  const current = variantsByShade.get(variant.color_shade_id) ?? [];
  current.push(variant);
  variantsByShade.set(variant.color_shade_id, current);
}

const productIds = [...new Set(reconciliations.flatMap((row) => row.product_id ? [row.product_id] : []))];
const products = await inChunks("products", "id,name,code", "id", productIds);
const productsById = new Map(products.map((product) => [product.id, product]));

const targets = [];
const ambiguous = [];
for (const reconciliation of reconciliations) {
  if (reconciliation.entity_type === "product" && reconciliation.product_id) {
    const product = productsById.get(reconciliation.product_id);
    if (!product) continue;
    targets.push({
      reconciliation,
      ownerType: "product",
      ownerId: product.id,
      name: product.name,
      code: product.code,
    });
    continue;
  }

  const variants = variantsByShade.get(reconciliation.shade_id) ?? [];
  if (variants.length !== 1) {
    ambiguous.push({ reconciliationId: reconciliation.id, shadeId: reconciliation.shade_id, targets: variants.length });
    continue;
  }
  const variant = variants[0];
  targets.push({
    reconciliation,
    ownerType: "variant",
    ownerId: variant.id,
    name: variant.name,
    code: variant.sku,
  });
}

const productTargetIds = targets.filter((target) => target.ownerType === "product").map((target) => target.ownerId);
const variantTargetIds = targets.filter((target) => target.ownerType === "variant").map((target) => target.ownerId);
const existingMedia = [
  ...await inChunks("product_media", "product_id,variant_id", "product_id", productTargetIds),
  ...await inChunks("product_media", "product_id,variant_id", "variant_id", variantTargetIds),
];
const occupied = new Set(existingMedia.flatMap((row) => [row.product_id, row.variant_id].filter(Boolean)));
const pending = targets.filter((target) => !occupied.has(target.ownerId));

console.log(JSON.stringify({
  mode: APPLY ? "apply" : "preview",
  approvedWithImage: reconciliations.length,
  safeTargets: targets.length,
  alreadyRegistered: targets.length - pending.length,
  pending: pending.length,
  ambiguous,
}, null, 2));

if (APPLY) {
  const failures = [];
  let registered = 0;
  let reusedAssets = 0;

  for (const [index, target] of pending.entries()) {
  const sourceUrl = target.reconciliation.evidence.official_image_url.trim();
  try {
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": "BellarosheCatalogMedia/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = Buffer.from(await response.arrayBuffer());
    if (!source.length || source.length > 15 * 1024 * 1024) throw new Error(`tamaño inválido: ${source.length}`);

    const normalized = await sharp(source, { failOn: "warning" })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    const checksum = crypto.createHash("sha256").update(normalized.data).digest("hex");
    const storagePath = `approved-official/${target.ownerType}/${target.ownerId}/${checksum}.webp`;

    let asset = must(await service.from("media_assets")
      .select("id,bucket,storage_path")
      .eq("checksum", checksum)
      .maybeSingle(), `buscar medio ${checksum.slice(0, 12)}`);

    if (!asset) {
      const upload = await service.storage.from("catalog-assets").upload(storagePath, normalized.data, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });
      if (upload.error && !/already exists|duplicate/i.test(upload.error.message)) {
        throw new Error(`carga: ${upload.error.message}`);
      }

      asset = must(await service.from("media_assets").insert({
        bucket: "catalog-assets",
        storage_path: storagePath,
        file_name: `${target.code ?? target.ownerId}.webp`,
        mime_type: "image/webp",
        size_bytes: normalized.data.length,
        width: normalized.info.width,
        height: normalized.info.height,
        alt_text: target.name,
        checksum,
        metadata: {
          source: "approved_official_identity",
          officialUrl: target.reconciliation.evidence.official_url ?? null,
          remoteImageUrl: sourceUrl,
          reconciliationCaseId: target.reconciliation.id,
          normalizedAt: new Date().toISOString(),
        },
      }).select("id,bucket,storage_path").single(), `registrar medio ${target.name}`);
    } else {
      reusedAssets += 1;
    }

    const association = target.ownerType === "product"
      ? { product_id: target.ownerId, media_asset_id: asset.id, media_role: "main", is_primary: true }
      : { variant_id: target.ownerId, media_asset_id: asset.id, media_role: "main", is_primary: true };
    must(await service.from("product_media").insert(association), `enlazar medio ${target.name}`);

    must(await service.from("catalog_reconciliation_cases").update({
      evidence: {
        ...target.reconciliation.evidence,
        commercial_media_asset_id: asset.id,
        commercial_media_registered_at: new Date().toISOString(),
      },
    }).eq("id", target.reconciliation.id), `auditar reconciliación ${target.reconciliation.id}`);

    registered += 1;
    console.log(`[${index + 1}/${pending.length}] ${target.ownerType} · ${target.name}`);
  } catch (error) {
    failures.push({
      reconciliationId: target.reconciliation.id,
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      name: target.name,
      sourceUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[${index + 1}/${pending.length}] FALLÓ · ${target.name}: ${failures.at(-1).error}`);
  }
  }

  console.log(JSON.stringify({ registered, reusedAssets, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}
