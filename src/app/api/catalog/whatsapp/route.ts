import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import type { CartEvaluation, WhatsAppOrder } from "@/lib/catalog/contracts";
import { buildWhatsAppOrderMessage, whatsappUrl } from "@/lib/catalog/whatsapp";
import { whatsappOrderV2Schema } from "@/lib/catalog/validation";
import { serverEnv } from "@/lib/env/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getWhatsappNumber(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data, error } = await supabase
    .from("store_settings")
    .select("whatsapp_number")
    .eq("id", true)
    .maybeSingle();

  if (error) throw error;
  return data?.whatsapp_number ?? serverEnv.CATALOG_DEFAULT_WHATSAPP;
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, whatsappOrderV2Schema);
    const supabase = await createSupabaseServerClient();
    const [{ data, error }, phone] = await Promise.all([
      supabase.rpc("evaluate_cart_v2", { p_lines: input.lines }),
      getWhatsappNumber(supabase)
    ]);

    if (error) {
      throw new HttpError(400, "whatsapp_order_evaluation_failed", error.message);
    }

    const evaluation = data as CartEvaluation;
    const order: WhatsAppOrder = {
      ...evaluation,
      deliveryMethod: input.deliveryMethod,
      customerNote: input.customerNote
    };
    const text = buildWhatsAppOrderMessage(order, input.intent);

    return ok({
      phone,
      text,
      url: whatsappUrl(phone, text),
      evaluation
    });
  } catch (error) {
    return handleApiError(error);
  }
}
