import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { markFulfillmentSchema, type Sale } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mover el pedido por sus estados de entrega.
 *
 * No toca el cobro, y esa es toda la gracia: se puede entregar sin haber
 * cobrado —contra entrega— y cobrar sin haber entregado. Qué transiciones valen
 * lo decide `mark_sale_fulfillment` en PostgreSQL, para que un script o el
 * asistente choquen con la misma regla que la pantalla.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, markFulfillmentSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("mark_sale_fulfillment", {
      p_sale_id: id,
      p_status: input.status,
      p_note: input.note ?? null
    });

    if (error) throw new HttpError(400, "sale_fulfillment_failed", error.message);

    return ok(data as Sale);
  } catch (error) {
    return handleApiError(error);
  }
}
