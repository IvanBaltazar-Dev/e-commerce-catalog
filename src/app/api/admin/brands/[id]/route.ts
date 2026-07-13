import { handleApiError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { hideTaxonomy, updateTaxonomy } from "@/lib/catalog/taxonomy-service";
import { taxonomyUpdateSchema, uuidSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function brandId(context: RouteContext) {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const id = await brandId(context);
    const input = await readJson(request, taxonomyUpdateSchema);
    const { supabase } = await requireAdmin();
    const brand = await updateTaxonomy(supabase, "brands", id, input);

    return ok(brand);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const id = await brandId(context);
    const { supabase } = await requireAdmin();
    const brand = await hideTaxonomy(supabase, "brands", id);

    return ok(brand);
  } catch (error) {
    return handleApiError(error);
  }
}
