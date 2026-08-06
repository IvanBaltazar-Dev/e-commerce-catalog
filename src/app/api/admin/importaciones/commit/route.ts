import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { commitCatalogImport } from "@/lib/admin/catalog-import-service";
import type { CatalogImportProductLineApproval } from "@/lib/admin/catalog-import-types";
import { parseCatalogImportXlsx } from "@/lib/admin/catalog-import-xlsx";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = 9 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_MULTIPART_BYTES) throw new HttpError(413, "import_request_too_large", "La solicitud supera 9 MB.");
    const { supabase, user } = await requireCatalogImportDeveloper();
    const form = await request.formData();
    const file = form.get("file");
    const expectedSha256 = form.get("expectedSha256");
    const confirmation = form.get("confirmation");
    const rawApprovals = form.get("productLineApprovals");
    if (!(file instanceof File)) throw new HttpError(400, "import_file_required", "Selecciona un archivo .xlsx.");
    if (typeof expectedSha256 !== "string") throw new HttpError(400, "import_hash_required", "Primero debes previsualizar el archivo.");
    if (typeof confirmation !== "string") throw new HttpError(400, "import_confirmation_required", "Escribe la confirmación solicitada para continuar.");
    if (rawApprovals !== null && typeof rawApprovals !== "string") {
      throw new HttpError(400, "import_invalid_structure_approvals", "Las autorizaciones de líneas no son válidas.");
    }
    let approvals: CatalogImportProductLineApproval[] = [];
    if (typeof rawApprovals === "string") {
      try {
        const parsed: unknown = JSON.parse(rawApprovals);
        if (!Array.isArray(parsed)) throw new Error("not_array");
        approvals = parsed as CatalogImportProductLineApproval[];
      } catch {
        throw new HttpError(400, "import_invalid_structure_approvals", "Las autorizaciones de líneas no son válidas.");
      }
    }
    const workbook = await parseCatalogImportXlsx(file);
    return ok(await commitCatalogImport(supabase, user.id, workbook, expectedSha256, approvals, confirmation));
  } catch (error) {
    return handleApiError(error);
  }
}
