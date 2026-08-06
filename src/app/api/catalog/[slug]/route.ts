import { handleApiError, HttpError, ok } from "@/lib/api/http";
import type { CatalogProductDetail } from "@/lib/catalog/contracts";
import { slugSchema } from "@/lib/catalog/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const safeSlug = slugSchema.parse(slug);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("catalog_product_detail_v2", {
      p_slug: safeSlug
    });

    if (error) {
      throw error;
    }

    if (!data) {
      throw new HttpError(404, "product_not_found", "Product not found.");
    }

    return ok(data as CatalogProductDetail);
  } catch (error) {
    return handleApiError(error);
  }
}
