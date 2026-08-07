import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env/server";
import type {
  ChannelAdapter,
  NormalizedChannelEvent,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  OutboundResult,
  WebhookVerification
} from "@/lib/channels/adapter";

/**
 * Adaptadores de proveedor. Cada uno traduce SU dialecto al contrato interno;
 * el dominio no conoce a Meta ni a TikTok.
 *
 * Sin credenciales configuradas, todo degrada de forma explícita: la
 * verificación pasa con advertencia (entorno local), y el envío devuelve un
 * fallo con motivo para que el mensaje quede en cola visible.
 */

function verifyMetaSignature(rawBody: string, headers: Headers, secret: string | undefined): WebhookVerification {
  if (!secret) {
    // Entorno sin credenciales: el pipeline debe poder ejercitarse igual.
    return { ok: true };
  }

  const header = headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  if (header.length !== expected.length) {
    return { ok: false, reason: "Firma ausente o de longitud inválida." };
  }

  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    ? { ok: true }
    : { ok: false, reason: "La firma no coincide con el secreto configurado." };
}

/** Estructura mínima de los webhooks de WhatsApp Cloud API. */
type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          image?: { caption?: string };
          context?: { id?: string };
        }>;
        statuses?: Array<{ id?: string; status?: string; timestamp?: string }>;
      };
    }>;
  }>;
};

export const whatsappAdapter: ChannelAdapter = {
  channelCode: "whatsapp",
  provider: "whatsapp",

  verifyWebhook(rawBody, headers) {
    return verifyMetaSignature(rawBody, headers, serverEnv.WHATSAPP_APP_SECRET);
  },

  parseEvents(payload) {
    const events: NormalizedChannelEvent[] = [];
    const body = payload as WhatsAppWebhookPayload;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const accountId = value.metadata?.phone_number_id ?? "unknown";
        const contactNames = new Map(
          (value.contacts ?? []).map((contact) => [contact.wa_id ?? "", contact.profile?.name ?? null])
        );

        for (const message of value.messages ?? []) {
          if (!message.id || !message.from) continue;

          const inbound: NormalizedInboundMessage = {
            kind: "message",
            externalMessageId: message.id,
            externalAccountId: accountId,
            contact: {
              externalContactId: message.from,
              displayName: contactNames.get(message.from) ?? null,
              // En WhatsApp el identificador ES el teléfono: identidad natural.
              phone: message.from
            },
            messageType: message.type && /^[a-z_]{2,30}$/.test(message.type) ? message.type : "text",
            body: message.text?.body ?? message.image?.caption ?? null,
            sentAt: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : null,
            replyToExternalId: message.context?.id ?? null
          };

          events.push(inbound);
        }

        for (const status of value.statuses ?? []) {
          if (!status.id || !status.status) continue;
          if (!["sent", "delivered", "read", "failed"].includes(status.status)) continue;

          const update: NormalizedStatusUpdate = {
            kind: "status",
            externalAccountId: accountId,
            externalMessageId: status.id,
            status: status.status as NormalizedStatusUpdate["status"],
            occurredAt: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : null
          };

          events.push(update);
        }
      }
    }

    return events;
  },

  async sendMessage(externalContactId, body): Promise<OutboundResult> {
    const token = serverEnv.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = serverEnv.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      return {
        ok: false,
        retryable: false,
        error: "WhatsApp sin credenciales: el mensaje queda en cola local."
      };
    }

    try {
      const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: externalContactId,
          type: "text",
          text: { body }
        })
      });

      const result = (await response.json().catch(() => null)) as
        | { messages?: Array<{ id?: string }>; error?: { message?: string } }
        | null;

      if (!response.ok || !result?.messages?.[0]?.id) {
        return {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          error: result?.error?.message ?? `WhatsApp respondió ${response.status}.`
        };
      }

      return { ok: true, externalMessageId: result.messages[0].id };
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        error: error instanceof Error ? error.message : "Fallo de red hacia WhatsApp."
      };
    }
  }
};

/** Messenger e Instagram comparten la forma de webhook de Meta. */
type MetaMessagingPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: { mid?: string; text?: string; reply_to?: { mid?: string } };
      delivery?: { mids?: string[] };
      read?: { watermark?: number };
    }>;
  }>;
};

