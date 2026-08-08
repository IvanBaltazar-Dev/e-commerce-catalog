import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { approveBulkBatch, buildBulkPreview } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { supabase } = await requireCatalogImportDeveloper();
    const body = (await request.json().catch(() => null)) as {
      batchId?: string;
      includeReview?: boolean;
      rowNumbers?: number[];
      skipRowNumbers?: number[];
    } | null;
    if (!body?.batchId) throw new HttpError(400, "bulk_batch_required", "Falta batchId.");
    const result = await approveBulkBatch(supabase, body.batchId, {
      includeReview: body.includeReview === true,
      rowNumbers: Array.isArray(body.rowNumbers) ? body.rowNumbers.map(Number) : undefined,
      skipRowNumbers: Array.isArray(body.skipRowNumbers) ? body.skipRowNumbers.map(Number) : undefined
    });
    const preview = await buildBulkPreview(supabase, body.batchId);
    return ok({ ...result, preview });
  } catch (error) {
    return handleApiError(error);
  }
}
