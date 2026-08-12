import { handleApiError, HttpError, ok } from "@/lib/api/http";
import {
  getCatalogReviewBootstrap,
  getNextCatalogReviewCase,
  listCatalogReviewCases,
} from "@/lib/admin/catalog-review-service";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const search = new URL(request.url).searchParams;
    const mode = search.get("mode") ?? "bootstrap";

    if (mode === "bootstrap") return ok(await getCatalogReviewBootstrap(supabase));

    if (mode === "next") {
      const excludeIds = (search.get("exclude") ?? "")
        .split(",")
        .filter(Boolean);
      if (excludeIds.some((id) => !UUID.test(id)) || excludeIds.length > 100) {
        throw new HttpError(400, "catalog_review_exclusions_invalid", "La lista de casos omitidos no es válida.");
      }
      return ok({ nextCase: await getNextCatalogReviewCase(supabase, excludeIds) });
    }

    if (mode === "list") {
      const rawLimit = Number(search.get("limit") ?? 25);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
        throw new HttpError(400, "catalog_review_limit_invalid", "El límite debe estar entre 1 y 50.");
      }
      return ok(await listCatalogReviewCases(supabase, {
        queueState: search.get("state") ?? undefined,
        workKind: search.get("kind") ?? undefined,
        purpose: search.get("purpose") ?? undefined,
        cursor: search.get("cursor"),
        limit: rawLimit,
      }));
    }

    throw new HttpError(400, "catalog_review_mode_invalid", "La operación de lectura no existe.");
  } catch (error) {
    return handleApiError(error);
  }
}
