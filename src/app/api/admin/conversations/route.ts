import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { ConversationSummary } from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  branch_id: string;
  status: ConversationSummary["status"];
  assigned_user_id: string | null;
  assigned_user_label: string | null;
  opened_at: string;
  last_activity_at: string;
  channel_accounts: {
    display_name: string;
    channels: { code: string } | { code: string }[];
  } | Array<{ display_name: string; channels: { code: string } | { code: string }[] }>;
  channel_contacts: {
    display_name: string | null;
    phone_normalized: string | null;
  } | Array<{ display_name: string | null; phone_normalized: string | null }>;
};

function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Bandeja. La RLS ya recorta: la vendedora recibe las conversaciones de sus
 * sedes sin asignar o asignadas a ella; los filtros solo refinan sobre eso.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);

    let query = supabase
      .from("channel_conversations")
      .select(`
        id, branch_id, status, assigned_user_id, assigned_user_label,
        opened_at, last_activity_at,
        channel_accounts!inner(display_name, channels!inner(code)),
        channel_contacts!inner(display_name, phone_normalized)
      `)
      .order("last_activity_at", { ascending: false })
      .limit(120);

    const status = url.searchParams.get("status");
    if (status) query = query.eq("status", status);

    const channel = url.searchParams.get("channel");
    if (channel) query = query.eq("channel_accounts.channels.code", channel);

    const branch = url.searchParams.get("branch");
    if (branch) query = query.eq("branch_id", branch);

    const assigned = url.searchParams.get("assigned");
    if (assigned === "none") query = query.is("assigned_user_id", null);
    else if (assigned === "me") {
      const { user } = await requireStaff();
      query = query.eq("assigned_user_id", user.id);
    }

    const { data, error } = await query;
    if (error) throw new HttpError(400, "conversations_list_failed", error.message);

    const rows = (data ?? []) as unknown as Row[];
    const ids = rows.map((row) => row.id);

    // Contexto comercial de la bandeja: carrito activo y venta enlazada, en
    // dos consultas planas en lugar de una por fila.
    const [cartsResult, attributionsResult] = await Promise.all([
      ids.length
        ? supabase.from("public_carts").select("id, conversation_id, status").in("conversation_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? supabase.from("channel_attributions").select("conversation_id, sale_id, reservation_id").in("conversation_id", ids)
        : Promise.resolve({ data: [], error: null })
    ]);

    const activeCarts = new Map(
      ((cartsResult.data ?? []) as { id: string; conversation_id: string; status: string }[])
        .filter((cart) => cart.status === "active" || cart.status === "abandoned")
        .map((cart) => [cart.conversation_id, cart.id])
    );
    const chains = new Map(
      ((attributionsResult.data ?? []) as { conversation_id: string; sale_id: string | null; reservation_id: string | null }[])
        .map((chain) => [chain.conversation_id, chain])
    );

    const items: ConversationSummary[] = rows.map((row) => {
      const account = firstOf(row.channel_accounts);
      const channelRef = firstOf(account?.channels);
      const contact = firstOf(row.channel_contacts);
      const chain = chains.get(row.id);

      return {
        id: row.id,
        channelCode: channelRef?.code ?? "manual",
        channelAccountName: account?.display_name ?? "",
        branchId: row.branch_id,
        status: row.status,
        contactName: contact?.display_name ?? null,
        contactPhone: contact?.phone_normalized ?? null,
        assignedUserId: row.assigned_user_id,
        assignedUserLabel: row.assigned_user_label,
        lastActivityAt: row.last_activity_at,
        openedAt: row.opened_at,
        activeCartId: activeCarts.get(row.id) ?? null,
        linkedSaleId: chain?.sale_id ?? null,
        linkedReservationId: chain?.reservation_id ?? null
      };
    });

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}
