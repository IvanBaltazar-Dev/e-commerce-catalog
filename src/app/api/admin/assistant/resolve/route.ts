import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { resolveInteractionSchema } from "@/lib/ai/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * El cierre humano de una asistencia: confirmarla (enlazando lo que la
 * persona ejecutó por el Bloque 2) o descartarla. La base garantiza que esta
 * llamada no crea nada comercial — es la regla 9 hecha contrato.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const input = await readJson(request, resolveInteractionSchema);

    const { data, error } = await supabase.rpc("resolve_ai_interaction", {
      p_interaction_id: input.interactionId,
      p_status: input.estado,
      p_sale_id: input.saleId ?? null,
      p_reservation_id: input.reservationId ?? null,
      p_note: input.nota ?? null
    });

    if (error) throw new HttpError(400, "interaction_resolve_failed", error.message);

    return ok(data as { id: string; status: string });
  } catch (error) {
    return handleApiError(error);
  }
}
