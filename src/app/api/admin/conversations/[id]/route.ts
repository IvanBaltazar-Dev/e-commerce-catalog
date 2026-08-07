import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { adapterFor } from "@/lib/channels/providers";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import {
  conversationActionSchema,
  type ConversationDetail,
  type ConversationMessage
} from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

async function loadDetail(
  supabase: Awaited<ReturnType<typeof requireStaff>>["supabase"],
  id: string
): Promise<ConversationDetail> {
  const { data: conversation, error } = await supabase
    .from("channel_conversations")
    .select(`
      id, branch_id, status, assigned_user_id, assigned_user_label,
      opened_at, last_activity_at, channel_contact_id,
      channel_accounts!inner(display_name, channels!inner(code)),
      channel_contacts!inner(id, display_name, phone_normalized, username, person_id)
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new HttpError(400, "conversation_detail_failed", error.message);
  if (!conversation) throw new HttpError(404, "conversation_not_found", "La conversación no existe o no te alcanza.");

  const account = firstOf(conversation.channel_accounts as never as { display_name: string; channels: { code: string } | { code: string }[] }[] | { display_name: string; channels: { code: string } | { code: string }[] });
  const channelRef = firstOf(account?.channels);
  const contact = firstOf(conversation.channel_contacts as never as {
    id: string; display_name: string | null; phone_normalized: string | null;
    username: string | null; person_id: string | null;
  }[] | { id: string; display_name: string | null; phone_normalized: string | null; username: string | null; person_id: string | null });

  const [messagesResult, eventsResult, personResult, cartResult, attributionResult] = await Promise.all([
    supabase
      .from("channel_messages")
      .select("id, direction, message_type, body, status, sent_by_label, received_at")
      .eq("conversation_id", id)
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(300),
    supabase
      .from("channel_events")
      .select("id, event_type, source_label, actor_label, occurred_at")
      .eq("conversation_id", id)
      .order("id", { ascending: true })
      .limit(120),
    contact?.person_id
      ? supabase.from("persons").select("full_name").eq("id", contact.person_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("public_carts")
      .select("id, public_token, status")
      .eq("conversation_id", id)
      .in("status", ["active", "abandoned", "converted"])
      .order("last_activity_at", { ascending: false })
      .limit(1),
    supabase
      .from("channel_attributions")
      .select("sale_id, reservation_id")
      .eq("conversation_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
  ]);

  // El valor del carrito lo reevalúa la base, jamás esta capa.
  let cart: ConversationDetail["cart"] = null;
  const cartRow = (cartResult.data ?? [])[0] as { id: string; public_token: string; status: string } | undefined;

  if (cartRow) {
    const { data: detail } = await supabase.rpc("public_cart_detail", { p_public_token: cartRow.public_token });
    const evaluation = (detail as { evaluation?: { lines?: unknown[]; totalUnits?: number; subtotal?: number | null } } | null)?.evaluation;

    cart = {
      id: cartRow.id,
      publicToken: cartRow.public_token,
      status: cartRow.status as ConversationDetail["cart"] extends null ? never : NonNullable<ConversationDetail["cart"]>["status"],
      totalUnits: Number(evaluation?.totalUnits ?? 0),
      subtotal: evaluation?.subtotal == null ? null : Number(evaluation.subtotal),
      lines: ((evaluation?.lines ?? []) as {
        sku?: string | null; productName?: string | null; variantName?: string | null;
        quantity?: number; subtotal?: number | null;
      }[]).map((line) => ({
        sku: line.sku ?? null,
        productName: line.productName ?? null,
        variantName: line.variantName ?? null,
        quantity: Number(line.quantity ?? 0),
        subtotal: line.subtotal == null ? null : Number(line.subtotal)
      }))
    };
  }

  const chain = (attributionResult.data ?? [])[0] as { sale_id: string | null; reservation_id: string | null } | undefined;

  const [saleResult, reservationResult] = await Promise.all([
    chain?.sale_id
      ? supabase.from("sales").select("id, sale_number, total, status").eq("id", chain.sale_id).maybeSingle()
      : Promise.resolve({ data: null }),
    chain?.reservation_id
      ? supabase.from("reservations").select("id, reservation_number, total, status").eq("id", chain.reservation_id).maybeSingle()
      : Promise.resolve({ data: null })
  ]);

  return {
    conversation: {
      id: conversation.id as string,
      channelCode: channelRef?.code ?? "manual",
      channelAccountName: account?.display_name ?? "",
      branchId: conversation.branch_id as string,
      status: conversation.status as ConversationDetail["conversation"]["status"],
      contactName: contact?.display_name ?? null,
      contactPhone: contact?.phone_normalized ?? null,
      assignedUserId: conversation.assigned_user_id as string | null,
      assignedUserLabel: conversation.assigned_user_label as string | null,
      lastActivityAt: conversation.last_activity_at as string,
      openedAt: conversation.opened_at as string,
      activeCartId: cart?.id ?? null,
      linkedSaleId: chain?.sale_id ?? null,
      linkedReservationId: chain?.reservation_id ?? null
    },
    contact: {
      id: contact?.id ?? "",
      displayName: contact?.display_name ?? null,
      phone: contact?.phone_normalized ?? null,
      username: contact?.username ?? null,
      personId: contact?.person_id ?? null,
      personName: (personResult.data as { full_name?: string } | null)?.full_name ?? null
    },
    messages: ((messagesResult.data ?? []) as {
      id: string; direction: ConversationMessage["direction"]; message_type: string;
      body: string | null; status: ConversationMessage["status"];
      sent_by_label: string | null; received_at: string;
    }[]).map((message) => ({
      id: message.id,
      direction: message.direction,
      messageType: message.message_type,
      body: message.body,
      status: message.status,
      sentByLabel: message.sent_by_label,
      receivedAt: message.received_at
    })),
    events: ((eventsResult.data ?? []) as { id: number; event_type: string; source_label: string | null; actor_label: string | null; occurred_at: string }[])
      .map((event) => ({
        id: event.id,
        eventType: event.event_type,
        sourceLabel: event.source_label,
        actorLabel: event.actor_label,
        occurredAt: event.occurred_at
      })),
    cart,
    sale: saleResult.data
      ? {
          id: saleResult.data.id as string,
          saleNumber: saleResult.data.sale_number as string,
          total: Number(saleResult.data.total),
          status: saleResult.data.status as string
        }
      : null,
    reservation: reservationResult.data
      ? {
          id: reservationResult.data.id as string,
          reservationNumber: reservationResult.data.reservation_number as string,
          total: Number(reservationResult.data.total),
          status: reservationResult.data.status as string
        }
      : null
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireStaff();
    return ok(await loadDetail(supabase, id));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Acciones de conversación. El envío es insert-first: el mensaje queda en cola
 * en la base y DESPUÉS se intenta el proveedor; sin credenciales queda visible
 * como en cola, jamás en un limbo.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, conversationActionSchema);
    const { supabase, user } = await requireStaff();

    if (input.action === "claim") {
      const { error } = await supabase.rpc("claim_conversation", { p_conversation_id: id });
      if (error) throw new HttpError(409, "conversation_claim_failed", error.message);
      return ok(await loadDetail(supabase, id));
    }

    if (input.action === "close") {
      const { error } = await supabase.rpc("close_conversation", {
        p_conversation_id: id,
        p_reason: input.reason
      });
      if (error) throw new HttpError(400, "conversation_close_failed", error.message);
      return ok(await loadDetail(supabase, id));
    }

    if (input.action === "assign") {
      const { error } = await supabase.rpc("assign_conversation", {
        p_conversation_id: id,
        p_user_id: input.userId,
        p_reason: input.reason,
        p_kind: "manual"
      });
      if (error) throw new HttpError(400, "conversation_assign_failed", error.message);
      return ok(await loadDetail(supabase, id));
    }

    // action === "send"
    const detail = await loadDetail(supabase, id);

    if (!detail.contact.id) {
      throw new HttpError(400, "conversation_contact_missing", "La conversación no tiene contacto.");
    }

    const { data: accountRow, error: accountError } = await supabase
      .from("channel_conversations")
      .select("channel_account_id")
      .eq("id", id)
      .single();

    if (accountError) throw new HttpError(400, "conversation_account_failed", accountError.message);

    const { data: ingested, error: ingestError } = await supabase.rpc("ingest_channel_message", {
      p_channel_account_id: accountRow.channel_account_id,
      p_external_contact_id: detail.contact.phone ?? detail.contact.id,
      p_direction: "outbound",
      p_body: input.body,
      p_message_type: "text"
    });

    if (ingestError) throw new HttpError(400, "message_queue_failed", ingestError.message);

    const messageId = (ingested as { messageId: string }).messageId;
    const adapter = adapterFor(detail.conversation.channelCode);

    if (adapter && detail.contact.phone) {
      const service = createSupabaseServiceClient();
      const result = await adapter.sendMessage(detail.contact.phone, input.body);

      await service.rpc("record_delivery_attempt", {
        p_provider: adapter.provider,
        p_channel_message_id: messageId,
        p_status: result.ok ? "sent" : "failed",
        p_endpoint: null,
        p_error: result.ok ? null : result.error,
        p_request_summary: { to: detail.contact.phone, by: user.id },
        p_response_summary: result.ok ? { externalMessageId: result.externalMessageId } : {}
      });

      if (result.ok) {
        await service.rpc("mark_message_dispatched", {
          p_message_id: messageId,
          p_external_message_id: result.externalMessageId,
          p_status: "sent"
        });
      }
    }

    return ok(await loadDetail(supabase, id));
  } catch (error) {
    return handleApiError(error);
  }
}
