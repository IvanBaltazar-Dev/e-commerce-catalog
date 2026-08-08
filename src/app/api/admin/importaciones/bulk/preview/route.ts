import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { parseCatalogXlsxRaw } from "@/lib/admin/catalog-import-xlsx";
import { stageBulkImportBatch, type BulkLoteSpec } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MULTIPART_BYTES = 9 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_MULTIPART_BYTES) throw new HttpError(413, "import_request_too_large", "La solicitud supera 9 MB.");
    const { supabase, user } = await requireCatalogImportDeveloper();
    const form = await request.formData();
    const file = form.get("file");
    const rawLote = form.get("lote");
    if (!(file instanceof File)) throw new HttpError(400, "import_file_required", "Selecciona el listado .xlsx.");
    if (typeof rawLote !== "string") throw new HttpError(400, "bulk_lote_required", "Indica el lote (nombre y familias) en el campo «lote».");
    let lote: BulkLoteSpec;
    try {
      lote = JSON.parse(rawLote) as BulkLoteSpec;
    } catch {
      throw new HttpError(400, "bulk_lote_invalid", "El campo «lote» debe ser JSON: { name, familias?, fromRow?, toRow? }.");
    }
    const workbook = await parseCatalogXlsxRaw(file);
    return ok(await stageBulkImportBatch(supabase, user.id, workbook, lote));
  } catch (error) {
    return handleApiError(error);
  }
}
