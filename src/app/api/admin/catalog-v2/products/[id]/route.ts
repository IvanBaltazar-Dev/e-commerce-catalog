import { handleApiError, ok, readJson } from "@/lib/api/http";
import { getCatalogV2Product, saveCatalogV2Product } from "@/lib/admin/catalog-v2-service";
import { requireAdmin } from "@/lib/auth/admin";
import { adminV2ProductSchema, uuidSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function idFrom(context: Context) {
  return uuidSchema.parse((await context.params).id);
}

export async function GET(_request: Request, context: Context) {
  try {
    const { supabase } = await requireAdmin();
    return ok(await getCatalogV2Product(supabase, await idFrom(context)));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, adminV2ProductSchema);
    return ok(await saveCatalogV2Product(supabase, input, await idFrom(context)));
  } catch (error) {
    return handleApiError(error);
  }
}
