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
    .optional(),
  // Estado editorial real: con 1,056 productos importados en borrador, un
  // filtro por is_active etiquetado «Publicado» mentía.
  estado: z.enum(["publicado", "borrador", "oculto"]).optional(),
  brandId: z.string().uuid().optional()
});

function parseSearchParams(request: NextRequest) {
  return adminProductQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireAdmin();
    const params = parseSearchParams(request);
    let query = supabase
      .from("products")
      .select(PRODUCT_SELECT, { count: "exact" })
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

    if (params.estado === "publicado") {
      query = query.eq("editorial_status", "published").eq("is_active", true);
    } else if (params.estado === "borrador") {
      query = query.in("editorial_status", ["draft", "in_review", "incomplete"]).eq("is_active", true);
    } else if (params.estado === "oculto") {
      query = query.or("editorial_status.eq.hidden,is_active.eq.false");
    }

    if (params.brandId) {
      query = query.eq("brand_id", params.brandId);
    }

    const { data, error, count } = await query;

    if (error) {
      throw error;
    }

    return ok({
      items: data ?? [],
      total: count ?? 0,
      limit: params.limit,
      offset: params.offset
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, productCreateSchema);
    const product = await createProduct(supabase, input);

    return created(product);
  } catch (error) {
    return handleApiError(error);
  }
}
