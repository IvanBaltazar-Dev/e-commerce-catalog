import { created, handleApiError, readJson } from "@/lib/api/http";
import { saveCatalogV2Product } from "@/lib/admin/catalog-v2-service";
import { requireAdmin } from "@/lib/auth/admin";
import { adminV2ProductSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, adminV2ProductSchema);
    return created(await saveCatalogV2Product(supabase, input));
  } catch (error) {
    return handleApiError(error);
  }
}
