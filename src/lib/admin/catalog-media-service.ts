import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import type {
  CatalogMediaPackageCommitResult,
  CatalogMediaPackagePreview
} from "@/lib/admin/catalog-import-types";
import type { CatalogMediaAsset, CatalogMediaPackage } from "@/lib/admin/catalog-media-zip";

type Supabase = SupabaseClient;

async function existingPaths(supabase: Supabase, assets: CatalogMediaAsset[]) {
  const existing = new Set<string>();
  for (let offset = 0; offset < assets.length; offset += 12) {
    const checks = await Promise.all(assets.slice(offset, offset + 12).map(async (asset) => {
      const result = await supabase.storage.from("catalog-assets").exists(asset.path);
      const status = result.error ? (result.error as { status?: number }).status : undefined;
      if (result.error && ![400, 404].includes(status ?? 0)) {
        throw new HttpError(502, "catalog_media_lookup_failed", `No se pudo verificar ${asset.path}: ${result.error.message}`);
      }
      return { path: asset.path, exists: Boolean(result.data) };
    }));
    for (const check of checks) if (check.exists) existing.add(check.path);
  }
  return existing;
}

export async function analyzeCatalogMediaPackage(supabase: Supabase, mediaPackage: CatalogMediaPackage): Promise<CatalogMediaPackagePreview> {
  const existing = await existingPaths(supabase, mediaPackage.assets);
  const webpFiles = mediaPackage.assets.filter((asset) => asset.mimeType === "image/webp").length;
  const pdfFiles = mediaPackage.assets.length - webpFiles;
  return {
    fileName: mediaPackage.fileName,
    fileSha256: mediaPackage.fileSha256,
    canCommit: mediaPackage.assets.length > 0,
    security: mediaPackage.security,
    summary: {
      mediaFiles: mediaPackage.assets.length,
      webpFiles,
      pdfFiles,
      ignoredFiles: mediaPackage.ignored.length,
      existingFiles: existing.size,
      filesToUpload: mediaPackage.assets.length - existing.size,
      mediaBytes: mediaPackage.security.mediaBytes
    },
    ignored: mediaPackage.ignored,
    samplePaths: mediaPackage.assets.slice(0, 12).map((asset) => asset.path)
  };
}

async function insertAudit(supabase: Supabase, userId: string, mediaPackage: CatalogMediaPackage) {
  const result = await supabase.from("import_batches").insert({
    source_type: "catalog_media_zip",
    source_name: "catalog-assets",
    original_file_name: mediaPackage.fileName,
    status: "uploaded",
    total_rows: mediaPackage.assets.length,
    processed_rows: 0,
    error_rows: 0,
    created_by: userId,
    file_sha256: mediaPackage.fileSha256,
    security_report: mediaPackage.security
  }).select("id").single();
  if (result.error) throw new HttpError(400, "catalog_media_audit_failed", result.error.message);
  return String(result.data.id);
}

async function uploadBatch(supabase: Supabase, assets: CatalogMediaAsset[]) {
  const settled = await Promise.allSettled(assets.map(async (asset) => {
    const result = await supabase.storage.from("catalog-assets").upload(asset.path, asset.body, {
      contentType: asset.mimeType,
      cacheControl: "31536000",
      upsert: false
    });
    if (result.error) throw new HttpError(400, "catalog_media_upload_failed", `No se pudo subir ${asset.path}: ${result.error.message}`);
    return asset;
  }));
  const uploaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  return { uploaded, error: failed?.reason as unknown };
}

export async function commitCatalogMediaPackage(
  supabase: Supabase,
  userId: string,
  mediaPackage: CatalogMediaPackage,
  expectedSha256: string
): Promise<CatalogMediaPackageCommitResult> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || expectedSha256 !== mediaPackage.fileSha256) {
    throw new HttpError(409, "catalog_media_file_changed", "El ZIP no coincide con la previsualización aprobada.");
  }
  const existing = await existingPaths(supabase, mediaPackage.assets);
  const pending = mediaPackage.assets.filter((asset) => !existing.has(asset.path));
  const batchId = await insertAudit(supabase, userId, mediaPackage);
  const uploaded: CatalogMediaAsset[] = [];

  try {
    const parsing = await supabase.from("import_batches").update({ status: "parsing" }).eq("id", batchId);
    if (parsing.error) throw new HttpError(400, "catalog_media_audit_failed", parsing.error.message);
    for (let offset = 0; offset < pending.length; offset += 6) {
      const result = await uploadBatch(supabase, pending.slice(offset, offset + 6));
      uploaded.push(...result.uploaded);
      if (result.error) throw result.error;
    }

    const finalExisting = await existingPaths(supabase, mediaPackage.assets);
    if (finalExisting.size !== mediaPackage.assets.length) {
      throw new HttpError(502, "catalog_media_verification_failed", "No todos los medios quedaron disponibles después de la carga.");
    }
    const committed = await supabase.from("import_batches").update({
      status: "committed",
      processed_rows: mediaPackage.assets.length,
      error_rows: 0,
      committed_at: new Date().toISOString()
    }).eq("id", batchId);
    if (committed.error) throw new HttpError(400, "catalog_media_audit_failed", committed.error.message);
    return {
      batchId,
      fileSha256: mediaPackage.fileSha256,
      uploadedFiles: uploaded.length,
      existingFiles: existing.size,
      uploadedBytes: uploaded.reduce((sum, asset) => sum + asset.bytes, 0)
    };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (let offset = 0; offset < uploaded.length; offset += 100) {
      const paths = uploaded.slice(offset, offset + 100).map((asset) => asset.path);
      const removal = await supabase.storage.from("catalog-assets").remove(paths);
      if (removal.error) rollbackFailures.push(...paths);
    }
    await supabase.from("import_batches").update({
      status: "failed",
      processed_rows: 0,
      error_rows: mediaPackage.assets.length,
      security_report: { ...mediaPackage.security, rollbackFailures }
    }).eq("id", batchId);
    if (rollbackFailures.length) {
      throw new HttpError(500, "catalog_media_rollback_incomplete", "La carga falló y algunos archivos no pudieron revertirse.", {
        cause: error instanceof Error ? error.message : String(error),
        rollbackFailures
      });
    }
    throw error;
  }
}
