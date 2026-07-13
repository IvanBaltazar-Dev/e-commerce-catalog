import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import {
  buildColorChartAdvisorMessage,
  buildProductAdvisorMessage,
  buildSelectionMessage,
  whatsappUrl
} from "@/lib/catalog/whatsapp";
import { whatsappRequestSchema } from "@/lib/catalog/validation";
import { serverEnv } from "@/lib/env/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WHATSAPP_PRODUCT_SELECT = `
  id,
  name,
  presentation,
  unit_price,
  wholesale_price,
  wholesale_min_quantity,
  brand:brands(name)
`;

async function getWhatsappNumber(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data, error } = await supabase
    .from("store_settings")
    .select("whatsapp_number")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.whatsapp_number ?? serverEnv.CATALOG_DEFAULT_WHATSAPP;
}

async function getProduct(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  productId: string
) {
  const { data, error } = await supabase
    .from("products")
    .select(WHATSAPP_PRODUCT_SELECT)
    .eq("id", productId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new HttpError(404, "product_not_found", "Product not found.");
  }

  return data;
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request, whatsappRequestSchema);
    const supabase = await createSupabaseServerClient();
    const phone = await getWhatsappNumber(supabase);
    let text = "";

    if (body.type === "product_advisor") {
      const product = await getProduct(supabase, body.productId);
      text = buildProductAdvisorMessage(product, body.quantity);
    }

    if (body.type === "color_chart_advisor") {
      const product = await getProduct(supabase, body.productId);
      text = buildColorChartAdvisorMessage(product, body.quantity);
    }

    if (body.type === "selection") {
      const products = await Promise.all(
        body.items.map(async (item) => ({
          ...item,
          product: await getProduct(supabase, item.productId)
        }))
      );

      text = buildSelectionMessage(products, {
        deliveryMethod: body.deliveryMethod,
        customerNote: body.customerNote
      });
    }

    return ok({
      phone,
      text,
      url: whatsappUrl(phone, text)
    });
  } catch (error) {
    return handleApiError(error);
  }
}
