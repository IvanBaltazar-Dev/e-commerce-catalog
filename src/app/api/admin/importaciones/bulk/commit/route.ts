import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { commitBulkBatch } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireCatalogImportDeveloper();
    const body = (await request.json().catch(() => null)) as { batchId?: string; confirmation?: string } | null;
    if (!body?.batchId) throw new HttpError(400, "bulk_batch_required", "Falta batchId.");
    return ok(await commitBulkBatch(supabase, user.id, body.batchId, String(body.confirmation ?? "")));
  } catch (error) {
    return handleApiError(error);
  }
}
