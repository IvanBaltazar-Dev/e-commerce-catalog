import { handleApiError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { renderCatalogPdf } from "@/lib/catalog/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pdfPath(date: Date) {
  return `generated/catalog-${date.toISOString().replace(/[:.]/g, "-")}.pdf`;
}

export async function POST() {
  const generatedAt = new Date();
  let exportId: string | null = null;

  try {
    const { supabase, user } = await requireAdmin();
    const [metadataResult, productsResult, settingsResult] = await Promise.all([
      supabase
        .from("catalog_metadata")
        .select("content_updated_at")
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("products")
        .select(
          `
            code,
            name,
            presentation,
            product_type,
            requires_lamp,
            description,
            unit_price,
            wholesale_price,
            wholesale_min_quantity,
            availability,
            color_chart_status,
            brand:brands(name),
            category:categories(name)
          `
        )
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("store_settings")
        .select("business_name, whatsapp_number, stock_notice")
        .eq("id", true)
        .maybeSingle()
    ]);

    if (metadataResult.error) throw metadataResult.error;
    if (productsResult.error) throw productsResult.error;
    if (settingsResult.error) throw settingsResult.error;

    const exportResult = await supabase
      .from("pdf_exports")
      .insert({
        status: "generating",
        generated_by: user.id,
        catalog_updated_at_snapshot: metadataResult.data?.content_updated_at ?? null
      })
      .select("id")
      .single();

    if (exportResult.error) {
      throw exportResult.error;
    }

    exportId = exportResult.data.id;

    const pdf = await renderCatalogPdf({
      products: productsResult.data ?? [],
      settings: settingsResult.data,
      generatedAt
    });
    const path = pdfPath(generatedAt);
    const uploadResult = await supabase.storage.from("catalog-pdfs").upload(path, pdf, {
      contentType: "application/pdf",
      upsert: true
    });

    if (uploadResult.error) {
      throw uploadResult.error;
    }

    const updateResult = await supabase
      .from("pdf_exports")
      .update({
        status: "updated",
        storage_path: path,
        generated_at: generatedAt.toISOString(),
        error_message: null
      })
      .eq("id", exportId)
      .select(
        "id, status, storage_path, generated_at, catalog_updated_at_snapshot, error_message, created_at, updated_at"
      )
      .single();

    if (updateResult.error) {
      throw updateResult.error;
    }

    return ok(updateResult.data, 201);
  } catch (error) {
    if (exportId) {
      try {
        const { supabase } = await requireAdmin();
        await supabase
          .from("pdf_exports")
          .update({
            status: "error",
            error_message: error instanceof Error ? error.message : "PDF generation failed."
          })
          .eq("id", exportId);
      } catch {
        // Preserve the original error response.
      }
    }

    return handleApiError(error);
  }
}
