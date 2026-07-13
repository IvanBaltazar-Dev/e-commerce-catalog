import { handleApiError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { getProductById, hideProduct, updateProduct } from "@/lib/catalog/product-service";
import { productUpdateSchema, uuidSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function productId(context: RouteContext) {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const id = await productId(context);
    const { supabase } = await requireAdmin();
    const product = await getProductById(supabase, id);

    return ok(product);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const id = await productId(context);
    const input = await readJson(request, productUpdateSchema);
    const { supabase } = await requireAdmin();
    const product = await updateProduct(supabase, id, input);

    return ok(product);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const id = await productId(context);
    const { supabase } = await requireAdmin();
    const product = await hideProduct(supabase, id);

    return ok(product);
  } catch (error) {
    return handleApiError(error);
  }
}
