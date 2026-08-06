import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { updateAdminOrderSchema, type AdminOrderStatus } from "@/lib/admin/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new HttpError(400, "invalid_order_id", "El pedido indicado no es válido.");
    }

    const input = await readJson(request, updateAdminOrderSchema);
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase
      .from("orders")
      .update({ status: input.status })
      .eq("id", id)
      .select("id, status, updated_at")
      .maybeSingle();

    if (error) throw new HttpError(400, "order_update_failed", error.message);
    if (!data) throw new HttpError(404, "order_not_found", "No se encontró el pedido.");

    return ok({
      id: data.id,
      status: data.status as AdminOrderStatus,
      updatedAt: data.updated_at as string
    });
  } catch (error) {
    return handleApiError(error);
  }
}
