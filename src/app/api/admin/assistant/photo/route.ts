import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { photoInputSchema } from "@/lib/ai/contracts";
import { identifyProductsInPhoto } from "@/lib/ai/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reconocimiento fotográfico por etapas. Sin credencial de IA la respuesta es
 * un «no disponible» honesto que queda registrado como fallo (regla 10) — la
 * pantalla lo muestra y la operación sigue por registro manual.
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const input = await readJson(request, photoInputSchema);

    const result = await identifyProductsInPhoto(supabase, {
      imageBase64: input.imagenBase64,
      mediaType: input.mediaType,
      stage: input.etapa
    });

    const summary = `Foto (${input.etapa === "single" ? "un producto" : "grupo pequeño"})`;

    const { data: interactionId, error } = await supabase.rpc("record_ai_interaction", {
      p_kind: "photo_recognition",
      p_input_summary: summary,
      p_proposal:
        result.estado === "ok"
          ? { candidatos: result.candidatos, advertencias: result.advertencias }
          : {},
      p_model: result.estado === "ok" ? result.modelo : null,
      p_provider_status: result.estado === "ok" ? "ok" : "unavailable",
      p_latency_ms: result.latenciaMs,
      p_error_message: result.estado === "ok" ? null : result.detalle,
      p_branch_id: null,
      p_conversation_id: null
    });

    if (error) throw new HttpError(400, "interaction_record_failed", error.message);

    return ok({ interactionId: interactionId as string, resultado: result });
  } catch (error) {
    return handleApiError(error);
  }
}
