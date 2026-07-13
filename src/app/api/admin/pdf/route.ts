import { handleApiError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isStale(snapshot: string | null | undefined, contentUpdatedAt: string | null | undefined) {
  if (!snapshot || !contentUpdatedAt) {
    return true;
  }

  return new Date(snapshot).getTime() < new Date(contentUpdatedAt).getTime();
}

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    const [metadataResult, exportsResult] = await Promise.all([
      supabase
        .from("catalog_metadata")
        .select("content_updated_at")
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("pdf_exports")
        .select(
          "id, status, storage_path, generated_at, catalog_updated_at_snapshot, error_message, created_at, updated_at"
        )
        .order("created_at", { ascending: false })
        .limit(20)
    ]);

    if (metadataResult.error) {
      throw metadataResult.error;
    }

    if (exportsResult.error) {
      throw exportsResult.error;
    }

    return ok({
      catalogUpdatedAt: metadataResult.data?.content_updated_at ?? null,
      items: (exportsResult.data ?? []).map((item) => ({
        ...item,
        isStale: isStale(
          item.catalog_updated_at_snapshot,
          metadataResult.data?.content_updated_at
        )
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}
