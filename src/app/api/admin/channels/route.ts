import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin, requireStaff } from "@/lib/auth/admin";
import { createChannelAccountSchema, type ChannelInfo } from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const [channelsResult, accountsResult] = await Promise.all([
      supabase
        .from("channels")
        .select("id, code, name, channel_type, is_active, supports_messages, supports_cart")
        .order("name"),
      supabase
        .from("channel_accounts")
        .select("id, channel_id, display_name, external_account_id, branch_id, is_active")
        .order("display_name")
    ]);

    if (channelsResult.error) throw new HttpError(400, "channels_failed", channelsResult.error.message);
    if (accountsResult.error) throw new HttpError(400, "accounts_failed", accountsResult.error.message);

    const accountsByChannel = new Map<string, ChannelInfo["accounts"]>();
    for (const account of (accountsResult.data ?? []) as {
      id: string; channel_id: string; display_name: string;
      external_account_id: string | null; branch_id: string | null; is_active: boolean;
    }[]) {
      const list = accountsByChannel.get(account.channel_id) ?? [];
      list.push({
        id: account.id,
        displayName: account.display_name,
        externalAccountId: account.external_account_id,
        branchId: account.branch_id,
        isActive: account.is_active
      });
      accountsByChannel.set(account.channel_id, list);
    }

    const items: ChannelInfo[] = ((channelsResult.data ?? []) as {
      id: string; code: string; name: string; channel_type: string;
      is_active: boolean; supports_messages: boolean; supports_cart: boolean;
    }[]).map((channel) => ({
      id: channel.id,
      code: channel.code,
      name: channel.name,
      channelType: channel.channel_type,
      isActive: channel.is_active,
      supportsMessages: channel.supports_messages,
      supportsCart: channel.supports_cart,
      accounts: accountsByChannel.get(channel.id) ?? []
    }));

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Alta de una cuenta concreta (el número de WhatsApp, la página de Facebook…). */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, createChannelAccountSchema);
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase
      .from("channel_accounts")
      .insert({
        channel_id: input.channelId,
        display_name: input.displayName,
        external_account_id: input.externalAccountId,
        branch_id: input.branchId ?? null
      })
      .select("id")
      .single();

    if (error) throw new HttpError(400, "account_create_failed", error.message);

    return created({ id: data.id });
  } catch (error) {
    return handleApiError(error);
  }
}
