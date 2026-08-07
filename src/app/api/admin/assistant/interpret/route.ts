import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { interpretOrderInputSchema } from "@/lib/ai/contracts";
import { interpretOrder } from "@/lib/ai/interpreter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Registro por audio: el dictado (ya transcrito por el navegador) se vuelve
 * PROPUESTA de carrito con ambigüedades declaradas. Aquí no se vende nada:
 * la propuesta queda en evidencia (0044) y la venta la registra una persona
 * por los contratos del Bloque 2 cuando confirme.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const input = await readJson(request, interpretOrderInputSchema);

    const result = await interpretOrder(supabase, input.texto);

    const { data: interactionId, error } = await supabase.rpc("record_ai_interaction", {
      p_kind: "audio_order",
      p_input_summary: input.texto.slice(0, 300),
      p_proposal: result.propuesta,
      p_model: result.proveedor.modelo,
      p_provider_status: result.proveedor.estado,
      p_latency_ms: result.proveedor.latenciaMs,
      p_error_message: null,
      p_branch_id: input.sedeId ?? null,
      p_conversation_id: null
    });

    if (error) throw new HttpError(400, "interaction_record_failed", error.message);

    return ok({
      interactionId: interactionId as string,
      propuesta: result.propuesta,
      proveedor: result.proveedor
    });
  } catch (error) {
    return handleApiError(error);
  }
}
