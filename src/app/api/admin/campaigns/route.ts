import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin, requireStaff } from "@/lib/auth/admin";
import { createCampaignSchema, type CampaignInfo } from "@/lib/admin/omnichannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const { data, error } = await supabase
      .from("marketing_campaigns")
      .select(`
        id, name, code, starts_at, ends_at, is_active,
        marketing_sources(code),
        channels(code)
      `)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw new HttpError(400, "campaigns_failed", error.message);

    const items: CampaignInfo[] = ((data ?? []) as {
      id: string; name: string; code: string; starts_at: string | null;
      ends_at: string | null; is_active: boolean;
      marketing_sources: { code: string } | { code: string }[] | null;
      channels: { code: string } | { code: string }[] | null;
    }[]).map((row) => {
      const source = Array.isArray(row.marketing_sources) ? row.marketing_sources[0] : row.marketing_sources;
      const channel = Array.isArray(row.channels) ? row.channels[0] : row.channels;

      return {
        id: row.id,
        name: row.name,
        code: row.code,
        sourceCode: source?.code ?? null,
        channelCode: channel?.code ?? null,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        isActive: row.is_active
      };
    });

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, createCampaignSchema);
    const { supabase } = await requireAdmin();

    const [sourceResult, channelResult] = await Promise.all([
      input.sourceCode
        ? supabase.from("marketing_sources").select("id").eq("code", input.sourceCode).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      input.channelCode
        ? supabase.from("channels").select("id").eq("code", input.channelCode).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);

    const { data, error } = await supabase
      .from("marketing_campaigns")
      .insert({
        name: input.name,
        code: input.code,
        source_id: sourceResult.data?.id ?? null,
        channel_id: channelResult.data?.id ?? null,
        starts_at: input.startsAt ?? null,
        ends_at: input.endsAt ?? null
      })
      .select("id, code")
      .single();

    if (error) throw new HttpError(400, "campaign_create_failed", error.message);

    return created({ id: data.id, code: data.code });
  } catch (error) {
    return handleApiError(error);
  }
}
