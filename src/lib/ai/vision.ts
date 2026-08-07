import "server-only";

import { z } from "zod/v4";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMatchingCatalog } from "@/lib/ai/catalog";
import { matchCandidates, displayName } from "@/lib/ai/matching";
import { AI_MODEL, runStructured, isAiConfigured, type AiContentBlock } from "@/lib/ai/provider";

/**
 * Reconocimiento fotográfico POR ETAPAS, como manda el plan: primero un
 * producto, luego grupos pequeños. Nadie promete identificar 40 esmaltes de
 * una foto — la etapa limita cuántos ítems puede devolver el modelo y el
 * prompt le exige ceñirse a lo VISIBLE (texto de etiquetas, marca impresa).
 * Los candidatos finales salen del matching determinista contra el catálogo
 * real: la visión describe, el catálogo decide qué existe.
 *
 * Sin credencial no hay visión que valga: el resultado es un «no disponible»
 * explícito (regla 10) y la operación sigue por registro manual.
 */

export type VisionStage = "single" | "small_group";

const STAGE_LIMITS: Record<VisionStage, number> = {
  single: 1,
  small_group: 6
};

const identificationSchema = z.object({
  items: z
    .array(
      z.object({
        descripcion: z.string().min(1),
        textoVisible: z.string().nullable(),
        marcaVisible: z.string().nullable(),
        confianza: z.number().min(0).max(1)
      })
    )
    .max(6),
  advertencias: z.array(z.string()).max(4)
});

function visionSystem(limit: number): string {
  return [
    "Eres la asistente de identificación de productos de Bellaroshé (productos de belleza: esmaltes, geles, kits, pestañas).",
    `Describe como máximo ${limit} producto(s) claramente visibles en la foto.`,
    "Para cada uno: una descripción corta y buscable (tipo de producto + color/tono aparente), el texto legible de su etiqueta si existe, y la marca solo si se LEE en el envase.",
    "Sé honesta con la confianza: si el tono exacto no se distingue, dilo en la descripción con un término general (ej. «esmalte rojo») y baja la confianza.",
    "No adivines códigos ni nombres comerciales que no estén impresos. Si hay más productos que el máximo, agrégalo a advertencias."
  ].join(" ");
}

export type VisionCandidate = {
  descripcion: string;
  textoVisible: string | null;
  marcaVisible: string | null;
  confianza: number;
  opciones: { variantId: string; sku: string | null; nombre: string; score: number }[];
};

export type VisionResult =
  | {
      estado: "ok";
      candidatos: VisionCandidate[];
      advertencias: string[];
      modelo: string;
      latenciaMs: number;
    }
  | { estado: "unavailable" | "refusal" | "error"; detalle: string; latenciaMs: number };

export async function identifyProductsInPhoto(
  supabase: SupabaseClient,
  options: {
    imageBase64: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
    stage: VisionStage;
  }
): Promise<VisionResult> {
  if (!isAiConfigured()) {
    return {
      estado: "unavailable",
      detalle: "El reconocimiento fotográfico necesita la credencial de IA; registra el producto manualmente.",
      latenciaMs: 0
    };
  }

  const limit = STAGE_LIMITS[options.stage];
  const content: AiContentBlock[] = [
    {
      type: "image",
      source: { type: "base64", media_type: options.mediaType, data: options.imageBase64 }
    },
    {
      type: "text",
      text:
        options.stage === "single"
          ? "Identifica el producto de la foto."
          : "Identifica los productos del grupo (máximo 6)."
    }
  ];

  const result = await runStructured({
    system: visionSystem(limit),
    content,
    schema: identificationSchema,
    maxTokens: 2048
  });

  if (!result.ok) {
    return { estado: result.reason, detalle: result.message, latenciaMs: result.latencyMs };
  }

  const catalog = await loadMatchingCatalog(supabase);

  const candidatos: VisionCandidate[] = result.data.items.slice(0, limit).map((item) => {
    const query = [item.marcaVisible, item.descripcion, item.textoVisible]
      .filter(Boolean)
      .join(" ");
    return {
      descripcion: item.descripcion,
      textoVisible: item.textoVisible,
      marcaVisible: item.marcaVisible,
      confianza: item.confianza,
      opciones: matchCandidates(query, catalog)
        .slice(0, 3)
        .map((match) => ({
          variantId: match.entry.variantId,
          sku: match.entry.sku,
          nombre: displayName(match.entry),
          score: match.score
        }))
    };
  });

  const advertencias = [...result.data.advertencias];
  if (options.stage === "small_group") {
    advertencias.push(
      "Identificación por grupo pequeño: confirma cada coincidencia antes de usarla. Para bandejas grandes usa códigos o dictado."
    );
  }

  return {
    estado: "ok",
    candidatos,
    advertencias,
    modelo: AI_MODEL,
    latenciaMs: result.latencyMs
  };
}
