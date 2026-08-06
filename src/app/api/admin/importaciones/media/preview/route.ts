import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { analyzeCatalogMediaPackage } from "@/lib/admin/catalog-media-service";
import { parseCatalogMediaZip } from "@/lib/admin/catalog-media-zip";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = 34 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const { supabase } = await requireCatalogImportDeveloper();
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_MULTIPART_BYTES) throw new HttpError(413, "media_request_too_large", "La solicitud supera 34 MB.");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "invalid_media_form", "La solicitud debe incluir un archivo ZIP.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "media_file_required", "Selecciona un paquete .zip.");
    const mediaPackage = await parseCatalogMediaZip(file);
    return ok(await analyzeCatalogMediaPackage(supabase, mediaPackage));
  } catch (error) {
    return handleApiError(error);
  }
}
