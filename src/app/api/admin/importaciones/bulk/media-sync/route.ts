import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { syncBulkBatchMedia } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const { supabase } = await requireCatalogImportDeveloper();
    const body = (await request.json().catch(() => null)) as { batchId?: string } | null;
    if (!body?.batchId) throw new HttpError(400, "bulk_batch_required", "Falta batchId.");
    return ok(await syncBulkBatchMedia(supabase, body.batchId));
  } catch (error) {
    return handleApiError(error);
  }
}
