"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/admin";
import { createProduct, hideProduct, updateProduct } from "@/lib/catalog/product-service";
import {
  contactSettingsSchema,
  productCreateSchema,
  productUpdateSchema,
  taxonomyCreateSchema,
  taxonomyUpdateSchema,
  uuidSchema
} from "@/lib/catalog/validation";
import {
  createTaxonomy,
  hideTaxonomy,
  updateTaxonomy
} from "@/lib/catalog/taxonomy-service";

type TaxonomyTable = "brands" | "categories";

function revalidateAdmin() {
  revalidatePath("/admin");
  revalidatePath("/");
}

export async function createProductAction(input: unknown) {
  const payload = productCreateSchema.parse(input);
  const { supabase } = await requireAdmin();
  const product = await createProduct(supabase, payload);
  revalidateAdmin();
  return { data: product };
}

export async function updateProductAction(productId: string, input: unknown) {
  const id = uuidSchema.parse(productId);
  const payload = productUpdateSchema.parse(input);
  const { supabase } = await requireAdmin();
  const product = await updateProduct(supabase, id, payload);
  revalidateAdmin();
  return { data: product };
}

export async function hideProductAction(productId: string) {
  const id = uuidSchema.parse(productId);
  const { supabase } = await requireAdmin();
  const product = await hideProduct(supabase, id);
  revalidateAdmin();
  return { data: product };
}

export async function createTaxonomyAction(table: TaxonomyTable, input: unknown) {
  const payload = taxonomyCreateSchema.parse(input);
  const { supabase } = await requireAdmin();
  const item = await createTaxonomy(supabase, table, payload);
  revalidateAdmin();
  return { data: item };
}

export async function updateTaxonomyAction(table: TaxonomyTable, id: string, input: unknown) {
  const safeId = uuidSchema.parse(id);
  const payload = taxonomyUpdateSchema.parse(input);
  const { supabase } = await requireAdmin();
  const item = await updateTaxonomy(supabase, table, safeId, payload);
  revalidateAdmin();
  return { data: item };
}

export async function hideTaxonomyAction(table: TaxonomyTable, id: string) {
  const safeId = uuidSchema.parse(id);
  const { supabase } = await requireAdmin();
  const item = await hideTaxonomy(supabase, table, safeId);
  revalidateAdmin();
  return { data: item };
}

export async function updateContactSettingsAction(input: unknown) {
  const payload = contactSettingsSchema.parse(input);
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase
    .from("store_settings")
    .upsert({
      id: true,
      business_name: payload.businessName,
      whatsapp_number: payload.whatsappNumber,
      stock_notice: payload.stockNotice
    })
    .select("business_name, whatsapp_number, stock_notice, updated_at")
    .single();

  if (error) {
    throw error;
  }

  revalidateAdmin();
  return { data };
}
