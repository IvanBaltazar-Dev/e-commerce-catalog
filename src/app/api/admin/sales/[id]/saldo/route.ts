import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { settleSaleBalanceSchema, type Sale } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cobrar el saldo de una venta contra entrega, cuando la clienta lo recibe.
 *
 * No toca la caja: el disparador del cajón (0034) mete cada pago en la sesión
 * abierta de su sede el día en que se recibe. El dinero entra el día que entra,
 * no el día en que se despachó el pedido.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, settleSaleBalanceSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("settle_sale_balance", {
      p_sale_id: id,
      p_payments: input.payments,
      p_client_operation_id: input.clientOperationId
    });

    if (error) throw new HttpError(400, "sale_settle_failed", error.message);

    return ok(data as Sale);
  } catch (error) {
    return handleApiError(error);
  }
}
