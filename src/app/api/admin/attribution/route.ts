import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import type { OmnichannelMetrics } from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Métricas y cadenas recientes. Todo importe nace en sales (Bloque 2):
 * omnichannel_metrics lo garantiza en la base y esta capa solo lo transporta.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);

    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;

    const [metricsResult, chainsResult] = await Promise.all([
      supabase.rpc("omnichannel_metrics", {
        p_from: from ?? undefined,
        p_to: to ?? undefined
      }),
      supabase
        .from("channel_attributions")
        .select(`
          id, first_touch_at, last_touch_at, sale_id, cart_id, conversation_id,
          first_source:marketing_sources!channel_attributions_first_source_id_fkey(code),
          last_source:marketing_sources!channel_attributions_last_source_id_fkey(code),
          first_campaign:marketing_campaigns!channel_attributions_first_campaign_id_fkey(code)
        `)
        .order("created_at", { ascending: false })
        .limit(40)
    ]);

    if (metricsResult.error) throw new HttpError(400, "metrics_failed", metricsResult.error.message);
    if (chainsResult.error) throw new HttpError(400, "attribution_failed", chainsResult.error.message);

    type SourceRef = { code: string } | { code: string }[] | null;
    const codeOf = (ref: SourceRef) => (Array.isArray(ref) ? ref[0]?.code : ref?.code) ?? null;

    const chains = ((chainsResult.data ?? []) as {
      id: string; first_touch_at: string; last_touch_at: string;
      sale_id: string | null; cart_id: string | null; conversation_id: string | null;
      first_source: SourceRef; last_source: SourceRef; first_campaign: SourceRef;
    }[]).map((row) => ({
      id: row.id,
      firstTouchAt: row.first_touch_at,
      lastTouchAt: row.last_touch_at,
      firstSource: codeOf(row.first_source),
      lastSource: codeOf(row.last_source),
      campaign: codeOf(row.first_campaign),
      hasConversation: Boolean(row.conversation_id),
      hasCart: Boolean(row.cart_id),
      hasSale: Boolean(row.sale_id)
    }));

    return ok({
      metrics: metricsResult.data as OmnichannelMetrics,
      chains
    });
  } catch (error) {
    return handleApiError(error);
  }
}
