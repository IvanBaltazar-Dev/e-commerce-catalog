import { handleApiError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import type { CatalogListResponse } from "@/lib/catalog/contracts";
import { renderCatalogPdf } from "@/lib/catalog/pdf";
import { logServerEvent } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function pdfPath(date: Date) {
  return `generated/catalog-v2-${date.toISOString().replace(/[:.]/g, "-")}.pdf`;
}

export async function POST(request: Request) {
  let exportId: string | null = null;

  try {
    const { supabase, user } = await requireAdmin();
    const generatedAt = new Date();
    const raw = await request.json().catch(() => ({})) as Record<string, unknown>;
    const parameters = {
      search: typeof raw.search === "string" ? raw.search.slice(0, 120) : null,
      brand: typeof raw.brand === "string" ? raw.brand.slice(0, 140) : null,
      category: typeof raw.category === "string" ? raw.category.slice(0, 500) : null,
      availability: ["available", "sold_out", "consult"].includes(String(raw.availability)) ? raw.availability : null,
      attributes: raw.attributes && typeof raw.attributes === "object" ? raw.attributes : {},
      sort: ["featured", "name_asc", "name_desc", "price_asc", "price_desc"].includes(String(raw.sort)) ? raw.sort : "featured"
    };

    const cards: CatalogListResponse["items"] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const { data, error } = await supabase.rpc("catalog_list_v2", {
        p_page: page,
        p_page_size: 100,
        p_search: parameters.search,
        p_brand_slug: parameters.brand,
        p_category_path: parameters.category,
        p_availability: parameters.availability,
        p_attribute_filters: parameters.attributes,
        p_sort: parameters.sort
      });
      if (error) throw error;
      const response = data as CatalogListResponse;
      cards.push(...response.items);
      totalPages = response.totalPages;
      page += 1;
    } while (page <= totalPages);

    const productIds = cards.map((item) => item.productId);
    const [metadataResult, productsResult, variantsResult, mediaResult, settingsResult] = await Promise.all([
      supabase.from("catalog_metadata").select("content_updated_at").eq("id", true).maybeSingle(),
      supabase.from("products").select("id, code, name, description, requires_lamp, lamp_type, brand:brands(name), category:categories(name)").in("id", productIds),
      // Vista y no tabla: `availability_status` es el estado editorial crudo y el
      // PDF habría listado como disponible una variante que el catálogo público
      // ya da por agotada al resolver contra existencias.
      supabase.from("variant_public_availability").select("id, product_id, sku, name, availability, sort_order").in("product_id", productIds).eq("is_active", true).order("sort_order"),
      supabase.from("product_media").select("product_id, media_role, sort_order, media_assets!inner(storage_path)").in("product_id", productIds).order("sort_order"),
      supabase.from("store_settings").select("business_name, whatsapp_number, stock_notice").eq("id", true).maybeSingle()
    ]);
    for (const result of [metadataResult, productsResult, variantsResult, mediaResult, settingsResult]) if (result.error) throw result.error;

    const rows = productsResult.data ?? [];
    const variants = variantsResult.data ?? [];
    const pricesResult = await supabase.from("variant_prices").select("variant_id, amount, minimum_quantity, price_lists!inner(price_type)").eq("is_active", true).in("variant_id", variants.map((variant) => variant.id));
    if (pricesResult.error) throw pricesResult.error;
    const prices = pricesResult.data ?? [];
    const media = mediaResult.data ?? [];
    const pdfProducts = cards.map((card) => {
      const row = rows.find((item) => item.id === card.productId)!;
      const productVariants = variants.filter((item) => item.product_id === card.productId);
      const variantIds = productVariants.map((item) => item.id);
      const productPrices = prices.filter((price) => variantIds.includes(price.variant_id));
      const wholesalePrices = productPrices.filter((price) => (price.price_lists as unknown as { price_type: string }).price_type === "wholesale");
      const productMedia = media.filter((item) => item.product_id === card.productId);
      const pathFor = (role: string) => {
        const entry = productMedia.find((item) => item.media_role === role);
        return entry ? (entry.media_assets as unknown as { storage_path: string }).storage_path : null;
      };
      return {
        code: row.code,
        name: row.name,
        presentation: card.hasMultipleVariants ? `${productVariants.length} variantes` : card.featuredVariant.name,
        product_type: card.category.name,
        requires_lamp: row.requires_lamp,
        lamp_type: row.lamp_type,
        description: row.description,
        unit_price: card.startingPrice,
        wholesale_price: wholesalePrices.length ? Math.min(...wholesalePrices.map((price) => Number(price.amount))) : null,
        wholesale_min_quantity: wholesalePrices.length ? Math.min(...wholesalePrices.map((price) => price.minimum_quantity)) : 1,
        availability: card.availabilitySummary.available ? "available" as const : card.availabilitySummary.consult ? "consult" as const : "sold_out" as const,
        color_chart_status: pathFor("color_chart") ? "available" as const : "consult_advisor" as const,
        main_image_path: pathFor("main") ?? card.mainImage,
        color_chart_image_path: pathFor("color_chart"),
        brand: card.brand,
        category: card.category,
        gallery: productMedia.filter((item) => item.media_role === "gallery" || item.media_role === "detail").map((item) => ({ path: (item.media_assets as unknown as { storage_path: string }).storage_path, sort_order: item.sort_order })),
        variants: productVariants.map((variant) => {
          const retail = productPrices.find((price) => price.variant_id === variant.id && (price.price_lists as unknown as { price_type: string }).price_type === "retail");
          return { sku: variant.sku, name: variant.name, availability: variant.availability, price: retail ? Number(retail.amount) : null };
        })
      };
    });

    const exportResult = await supabase.from("pdf_exports").insert({
      status: "generating",
      generated_by: user.id,
      catalog_updated_at_snapshot: metadataResult.data?.content_updated_at ?? null,
      parameters,
      exported_product_ids: productIds,
      item_count: productIds.length
    }).select("id").single();
    if (exportResult.error) throw exportResult.error;
    exportId = exportResult.data.id;

    const pdf = await renderCatalogPdf({ products: pdfProducts, settings: settingsResult.data, generatedAt });
    const path = pdfPath(generatedAt);
    const uploadResult = await supabase.storage.from("catalog-pdfs").upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (uploadResult.error) throw uploadResult.error;

    const updateResult = await supabase.from("pdf_exports").update({ status: "updated", storage_path: path, generated_at: generatedAt.toISOString(), error_message: null }).eq("id", exportId).select("id, status, storage_path, generated_at, catalog_updated_at_snapshot, error_message, created_at, updated_at, parameters, item_count").single();
    if (updateResult.error) throw updateResult.error;
    return ok(updateResult.data, 201);
  } catch (error) {
    logServerEvent("pdf_failure", {
      route: "/api/admin/pdf/generate",
      code: "pdf_generation_failed",
      message: error instanceof Error ? error.message : "PDF generation failed."
    });
    if (exportId) {
      try {
        const { supabase } = await requireAdmin();
        await supabase.from("pdf_exports").update({ status: "error", error_message: error instanceof Error ? error.message : "PDF generation failed." }).eq("id", exportId);
      } catch { /* Se conserva el error original. */ }
    }
    return handleApiError(error);
  }
}
