import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/http";
import { slugify } from "@/lib/catalog/slug";
import type {
  productCreateSchema,
  productImageInputSchema,
  productUpdateSchema
} from "@/lib/catalog/validation";
import type { z } from "zod";

type Supabase = SupabaseClient;
type ProductCreateInput = z.infer<typeof productCreateSchema>;
type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
type ProductImageInput = z.infer<typeof productImageInputSchema>;

export const PRODUCT_SELECT = `
  id,
  code,
  slug,
  name,
  presentation,
  product_type,
  requires_lamp,
  lamp_type,
  description,
  unit_price,
  wholesale_price,
  wholesale_min_quantity,
  availability,
  color_chart_status,
  main_image_path,
  color_chart_image_path,
  color_chart_pdf_path,
  is_active,
  editorial_status,
  sort_order,
  created_at,
  updated_at,
  brand:brands(id, name, slug),
  category:categories(id, name, slug),
  gallery:product_images(id, path, alt_text, sort_order)
`;

function cleanNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function toProductInsert(input: ProductCreateInput) {
  return {
    code: input.code,
    slug: input.slug ?? slugify(`${input.code}-${input.name}`),
    brand_id: input.brandId,
    category_id: input.categoryId,
    name: input.name,
    presentation: input.presentation,
    product_type: input.productType,
    requires_lamp: input.lampType ? input.lampType !== "No" : input.requiresLamp,
    lamp_type: input.lampType ?? (input.requiresLamp ? "Sí" : "No"),
    description: cleanNullableText(input.description),
    unit_price: input.unitPrice,
    wholesale_price: input.wholesalePrice,
    wholesale_min_quantity: input.wholesaleMinQuantity,
    availability: input.availability,
    color_chart_status: input.colorChartStatus,
    main_image_path: cleanNullableText(input.mainImagePath),
    color_chart_image_path: cleanNullableText(input.colorChartImagePath),
    color_chart_pdf_path: cleanNullableText(input.colorChartPdfPath),
    is_active: input.isActive,
    sort_order: input.sortOrder
  };
}

function toProductUpdate(input: ProductUpdateInput) {
  return compact({
    code: input.code,
    slug: input.slug,
    brand_id: input.brandId,
    category_id: input.categoryId,
    name: input.name,
    presentation: input.presentation,
    product_type: input.productType,
    requires_lamp:
      input.lampType !== undefined ? input.lampType !== "No" : input.requiresLamp,
    lamp_type: input.lampType,
    description: cleanNullableText(input.description),
    unit_price: input.unitPrice,
    wholesale_price: input.wholesalePrice,
    wholesale_min_quantity: input.wholesaleMinQuantity,
    availability: input.availability,
    color_chart_status: input.colorChartStatus,
    main_image_path: cleanNullableText(input.mainImagePath),
    color_chart_image_path: cleanNullableText(input.colorChartImagePath),
    color_chart_pdf_path: cleanNullableText(input.colorChartPdfPath),
    is_active: input.isActive,
    sort_order: input.sortOrder
  });
}

function galleryRows(productId: string, gallery: ProductImageInput[]) {
  return gallery.map((image, index) => ({
    product_id: productId,
    path: image.path,
    alt_text: cleanNullableText(image.altText),
    sort_order: image.sortOrder ?? index
  }));
}

async function replaceProductGallery(
  supabase: Supabase,
  productId: string,
  gallery: ProductImageInput[]
) {
  const deleteResult = await supabase
    .from("product_images")
    .delete()
    .eq("product_id", productId);

  if (deleteResult.error) {
    throw new HttpError(400, "gallery_delete_failed", deleteResult.error.message);
  }

  if (gallery.length === 0) {
    return;
  }

  const insertResult = await supabase.from("product_images").insert(galleryRows(productId, gallery));

  if (insertResult.error) {
    throw new HttpError(400, "gallery_insert_failed", insertResult.error.message);
  }
}

export async function getProductById(supabase: Supabase, productId: string) {
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("id", productId)
    .single();

  if (error) {
    throw new HttpError(error.code === "PGRST116" ? 404 : 400, "product_lookup_failed", error.message);
  }

  return data;
}

export async function createProduct(supabase: Supabase, input: ProductCreateInput) {
  const { gallery = [] } = input;
  const categoryResult = await supabase
    .from("categories")
    .select("template_id")
    .eq("id", input.categoryId)
    .single();

  if (categoryResult.error) {
    throw new HttpError(400, "product_category_lookup_failed", categoryResult.error.message);
  }

  let templateId = categoryResult.data.template_id as string | null;

  if (!templateId) {
    const legacyTemplate = await supabase
      .from("attribute_templates")
      .select("id")
      .eq("code", "LEGACY_V1")
      .single();

    if (legacyTemplate.error) {
      throw new HttpError(400, "product_template_lookup_failed", legacyTemplate.error.message);
    }

    templateId = legacyTemplate.data.id;
  }

  const { data: atomicResult, error } = await supabase.rpc(
    "create_product_with_default_variant",
    {
      p_product: {
        code: input.code,
        slug: input.slug ?? slugify(`${input.code}-${input.name}`),
        brandId: input.brandId,
        categoryId: input.categoryId,
        templateId,
        name: input.name,
        description: cleanNullableText(input.description),
        productType: input.productType,
        requiresLamp: input.requiresLamp,
        lampType: input.lampType,
        editorialStatus: input.isActive ? "published" : "hidden",
        isActive: true
      },
      p_variant: {
        sku: input.code,
        name: input.presentation,
        variantKey: "presentation=default",
        availability: input.availability,
        retailPrice: input.unitPrice,
        wholesalePrice: input.wholesalePrice,
        wholesaleMinimum: input.wholesaleMinQuantity
      }
    }
  );

  if (error) {
    throw new HttpError(400, "product_create_failed", error.message);
  }

  const productId = String((atomicResult as { productId: string }).productId);
  const compatibilityUpdate = await supabase
    .from("products")
    .update(toProductInsert(input))
    .eq("id", productId);

  if (compatibilityUpdate.error) {
    throw new HttpError(400, "product_compatibility_update_failed", compatibilityUpdate.error.message);
  }

  if (gallery.length > 0) {
    await replaceProductGallery(supabase, productId, gallery);
  }

  return getProductById(supabase, productId);
}

export async function updateProduct(
  supabase: Supabase,
  productId: string,
  input: ProductUpdateInput
) {
  const { gallery, ...fields } = input;
  const updatePayload = toProductUpdate(fields);

  if (Object.keys(updatePayload).length > 0) {
    const { error } = await supabase
      .from("products")
      .update(updatePayload)
      .eq("id", productId);

    if (error) {
      throw new HttpError(400, "product_update_failed", error.message);
    }
  }

  if (gallery !== undefined) {
    await replaceProductGallery(supabase, productId, gallery);
  }

  return getProductById(supabase, productId);
}

export async function hideProduct(supabase: Supabase, productId: string) {
  const { data, error } = await supabase
    .from("products")
    .update({ is_active: false })
    .eq("id", productId)
    .select(PRODUCT_SELECT)
    .single();

  if (error) {
    throw new HttpError(400, "product_hide_failed", error.message);
  }

  return data;
}
