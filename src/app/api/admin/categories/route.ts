import { handleApiError, ok, readJson, created } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { createTaxonomy } from "@/lib/catalog/taxonomy-service";
import { taxonomyCreateSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase
      .from("categories")
      .select("id, name, slug, description, is_active, sort_order, created_at, updated_at")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      throw error;
    }

    return ok({ items: data ?? [] });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, taxonomyCreateSchema);
    const category = await createTaxonomy(supabase, "categories", input);

    return created(category);
  } catch (error) {
    return handleApiError(error);
  }
}
