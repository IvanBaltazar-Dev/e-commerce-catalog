import { randomUUID } from "node:crypto";
import { handleApiError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { assetUploadSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extensionFromContentType(contentType: string) {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf"
  };

  return map[contentType] ?? "bin";
}

function folderForKind(kind: "product-image" | "color-chart" | "catalog-pdf") {
  if (kind === "color-chart") {
    return "color-charts";
  }

  if (kind === "catalog-pdf") {
    return "generated";
  }

  return "products";
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, assetUploadSchema);
    const bucket = input.kind === "catalog-pdf" ? "catalog-pdfs" : "catalog-assets";
    const path = `${folderForKind(input.kind)}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extensionFromContentType(input.contentType)}`;
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, {
      upsert: false
    });

    if (error) {
      throw error;
    }

    return ok({
      bucket,
      path,
      signedUrl: data.signedUrl,
      token: data.token
    });
  } catch (error) {
    return handleApiError(error);
  }
}
