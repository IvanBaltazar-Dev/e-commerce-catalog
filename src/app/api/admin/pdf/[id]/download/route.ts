import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { uuidSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { supabase } = await requireAdmin();
    const { id } = await context.params;
    const exportId = uuidSchema.parse(id);
    const { data: item, error } = await supabase
      .from("pdf_exports")
      .select("id, status, storage_path")
      .eq("id", exportId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!item?.storage_path || item.status !== "updated") {
      throw new HttpError(404, "pdf_not_available", "PDF is not available for download.");
    }

    const signedUrlResult = await supabase.storage
      .from("catalog-pdfs")
      .createSignedUrl(item.storage_path, 300);

    if (signedUrlResult.error) {
      throw signedUrlResult.error;
    }

    return ok({
      downloadUrl: signedUrlResult.data.signedUrl,
      expiresInSeconds: 300
    });
  } catch (error) {
    return handleApiError(error);
  }
}
