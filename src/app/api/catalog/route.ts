import { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/http";
import { PRODUCT_SELECT } from "@/lib/catalog/product-service";
import { paginationSchema } from "@/lib/catalog/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseSearchParams(request: NextRequest) {
  return paginationSchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
}

function searchPattern(value: string) {
  return `%${value.replace(/[%_,]/g, "")}%`;
}

async function slugToId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  table: "brands" | "categories",
  slug?: string
) {
  if (!slug) {
    return undefined;
  }

  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const params = parseSearchParams(request);
    const supabase = await createSupabaseServerClient();
    const [brandId, categoryId] = await Promise.all([
      slugToId(supabase, "brands", params.brand),
      slugToId(supabase, "categories", params.category)
    ]);

    if (brandId === null || categoryId === null) {
      return ok({
        items: [],
        limit: params.limit,
        offset: params.offset
      });
    }

    let query = supabase
      .from("products")
      .select(PRODUCT_SELECT)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .range(params.offset, params.offset + params.limit - 1);

    if (brandId) {
      query = query.eq("brand_id", brandId);
    }

    if (categoryId) {
      query = query.eq("category_id", categoryId);
    }

    if (params.q) {
      const pattern = searchPattern(params.q);
      query = query.or(`name.ilike.${pattern},code.ilike.${pattern},product_type.ilike.${pattern}`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return ok({
      items: data ?? [],
      limit: params.limit,
      offset: params.offset
    });
  } catch (error) {
    return handleApiError(error);
  }
}
