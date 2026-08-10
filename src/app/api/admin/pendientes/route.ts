import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { PendingOperations } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lo que queda por hacer: reservas vivas, pedidos por entregar y ventas por
 * cobrar.
 *
 * El saldo NO se calcula aquí. Lo resuelve `pending_operations` en PostgreSQL,
 * que es la misma definición que usa el detalle de la venta: si esta ruta
 * restara pagos contra el total por su cuenta, habría dos aritméticas del mismo
 * dinero esperando a discrepar.
 *
 * La RLS de `sales` y `reservations` ya recorta por las sedes de quien
 * consulta, así que aquí no se filtra por sede ni se puede olvidar hacerlo.
 */
export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("pending_operations");
    if (error) throw new HttpError(400, "pending_operations_failed", error.message);

    return ok(data as PendingOperations);
  } catch (error) {
    return handleApiError(error);
  }
}
