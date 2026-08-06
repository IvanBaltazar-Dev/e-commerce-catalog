import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { analyzeCatalogImport } from "@/lib/admin/catalog-import-service";
import { parseCatalogImportXlsx } from "@/lib/admin/catalog-import-xlsx";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = 9 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_MULTIPART_BYTES) throw new HttpError(413, "import_request_too_large", "La solicitud supera 9 MB.");
    const { supabase } = await requireCatalogImportDeveloper();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "import_file_required", "Selecciona un archivo .xlsx.");
    const workbook = await parseCatalogImportXlsx(file);
    const analysis = await analyzeCatalogImport(supabase, workbook);
    return ok(analysis.preview);
  } catch (error) {
    return handleApiError(error);
  }
}