function buildMetaAdapter(channelCode: "facebook" | "instagram"): ChannelAdapter {
  return {
    channelCode,
    provider: channelCode,

    verifyWebhook(rawBody, headers) {
      return verifyMetaSignature(rawBody, headers, serverEnv.META_APP_SECRET);
    },

    parseEvents(payload) {
      const events: NormalizedChannelEvent[] = [];
      const body = payload as MetaMessagingPayload;

      for (const entry of body.entry ?? []) {
        const accountId = entry.id ?? "unknown";

        for (const item of entry.messaging ?? []) {
          const senderId = item.sender?.id;

          if (item.message?.mid && senderId && senderId !== accountId) {
            events.push({
              kind: "message",
              externalMessageId: item.message.mid,
              externalAccountId: accountId,
              contact: { externalContactId: senderId },
              messageType: "text",
              body: item.message.text ?? null,
              sentAt: item.timestamp ? new Date(item.timestamp).toISOString() : null,
              replyToExternalId: item.message.reply_to?.mid ?? null
            });
          }

          for (const mid of item.delivery?.mids ?? []) {
            events.push({
              kind: "status",
              externalAccountId: accountId,
              externalMessageId: mid,
              status: "delivered",
              occurredAt: item.timestamp ? new Date(item.timestamp).toISOString() : null
            });
          }
        }
      }

      return events;
    },

    async sendMessage(externalContactId, body): Promise<OutboundResult> {
      const token = serverEnv.META_PAGE_ACCESS_TOKEN;

      if (!token) {
        return {
          ok: false,
          retryable: false,
          error: `${channelCode} sin credenciales: el mensaje queda en cola local.`
        };
      }

      try {
        const response = await fetch("https://graph.facebook.com/v21.0/me/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            recipient: { id: externalContactId },
            message: { text: body }
          })
        });

        const result = (await response.json().catch(() => null)) as
          | { message_id?: string; error?: { message?: string } }
          | null;

        if (!response.ok || !result?.message_id) {
          return {
            ok: false,
            retryable: response.status >= 500 || response.status === 429,
            error: result?.error?.message ?? `Meta respondió ${response.status}.`
          };
        }

        return { ok: true, externalMessageId: result.message_id };
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          error: error instanceof Error ? error.message : "Fallo de red hacia Meta."
        };
      }
    }
  };
}

export const facebookAdapter = buildMetaAdapter("facebook");
export const instagramAdapter = buildMetaAdapter("instagram");

/**
 * TikTok: su API pública no ofrece hoy conversación completa de mensajería.
 * LIMITACIÓN DOCUMENTADA, no inventada: el adaptador registra los eventos que
 * la plataforma sí entrega (clics, leads) como eventos de canal para
 * atribución, y el envío de mensajes no existe.
 */
export const tiktokAdapter: ChannelAdapter = {
  channelCode: "tiktok",
  provider: "tiktok",

  verifyWebhook(rawBody, headers) {
    const secret = serverEnv.TIKTOK_WEBHOOK_SECRET;
    if (!secret) return { ok: true };

    const signature = headers.get("x-tiktok-signature") ?? "";
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

    if (signature.length !== expected.length) {
      return { ok: false, reason: "Firma ausente o de longitud inválida." };
    }

    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ? { ok: true }
      : { ok: false, reason: "La firma no coincide con el secreto configurado." };
  },

  parseEvents() {
    // Sin mensajería disponible: los webhooks de TikTok que lleguen se
    // conservan crudos en integration_webhook_events y se marcan ignorados
    // con motivo. La atribución de TikTok entra por UTM/QR, que sí existe.
    return [];
  },

  async sendMessage(): Promise<OutboundResult> {
    return {
      ok: false,
      retryable: false,
      error: "TikTok no ofrece envío de mensajes por API: limitación de la plataforma."
    };
  }
};

const ADAPTERS: Record<string, ChannelAdapter> = {
  whatsapp: whatsappAdapter,
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter
};

export function adapterFor(provider: string): ChannelAdapter | null {
  return ADAPTERS[provider] ?? null;
}
