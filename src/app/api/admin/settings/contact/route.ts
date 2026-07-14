import { handleApiError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { contactSettingsSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase
      .from("store_settings")
      .select("business_name, whatsapp_number, stock_notice, updated_at")
      .eq("id", true)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, contactSettingsSchema);
    const { data, error } = await supabase
      .from("store_settings")
      .upsert({
        id: true,
        business_name: input.businessName,
        whatsapp_number: input.whatsappNumber,
        stock_notice: input.stockNotice
      })
      .select("business_name, whatsapp_number, stock_notice, updated_at")
      .single();

    if (error) {
      throw error;
    }

    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}
