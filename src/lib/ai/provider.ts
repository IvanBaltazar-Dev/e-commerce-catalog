import "server-only";

import Anthropic from "@anthropic-ai/sdk";
// El helper del SDK exige la API v4 de zod (subpath de zod ≥3.25). Solo la
// capa IA la usa; el resto del proyecto sigue en la clásica.
import type { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { serverEnv } from "@/lib/env/server";

/**
 * El único punto de contacto con el proveedor de IA. Todo lo demás del
 * Bloque 4 pasa por aquí, y por eso la regla 10 se cumple en un solo lugar:
 * sin credencial no hay excepción, hay un resultado 'unavailable' que las
 * capas de arriba convierten en camino determinista o en un «no disponible»
 * honesto. La clave jamás sale de este módulo ni entra en un log.
 */

export const AI_MODEL = "claude-opus-5";

let client: Anthropic | null = null;

export function isAiConfigured(): boolean {
  return Boolean(serverEnv.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY });
  }
  return client;
}

export type AiContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
    };

export type AiStructuredResult<T> =
  | { ok: true; data: T; latencyMs: number }
  | { ok: false; reason: "unavailable" | "refusal" | "error"; message: string; latencyMs: number };

/**
 * Una llamada estructurada: el esquema zod ES el contrato de salida, así que
 * lo que vuelve o valida o falla — nunca un JSON a medio parsear.
 */
export async function runStructured<Schema extends z.ZodType>(
  options: {
    system: string;
    content: AiContentBlock[];
    schema: Schema;
    maxTokens?: number;
  }
): Promise<AiStructuredResult<z.infer<Schema>>> {
  const startedAt = Date.now();

  if (!isAiConfigured()) {
    return {
      ok: false,
      reason: "unavailable",
      message: "Sin credencial de IA configurada (ANTHROPIC_API_KEY).",
      latencyMs: 0
    };
  }

  try {
    const response = await getClient().messages.parse({
      model: AI_MODEL,
      max_tokens: options.maxTokens ?? 2048,
      system: options.system,
      messages: [{ role: "user", content: options.content }],
      output_config: { format: zodOutputFormat(options.schema) }
    });

    const latencyMs = Date.now() - startedAt;

    if (response.stop_reason === "refusal") {
      return {
        ok: false,
        reason: "refusal",
        message: "El proveedor declinó la solicitud.",
        latencyMs
      };
    }

    if (response.parsed_output == null) {
      return {
        ok: false,
        reason: "error",
        message: "La respuesta no cumplió el esquema esperado.",
        latencyMs
      };
    }

    return { ok: true, data: response.parsed_output, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Anthropic.APIError
        ? `API ${error.status ?? "?"}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Fallo desconocido del proveedor.";
    return { ok: false, reason: "error", message, latencyMs };
  }
}
