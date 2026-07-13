import { handleApiError, ok } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();

    const [brandsResult, categoriesResult, settingsResult] = await Promise.all([
      supabase
        .from("brands")
        .select("id, name, slug, description, sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("categories")
        .select("id, name, slug, description, sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("store_settings")
        .select("business_name, whatsapp_number, stock_notice")
        .eq("id", true)
        .maybeSingle()
    ]);

    if (brandsResult.error) {
      throw brandsResult.error;
    }

    if (categoriesResult.error) {
      throw categoriesResult.error;
    }

    if (settingsResult.error) {
      throw settingsResult.error;
    }

    return ok({
      brands: brandsResult.data ?? [],
      categories: categoriesResult.data ?? [],
      contact: settingsResult.data
    });
  } catch (error) {
    return handleApiError(error);
  }
}
