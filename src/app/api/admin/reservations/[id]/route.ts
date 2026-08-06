import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { releaseReservationSchema, type Reservation } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireStaff();
    const { data, error } = await supabase.rpc("reservation_detail", { p_reservation_id: id });

    if (error) throw new HttpError(400, "reservation_detail_failed", error.message);
    if (!data) throw new HttpError(404, "reservation_not_found", "La reserva no existe o no pertenece a tus sedes.");

    return ok(data as Reservation);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Liberación manual. El vencimiento automático usa el mismo contrato con estado
 * `expired`, y libera `reserved` sin tocar `on_hand`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, releaseReservationSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("release_reservation", {
      p_reservation_id: id,
      p_reason: input.reason,
      p_status: input.status
    });

    if (error) throw new HttpError(400, "reservation_release_failed", error.message);

    return ok(data as Reservation);
  } catch (error) {
    return handleApiError(error);
  }
}
