import "server-only";

import { z } from "zod/v4";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMatchingCatalog } from "@/lib/ai/catalog";
import {
  interpretOrderItems,
  interpretOrderText,
  segmentOrder,
  type OrderProposal
} from "@/lib/ai/matching";
import { AI_MODEL, isAiConfigured, runStructured } from "@/lib/ai/provider";

/**
 * Registro por audio (Bloque 4): el dictado ya transcrito llega como texto y
 * sale como PROPUESTA de carrito con ambigüedades declaradas. El LLM solo
 * segmenta el habla («ponme dos rojos de masglo y el kit para principiante»
 * → ítems con cantidad); las coincidencias las decide SIEMPRE el matching
 * determinista contra el catálogo real. Sin credencial, la segmentación
 * simple hace el trabajo: degradado, jamás detenido (regla 10).
 */

const segmentationSchema = z.object({
  items: z
    .array(
      z.object({
        cantidad: z.number().int().min(1).max(999),
        descripcion: z.string().min(1)
      })
    )
    .max(20)
});

const SEGMENTATION_SYSTEM = [
  "Eres la asistente de registro de pedidos de Bellaroshé, una tienda de productos de belleza en Lima.",
  "Recibes el dictado LITERAL de una vendedora y lo partes en ítems de pedido.",
  "Cada ítem lleva cantidad (por defecto 1) y la descripción del producto tal como se dijo.",
  "No inventes productos, no corrijas nombres, no agregues ítems que no se dictaron.",
  "Ignora muletillas y saludos. Si el texto no contiene ningún pedido, devuelve items vacío."
].join(" ");

export type InterpreterResult = {
  propuesta: OrderProposal;
  proveedor: {
    estado: "ok" | "degraded";
    modelo: string | null;
    latenciaMs: number | null;
    detalle: string | null;
  };
};

export async function interpretOrder(
  supabase: SupabaseClient,
  texto: string
): Promise<InterpreterResult> {
  const catalog = await loadMatchingCatalog(supabase);

  if (isAiConfigured()) {
    const result = await runStructured({
      system: SEGMENTATION_SYSTEM,
      content: [{ type: "text", text: `Dictado: «${texto}»` }],
      schema: segmentationSchema,
      maxTokens: 1024
    });

    if (result.ok) {
      const items = result.data.items.length > 0 ? result.data.items : segmentOrder(texto);
      return {
        propuesta: interpretOrderItems(items, catalog),
        proveedor: {
          estado: "ok",
          modelo: AI_MODEL,
          latenciaMs: result.latencyMs,
          detalle: null
        }
      };
    }

    // El proveedor falló o declinó: el camino determinista responde igual.
    return {
      propuesta: interpretOrderText(texto, catalog),
      proveedor: {
        estado: "degraded",
        modelo: null,
        latenciaMs: result.latencyMs,
        detalle: result.message
      }
    };
  }

  return {
    propuesta: interpretOrderText(texto, catalog),
    proveedor: {
      estado: "degraded",
      modelo: null,
      latenciaMs: null,
      detalle: "Sin credencial de IA: interpretación determinista."
    }
  };
}
