import { handleApiError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { hideTaxonomy, updateTaxonomy } from "@/lib/catalog/taxonomy-service";
import { taxonomyUpdateSchema, uuidSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function categoryId(context: RouteContext) {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { supabase } = await requireAdmin();
    const id = await categoryId(context);
    const input = await readJson(request, taxonomyUpdateSchema);
    const category = await updateTaxonomy(supabase, "categories", id, input);

    return ok(category);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { supabase } = await requireAdmin();
    const id = await categoryId(context);
    const category = await hideTaxonomy(supabase, "categories", id);

    return ok(category);
  } catch (error) {
    return handleApiError(error);
  }
}
