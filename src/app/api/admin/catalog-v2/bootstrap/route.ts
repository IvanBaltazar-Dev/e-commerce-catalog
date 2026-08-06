import { handleApiError, ok } from "@/lib/api/http";
import { getCatalogV2Bootstrap } from "@/lib/admin/catalog-v2-service";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    return ok(await getCatalogV2Bootstrap(supabase));
  } catch (error) {
    return handleApiError(error);
  }
}
