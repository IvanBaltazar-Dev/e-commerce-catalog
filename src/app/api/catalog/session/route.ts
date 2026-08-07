import { cookies } from "next/headers";
import { z } from "zod";
import { handleApiError, ok, readJson } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISITOR_COOKIE = "br_vid";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

const sessionSchema = z.object({
  landingPath: z.string().trim().max(500).optional().nullable(),
  referrer: z.string().trim().max(1000).optional().nullable(),
  utm: z.object({
    source: z.string().trim().max(120).optional().nullable(),
    medium: z.string().trim().max(120).optional().nullable(),
    campaign: z.string().trim().max(120).optional().nullable(),
    content: z.string().trim().max(200).optional().nullable(),
    term: z.string().trim().max(200).optional().nullable()
  }).optional().nullable(),
  /** ?source= de un QR o un enlace propio: mismo pipeline que los UTM. */
  source: z.string().trim().max(60).optional().nullable(),
  campaign: z.string().trim().max(120).optional().nullable()
});

/**
 * Identidad anónima + toque de atribución, en una sola llamada de landing.
 *
 * La cookie es httpOnly y opaca (uuid); la atribución se persiste desde la
 * PRIMERA visita, sin depender de que la clienta llegue al checkout en la
 * misma pestaña. El first-touch es inmutable en la base: aquí solo se toca.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, sessionSchema);
    const cookieStore = await cookies();
    const supabase = await createSupabaseServerClient();

    const existing = cookieStore.get(VISITOR_COOKIE)?.value ?? null;

    const { data: visitorId, error } = await supabase.rpc("touch_anonymous_visitor", {
      p_visitor_id: existing,
      p_landing_path: input.landingPath ?? null,
      p_referrer: input.referrer ?? null
    });

    if (error) throw error;

    cookieStore.set(VISITOR_COOKIE, visitorId as string, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: YEAR_SECONDS,
      path: "/"
    });

    // La fuente declarada (?source= de QR) manda sobre el utm_source; ambas
    // caen al mismo pipeline. Sin ninguna, el toque registra el referrer y la
    // resolución queda en manos de la base (direct/unknown).
    const sourceCode = input.source ?? input.utm?.source ?? (input.referrer ? "referral" : "direct");
    const campaignCode = input.campaign ?? input.utm?.campaign ?? null;

    const { error: touchError } = await supabase.rpc("record_attribution_touch", {
      p_visitor_id: visitorId,
      p_source_code: sourceCode,
      p_campaign_code: campaignCode,
      p_utm: {
        utm_source: input.utm?.source ?? null,
        utm_medium: input.utm?.medium ?? null,
        utm_campaign: input.utm?.campaign ?? null,
        utm_content: input.utm?.content ?? null,
        utm_term: input.utm?.term ?? null
      },
      p_referrer: input.referrer ?? null,
      p_landing_path: input.landingPath ?? null
    });

    if (touchError) throw touchError;

    return ok({ visitorId });
  } catch (error) {
    return handleApiError(error);
  }
}
