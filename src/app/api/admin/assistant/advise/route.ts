import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { adviseInputSchema } from "@/lib/ai/contracts";
import { advise } from "@/lib/ai/advisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * El Asesor Bellaroshé para el personal: produce un BORRADOR de respuesta y
 * recomendaciones de productos reales. La vendedora decide si lo envía — el
 * asesor jamás escribe directo a la clienta ni confirma nada (regla 9).
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const input = await readJson(request, adviseInputSchema);

    const result = await advise(supabase, {
      pregunta: input.pregunta,
      contexto: input.contexto ?? null
    });

    const { data: interactionId, error } = await supabase.rpc("record_ai_interaction", {
      p_kind: "advisor",
      p_input_summary: input.pregunta.slice(0, 300),
      p_proposal: {
        respuesta: result.respuesta,
        recomendaciones: result.recomendaciones
      },
      p_model: result.proveedor.modelo,
      p_provider_status: result.proveedor.estado,
      p_latency_ms: result.proveedor.latenciaMs,
      p_error_message: null,
      p_branch_id: null,
      p_conversation_id: input.conversacionId ?? null
    });

    if (error) throw new HttpError(400, "interaction_record_failed", error.message);

    return ok({
      interactionId: interactionId as string,
      respuesta: result.respuesta,
      recomendaciones: result.recomendaciones,
      proveedor: result.proveedor
    });
  } catch (error) {
    return handleApiError(error);
  }
}
