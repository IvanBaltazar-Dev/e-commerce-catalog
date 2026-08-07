import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { AdminCartSummary } from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bandeja de carritos. El VALOR de cada uno se reevalúa en la base al momento
 * de leer (public_cart_detail → evaluate_cart_v2): esta capa jamás calcula un
 * importe ni confía en uno almacenado.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);

    let query = supabase
      .from("public_carts")
      .select(`
        id, public_token, status, branch_id, assigned_user_id, conversation_id,
        converted_sale_id, last_activity_at, created_at,
        channels(code)
      `)
      .order("last_activity_at", { ascending: false })
      .limit(60);

    const status = url.searchParams.get("status");
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "carts_list_failed", error.message);

    type Row = {
      id: string; public_token: string; status: AdminCartSummary["status"];
      branch_id: string; assigned_user_id: string | null; conversation_id: string | null;
      converted_sale_id: string | null; last_activity_at: string; created_at: string;
      channels: { code: string } | { code: string }[] | null;
    };

    const rows = (data ?? []) as unknown as Row[];
    const cartIds = rows.map((row) => row.id);

    const [itemsResult, sellersResult, attributionResult] = await Promise.all([
      cartIds.length
        ? supabase.from("public_cart_items").select("cart_id, quantity").in("cart_id", cartIds)
        : Promise.resolve({ data: [] }),
      supabase.from("admin_profiles").select("id, full_name"),
      cartIds.length
        ? supabase
            .from("channel_attributions")
            .select("cart_id, marketing_campaigns!channel_attributions_first_campaign_id_fkey(code)")
            .in("cart_id", cartIds)
        : Promise.resolve({ data: [] })
    ]);

    const unitsByCart = new Map<string, { items: number; units: number }>();
    for (const item of (itemsResult.data ?? []) as { cart_id: string; quantity: number }[]) {
      const bucket = unitsByCart.get(item.cart_id) ?? { items: 0, units: 0 };
      bucket.items += 1;
      bucket.units += item.quantity;
      unitsByCart.set(item.cart_id, bucket);
    }

    const sellerNames = new Map(
      ((sellersResult.data ?? []) as { id: string; full_name: string | null }[])
        .map((seller) => [seller.id, seller.full_name])
    );

    const campaignByCart = new Map<string, string | null>();
    for (const chain of (attributionResult.data ?? []) as {
      cart_id: string | null;
      marketing_campaigns: { code: string } | { code: string }[] | null;
    }[]) {
      if (!chain.cart_id) continue;
      const campaign = Array.isArray(chain.marketing_campaigns)
        ? chain.marketing_campaigns[0]
        : chain.marketing_campaigns;
      campaignByCart.set(chain.cart_id, campaign?.code ?? null);
    }

    // El valor actual: reevaluado por la base carrito a carrito. Son a lo sumo
    // 60 RPC ligeros; la pantalla es operativa, no un dashboard de alto tráfico.
    const items: AdminCartSummary[] = await Promise.all(
      rows.map(async (row) => {
        const channel = Array.isArray(row.channels) ? row.channels[0] : row.channels;
        const bucket = unitsByCart.get(row.id) ?? { items: 0, units: 0 };

        let subtotal: number | null = null;
        if (bucket.items > 0) {
          const { data: detail } = await supabase.rpc("public_cart_detail", {
            p_public_token: row.public_token
          });
          const evaluation = (detail as { evaluation?: { subtotal?: number | null } } | null)?.evaluation;
          subtotal = evaluation?.subtotal == null ? null : Number(evaluation.subtotal);
        }

        return {
          id: row.id,
          publicToken: row.public_token,
          status: row.status,
          channelCode: channel?.code ?? null,
          branchId: row.branch_id,
          assignedUserLabel: row.assigned_user_id ? sellerNames.get(row.assigned_user_id) ?? null : null,
          conversationId: row.conversation_id,
          convertedSaleId: row.converted_sale_id,
          itemCount: bucket.items,
          totalUnits: bucket.units,
          subtotal,
          campaignCode: campaignByCart.get(row.id) ?? null,
          lastActivityAt: row.last_activity_at,
          createdAt: row.created_at
        };
      })
    );

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}
