import { readFile } from "node:fs/promises";
import path from "node:path";
import { handleApiError, HttpError } from "@/lib/api/http";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEMPLATE_PATH = path.join(
  process.cwd(),
  "assets",
  "import",
  "plantilla_importacion_productos.xlsx"
);

export async function GET() {
  try {
    await requireCatalogImportDeveloper();
    let body: Buffer;
    try {
      body = await readFile(TEMPLATE_PATH);
    } catch {
      throw new HttpError(404, "catalog_import_template_missing", "La plantilla de importación no está disponible.");
    }
    const responseBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(responseBody, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": "attachment; filename=plantilla_importacion_productos.xlsx",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    return handleApiError(error);
  }
}
