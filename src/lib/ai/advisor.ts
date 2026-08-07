import "server-only";

import { z } from "zod/v4";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMatchingCatalog } from "@/lib/ai/catalog";
import { matchCandidates, displayName, type CatalogEntry } from "@/lib/ai/matching";
import { AI_MODEL, isAiConfigured, runStructured } from "@/lib/ai/provider";

/**
 * El Asesor Bellaroshé: UN núcleo para todos los canales (§ del plan). Hoy lo
 * consume la vendedora desde la conversación y el asistente; mañana el mismo
 * módulo puede responder detrás de web o WhatsApp sin tocar nada, porque no
 * sabe desde dónde lo llaman.
 *
 * Dos barreras estructurales:
 *   · Solo recomienda productos REALES y disponibles: el prompt recibe la
 *     lista cerrada del catálogo y toda recomendación devuelta se valida
 *     contra ella — un id inventado se descarta y queda anotado.
 *   · Jamás confirma nada (regla 9): produce texto y sugerencias; vender es
 *     de las personas y del Bloque 2.
 */

const adviceSchema = z.object({
  respuesta: z.string().min(1),
  recomendaciones: z
    .array(
      z.object({
        variantId: z.string(),
        razon: z.string().min(1)
      })
    )
    .max(5)
});

function advisorSystem(catalog: CatalogEntry[]): string {
  const lines = catalog
    .slice(0, 250)
    .map(
      (entry) =>
        `- id:${entry.variantId} | ${displayName(entry)}${entry.brandName ? ` | marca ${entry.brandName}` : ""}${entry.categoryName ? ` | ${entry.categoryName}` : ""}`
    )
    .join("\n");

  return [
    "Eres la asesora experta de Bellaroshé, tienda peruana de productos de belleza (uñas, pestañas, cuidado).",
    "Atiendes con calidez y claridad, en español de Perú, sin tecnicismos innecesarios.",
    "Recomienda ÚNICAMENTE productos de la lista siguiente, citando su id exacto.",
    "Si nada de la lista responde bien la consulta, dilo con honestidad y no recomiendes nada.",
    "Explica diferencias (esmalte clásico vs semipermanente, qué necesita lámpara), qué es obligatorio y qué opcional, y adapta a nivel principiante o profesional y al presupuesto si lo mencionan.",
    "NUNCA confirmes una venta, ni prometas stock ni precios: eso lo hace el personal con el sistema.",
    "",
    "Catálogo disponible:",
    lines
  ].join("\n");
}

export type AdvisorResult = {
  respuesta: string;
  recomendaciones: { variantId: string; sku: string | null; nombre: string; razon: string }[];
  proveedor: {
    estado: "ok" | "degraded";
    modelo: string | null;
    latenciaMs: number | null;
    detalle: string | null;
  };
};

/** Fallback determinista: coincidencias por palabras clave, sin prosa fingida. */
function deterministicAdvice(question: string, catalog: CatalogEntry[]): AdvisorResult {
  const matches = matchCandidates(question, catalog).slice(0, 3);
  const recomendaciones = matches.map((match) => ({
    variantId: match.entry.variantId,
    sku: match.entry.sku,
    nombre: displayName(match.entry),
    razon: "Coincide con lo que buscas en el catálogo."
  }));

  return {
    respuesta:
      recomendaciones.length > 0
        ? "La asesora inteligente no está disponible ahora; estas son las coincidencias directas del catálogo para tu consulta."
        : "La asesora inteligente no está disponible ahora y no encontré coincidencias directas en el catálogo. Intenta con otras palabras o revisa el catálogo completo.",
    recomendaciones,
    proveedor: {
      estado: "degraded",
      modelo: null,
      latenciaMs: null,
      detalle: "Respuesta determinista por palabras clave."
    }
  };
}

export async function advise(
  supabase: SupabaseClient,
  options: { pregunta: string; contexto?: string | null }
): Promise<AdvisorResult> {
  const catalog = await loadMatchingCatalog(supabase, { onlyAvailable: true });

  if (!isAiConfigured()) {
    return deterministicAdvice(options.pregunta, catalog);
  }

  const content = [
    options.contexto
      ? { type: "text" as const, text: `Contexto de la conversación:\n${options.contexto}` }
      : null,
    { type: "text" as const, text: `Consulta de la clienta: «${options.pregunta}»` }
  ].filter((block): block is { type: "text"; text: string } => block != null);

  const result = await runStructured({
    system: advisorSystem(catalog),
    content,
    schema: adviceSchema,
    maxTokens: 2048
  });

  if (!result.ok) {
    const fallback = deterministicAdvice(options.pregunta, catalog);
    fallback.proveedor.detalle = result.message;
    fallback.proveedor.latenciaMs = result.latencyMs;
    return fallback;
  }

  // La lista cerrada manda: un id fuera del catálogo se descarta, no se cuela.
  const byId = new Map(catalog.map((entry) => [entry.variantId, entry]));
  const valid = result.data.recomendaciones.flatMap((rec) => {
    const entry = byId.get(rec.variantId);
    return entry
      ? [{ variantId: entry.variantId, sku: entry.sku, nombre: displayName(entry), razon: rec.razon }]
      : [];
  });
  const dropped = result.data.recomendaciones.length - valid.length;

  return {
    respuesta: result.data.respuesta,
    recomendaciones: valid,
    proveedor: {
      estado: "ok",
      modelo: AI_MODEL,
      latenciaMs: result.latencyMs,
      detalle: dropped > 0 ? `${dropped} recomendación(es) fuera del catálogo, descartadas.` : null
    }
  };
}
