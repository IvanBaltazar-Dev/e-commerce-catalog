import "server-only";

/**
 * Contrato interno de los canales (Bloque 3).
 *
 * El dominio consume ÚNICAMENTE estos objetos normalizados: ninguna tabla, RPC
 * ni pantalla conoce los nombres de Meta o TikTok. La diferencia entre
 * proveedores vive en los adaptadores, y cambiar de proveedor es cambiar un
 * adaptador, no el modelo.
 */

export type NormalizedContact = {
  externalContactId: string;
  displayName?: string | null;
  phone?: string | null;
  username?: string | null;
};

export type NormalizedInboundMessage = {
  kind: "message";
  /** Identidad del evento del proveedor: la clave de idempotencia. */
  externalMessageId: string;
  externalAccountId: string;
  contact: NormalizedContact;
  messageType: string;
  body: string | null;
  sentAt: string | null;
  replyToExternalId?: string | null;
  metadata?: Record<string, unknown>;
};

export type NormalizedStatusUpdate = {
  kind: "status";
  externalAccountId: string;
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string | null;
};

export type NormalizedChannelEvent = NormalizedInboundMessage | NormalizedStatusUpdate;

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: string };

export type OutboundResult =
  | { ok: true; externalMessageId: string }
  | { ok: false; error: string; retryable: boolean };

export interface ChannelAdapter {
  /** Código del canal en `channels.code`. */
  readonly channelCode: string;
  /** Código del proveedor en `integration_webhook_events.provider`. */
  readonly provider: string;

  /**
   * Verifica la firma del webhook contra el secreto del entorno. Sin secreto
   * configurado devuelve ok con advertencia implícita: el entorno local no
   * tiene credenciales y aun así debe poder ejercitar el pipeline completo.
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;

  /** Payload crudo del proveedor → eventos normalizados. Nunca lanza: lo no reconocido se omite. */
  parseEvents(payload: unknown): NormalizedChannelEvent[];

  /**
   * Envía un mensaje por el proveedor. Sin credenciales devuelve un fallo NO
   * reintentable con motivo claro: el mensaje queda en cola visible, no en un
   * limbo silencioso.
   */
  sendMessage(externalContactId: string, body: string): Promise<OutboundResult>;
}

/**
 * Identidad estable para payloads sin id propio: un dedupe opcional es un
 * dedupe que nadie ejerce, así que el adaptador la fabrica SIEMPRE.
 */
export async function stablePayloadId(payload: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
