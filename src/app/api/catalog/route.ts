import { NextRequest } from "next/server";
import { handleApiError, HttpError, ok } from "@/lib/api/http";
import type { CatalogListResponse } from "@/lib/catalog/contracts";
import { catalogV2QuerySchema } from "@/lib/catalog/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseSearchParams(request: NextRequest) {
  const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
  return catalogV2QuerySchema.parse({
    ...raw,
    search: raw.search ?? raw.q
  });
}

export async function GET(request: NextRequest) {
  try {
    const params = parseSearchParams(request);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("catalog_list_v2", {
      p_page: params.page,
      p_page_size: params.page_size,
      p_search: params.search ?? null,
      p_brand_slug: params.brand ?? null,
      p_category_path: params.category ?? null,
      p_availability: params.availability ?? null,
      p_attribute_filters: params.attributes ?? {},
      p_sort: params.sort
    });

    if (error) {
      throw new HttpError(400, "catalog_query_failed", error.message);
    }

    return ok(data as CatalogListResponse);
  } catch (error) {
    return handleApiError(error);
  }
}
