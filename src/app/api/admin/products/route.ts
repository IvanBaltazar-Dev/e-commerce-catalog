import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok, readJson, created } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { createProduct, PRODUCT_SELECT } from "@/lib/catalog/product-service";
import { paginationSchema, productCreateSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const adminProductQuerySchema = paginationSchema.extend({
  active: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional()
});

function parseSearchParams(request: NextRequest) {
  return adminProductQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
}

export async function GET(request: NextRequest) {
  try {
    const params = parseSearchParams(request);
    const { supabase } = await requireAdmin();
    let query = supabase
      .from("products")
      .select(PRODUCT_SELECT)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .range(params.offset, params.offset + params.limit - 1);

    if (params.q) {
      const pattern = `%${params.q.replace(/[%_,]/g, "")}%`;
      query = query.or(`name.ilike.${pattern},code.ilike.${pattern},product_type.ilike.${pattern}`);
    }

    if (params.active !== undefined) {
      query = query.eq("is_active", params.active);
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

export async function POST(request: Request) {
  try {
    const input = await readJson(request, productCreateSchema);
    const { supabase } = await requireAdmin();
    const product = await createProduct(supabase, input);

    return created(product);
  } catch (error) {
    return handleApiError(error);
  }
}
