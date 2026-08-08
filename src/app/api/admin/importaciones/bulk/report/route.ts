import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { buildBulkPreview, bulkBatchReport } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireCatalogImportDeveloper();
    const url = new URL(request.url);
    const batchId = url.searchParams.get("batchId");
    if (!batchId) {
      const batches = await supabase
        .from("import_batches")
        .select("id, source_name, original_file_name, status, total_rows, processed_rows, error_rows, committed_at, created_at, summary")
        .like("source_name", "bulk_catalog_v2:%")
        .order("created_at", { ascending: false })
        .limit(30);
      if (batches.error) throw new HttpError(400, "bulk_batches_read_failed", batches.error.message);
      return ok({ batches: batches.data ?? [] });
    }
    if (url.searchParams.get("view") === "preview") {
      return ok(await buildBulkPreview(supabase, batchId));
    }
    return ok(await bulkBatchReport(supabase, batchId));
  } catch (error) {
    return handleApiError(error);
  }
}
