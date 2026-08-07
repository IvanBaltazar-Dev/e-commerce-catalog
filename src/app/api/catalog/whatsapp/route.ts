import { cookies } from "next/headers";
import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import type { CartEvaluation, WhatsAppOrder } from "@/lib/catalog/contracts";
import { buildWhatsAppOrderMessage, whatsappUrl } from "@/lib/catalog/whatsapp";
import { whatsappOrderV2Schema } from "@/lib/catalog/validation";
import { serverEnv } from "@/lib/env/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CART_COOKIE = "br_cart";
const VISITOR_COOKIE = "br_vid";

async function getWhatsappNumber(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data, error } = await supabase
    .from("store_settings")
    .select("whatsapp_number")
    .eq("id", true)
    .maybeSingle();

  if (error) throw error;
  return data?.whatsapp_number ?? serverEnv.CATALOG_DEFAULT_WHATSAPP;
}

/**
 * CTA de WhatsApp. La generación del mensaje sigue siendo la frontera única de
 * siempre (buildWhatsAppOrderMessage); lo que añade el Bloque 3 es el CONTEXTO:
 * antes de abrir WhatsApp, el carrito queda persistido y sincronizado, la
 * atribución registra el salto de canal y el enlace de recuperación viaja en el
 * propio mensaje. NO se crea venta ni reserva: la conversación empieza cuando
 * la clienta realmente escribe.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, whatsappOrderV2Schema);
    const supabase = await createSupabaseServerClient();
    const cookieStore = await cookies();

    const [{ data, error }, phone] = await Promise.all([
      supabase.rpc("evaluate_cart_v2", { p_lines: input.lines }),
      getWhatsappNumber(supabase)
    ]);

    if (error) {
      throw new HttpError(400, "whatsapp_order_evaluation_failed", error.message);
    }

    const evaluation = data as CartEvaluation;

    // 1) Persistir la selección: el carrito sobrevive al salto de canal y a un
    //    cambio de dispositivo. Cualquier fallo aquí NO bloquea el CTA: abrir
    //    WhatsApp es lo que la clienta pidió.
    let recoveryToken: string | null = null;

    try {
      const visitorId = cookieStore.get(VISITOR_COOKIE)?.value ?? null;
      const cookieToken = cookieStore.get(CART_COOKIE)?.value ?? null;

      const { data: opened } = await supabase.rpc("get_or_create_public_cart", {
        p_public_token: cookieToken,
        p_visitor_id: visitorId,
        p_channel_code: "web"
      });

      const cart = opened as { id: string; publicToken: string } | null;

      if (cart) {
        await supabase.rpc("sync_public_cart", {
          p_public_token: cart.publicToken,
          p_lines: input.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }))
        });

        recoveryToken = cart.publicToken;

        // 2) Atribución: el salto a WhatsApp es un toque más de la cadena; el
        //    first-touch (Instagram, QR, lo que fuera) queda intacto por la base.
        if (visitorId) {
          await supabase.rpc("record_attribution_touch", {
            p_visitor_id: visitorId,
            p_source_code: "whatsapp",
            p_campaign_code: null,
            p_utm: {},
            p_referrer: null,
            p_landing_path: "/seleccion"
          });
        }
      }
    } catch {
      // Contexto perdido ≠ CTA perdido.
    }

    const order: WhatsAppOrder = {
      ...evaluation,
      deliveryMethod: input.deliveryMethod,
      customerNote: input.customerNote
    };

    let text = buildWhatsAppOrderMessage(order, input.intent);

    // 3) El enlace de recuperación viaja EN el mensaje: quien lo reciba abre
    //    exactamente la selección de la clienta.
    if (recoveryToken) {
      const origin = new URL(request.url).origin;
      text += `\n\nMi selección: ${origin}/seleccion/${recoveryToken}`;
    }

    return ok({
      phone,
      text,
      url: whatsappUrl(phone, text),
      evaluation,
      recoveryToken
    });
  } catch (error) {
    return handleApiError(error);
  }
}
