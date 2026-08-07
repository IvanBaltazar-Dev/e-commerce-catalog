import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelAdapter, NormalizedInboundMessage } from "@/lib/channels/adapter";

/**
 * Procesamiento de un webhook YA insertado. La regla del plan es insert-first:
 * esta función corre después, bajo reclamo condicional, y toda su escritura
 * pasa por los contratos idempotentes de la base — repetirla entera no duplica
 * nada.
 */

type ProcessSummary = {
  messages: number;
  duplicates: number;
  statuses: number;
  ignored: number;
  conversations: string[];
};

async function resolveAccountId(
  service: SupabaseClient,
  adapter: ChannelAdapter,
  externalAccountId: string
): Promise<string | null> {
  const { data: existing, error } = await service
    .from("channel_accounts")
    .select("id, channels!inner(code)")
    .eq("external_account_id", externalAccountId)
    .eq("channels.code", adapter.channelCode)
    .maybeSingle();

  if (error) throw new Error(`cuenta de canal: ${error.message}`);
  if (existing) return existing.id as string;

  // Primera vez que este número/página escribe: la cuenta se registra sola,
  // inactiva ninguna decisión y deja a administración renombrarla después.
  const { data: channel } = await service
    .from("channels")
    .select("id")
    .eq("code", adapter.channelCode)
    .single();

  if (!channel) return null;

  const { data: created, error: createError } = await service
    .from("channel_accounts")
    .insert({
      channel_id: channel.id,
      display_name: `${adapter.channelCode} ${externalAccountId}`,
      external_account_id: externalAccountId
    })
    .select("id")
    .single();

  if (createError) {
    // Carrera con otro webhook simultáneo: el índice único ganó; se relee.
    const { data: raced } = await service
      .from("channel_accounts")
      .select("id")
      .eq("external_account_id", externalAccountId)
      .maybeSingle();
    return (raced?.id as string) ?? null;
  }

  return created.id as string;
}

async function processInbound(
  service: SupabaseClient,
  accountId: string,
  event: NormalizedInboundMessage,
  summary: ProcessSummary
) {
  const { data, error } = await service.rpc("ingest_channel_message", {
    p_channel_account_id: accountId,
    p_external_contact_id: event.contact.externalContactId,
    p_direction: "inbound",
    p_body: event.body,
    p_message_type: event.messageType,
    p_external_message_id: event.externalMessageId,
    p_contact_display_name: event.contact.displayName ?? null,
    p_contact_phone: event.contact.phone ?? null,
    p_contact_username: event.contact.username ?? null,
    p_sent_at: event.sentAt,
    p_reply_to_external_id: event.replyToExternalId ?? null,
    p_metadata: event.metadata ?? {}
  });

  if (error) throw new Error(`ingesta de mensaje: ${error.message}`);

  const result = data as { conversationId: string; messageId: string; created: boolean };

  if (result.created) {
    summary.messages += 1;
  } else {
    summary.duplicates += 1;
  }

  if (!summary.conversations.includes(result.conversationId)) {
    summary.conversations.push(result.conversationId);
  }

  // Política de asignación: no pisa una vigente; una sede sin vendedoras deja
  // la conversación sin asignar y eso también es un resultado.
  await service.rpc("auto_assign_conversation", { p_conversation_id: result.conversationId });

  // La cadena de atribución del contacto se abre o continúa con este canal.
  const { data: conversation } = await service
    .from("channel_conversations")
    .select("channel_contact_id")
    .eq("id", result.conversationId)
    .single();

  if (conversation) {
    await service.rpc("attach_attribution", {
      p_contact_id: conversation.channel_contact_id,
      p_conversation_id: result.conversationId,
      p_source_code: (await adapterChannelCode(service, accountId)) ?? undefined
    });
  }
}

async function adapterChannelCode(service: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await service
    .from("channel_accounts")
    .select("channels!inner(code)")
    .eq("id", accountId)
    .maybeSingle();

  const channels = data?.channels as { code?: string } | { code?: string }[] | null | undefined;
  if (!channels) return null;
  return Array.isArray(channels) ? channels[0]?.code ?? null : channels.code ?? null;
}

export async function processChannelPayload(
  service: SupabaseClient,
  adapter: ChannelAdapter,
  payload: unknown
): Promise<ProcessSummary> {
  const summary: ProcessSummary = {
    messages: 0, duplicates: 0, statuses: 0, ignored: 0, conversations: []
  };

  const events = adapter.parseEvents(payload);

  if (events.length === 0) {
    summary.ignored += 1;
    return summary;
  }

  const accountCache = new Map<string, string | null>();

  for (const event of events) {
    let accountId = accountCache.get(event.externalAccountId);

    if (accountId === undefined) {
      accountId = await resolveAccountId(service, adapter, event.externalAccountId);
      accountCache.set(event.externalAccountId, accountId);
    }

    if (!accountId) {
      summary.ignored += 1;
      continue;
    }

    if (event.kind === "message") {
      await processInbound(service, accountId, event, summary);
    } else {
      const { error } = await service.rpc("mark_message_status", {
        p_channel_account_id: accountId,
        p_external_message_id: event.externalMessageId,
        p_status: event.status,
        p_occurred_at: event.occurredAt
      });

      if (error) throw new Error(`estado de mensaje: ${error.message}`);
      summary.statuses += 1;
    }
  }

  return summary;
}
