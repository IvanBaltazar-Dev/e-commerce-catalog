import { z } from "zod";

/**
 * Contratos de entrada de la asistencia IA. Viven aparte para que las rutas
 * y las pantallas compartan exactamente el mismo idioma.
 */

export const interpretOrderInputSchema = z.object({
  texto: z.string().trim().min(2).max(2000),
  sedeId: z.string().uuid().nullish()
});

export const photoInputSchema = z.object({
  // Base64 SIN prefijo data: — el mediaType viaja aparte. ~4 MB de imagen.
  imagenBase64: z.string().min(100).max(6_000_000),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  etapa: z.enum(["single", "small_group"]).default("single")
});

export const adviseInputSchema = z.object({
  pregunta: z.string().trim().min(3).max(1500),
  conversacionId: z.string().uuid().nullish(),
  contexto: z.string().trim().max(4000).nullish()
});

export const resolveInteractionSchema = z.object({
  interactionId: z.string().uuid(),
  estado: z.enum(["confirmed", "discarded"]),
  saleId: z.string().uuid().nullish(),
  reservationId: z.string().uuid().nullish(),
  nota: z.string().trim().max(500).nullish()
});

export const trendActionSchema = z.object({
  proposalId: z.string().uuid(),
  accion: z.enum(["approved", "rejected", "published"]),
  nota: z.string().trim().max(500).nullish()
});

/** Lo que las pantallas reciben de vuelta. */
export type AiProviderInfo = {
  estado: "ok" | "degraded" | "unavailable";
  modelo: string | null;
  latenciaMs: number | null;
  detalle: string | null;
};

export type ContentProposalRow = {
  id: string;
  titulo: string;
  cuerpo: string;
  estado: "draft" | "approved" | "rejected" | "published";
  creadaEl: string;
  revisadaEl: string | null;
  notaRevision: string | null;
  publicadaEl: string | null;
};
