import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import type { PurchaseOrder } from "@/lib/admin/purchasing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detalle con las unidades ya recibidas por línea, derivadas de las recepciones
 * confirmadas. Es lo que permite ver el faltante sin guardarlo en ninguna parte.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase.rpc("purchase_order_detail", { p_id: id });

    if (error) throw new HttpError(400, "purchase_order_detail_failed", error.message);
    if (!data) throw new HttpError(404, "purchase_order_not_found", "La orden no existe.");

    return ok(data as PurchaseOrder);
  } catch (error) {
    return handleApiError(error);
  }
}
