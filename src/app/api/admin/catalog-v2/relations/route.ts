import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { uuidSchema } from "@/lib/catalog/validation";
import { isSafeStripLashAdhesive } from "@/lib/admin/relation-recommendations";
import { isRelationCandidateAllowed, relationCandidateTemplateCodes } from "@/lib/admin/relation-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  exclude: uuidSchema.optional(),
  purpose: z.enum(["strip_lash_adhesive"]).optional(),
  brand: uuidSchema.optional(),
  scope: z.enum(["same_type", "compatible", "all"]).default("all"),
  source_template: z.string().trim().regex(/^[A-Z0-9_]{2,80}$/).optional(),
  accessory_domain: z.enum(["nails", "lashes", "barber", "equipment", "universal"]).optional(),
  adhesive_application: z.enum(["strip-lashes", "extensions", "both"]).optional(),
  adhesive_brand_scope: z.enum(["universal", "same-brand", "specific-brand", "unconfirmed"]).optional()
});

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireAdmin();
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));

    let adhesiveTemplateId: string | null = null;
    if (input.purpose === "strip_lash_adhesive") {
      const { data, error } = await supabase.from("attribute_templates").select("id").eq("code", "ADHESIVO_PRO").eq("is_active", true).maybeSingle();
      if (error) throw error;
      adhesiveTemplateId = data?.id ?? null;
      if (!adhesiveTemplateId) return ok([]);
    }

    let relationTemplateIds: string[] | null = null;
    if (!input.purpose && input.source_template && input.scope !== "all") {
      const templateCodes = relationCandidateTemplateCodes({
        templateCode: input.source_template,
        accessoryDomain: input.accessory_domain
      }, input.scope);
      const { data, error } = await supabase.from("attribute_templates").select("id").in("code", templateCodes ?? []);
      if (error) throw error;
      relationTemplateIds = (data ?? []).map((template) => template.id);
      if (!relationTemplateIds.length) return ok([]);
    }

    // El contrato decide qué coincide y en qué orden, con la misma
    // normalización que el POS y el catálogo. Los filtros de plantilla siguen
    // aquí porque dependen del propósito de la relación, que es de esta ruta.
    const plantillas = adhesiveTemplateId ? [adhesiveTemplateId] : relationTemplateIds;
    const { data: ids, error: errorBusqueda } = await supabase.rpc("admin_relation_search", {
      p_query: input.q ?? null,
      p_template_ids: plantillas ?? null,
      p_exclude: input.exclude ?? null,
      p_limit: 50
    });
    if (errorBusqueda) throw errorBusqueda;

    const idsCoincidentes: string[] = ids ?? [];
    if (!idsCoincidentes.length) return ok([]);

    const { data, error } = await supabase
      .from("products")
      .select("id, code, name, slug, brand_id, product_line_id, template_id, category_id")
      .in("id", idsCoincidentes);
    if (error) throw error;

    // El orden es del contrato; `in` no lo conserva.
    const porId = new Map((data ?? []).map((product) => [product.id, product]));
    const products = idsCoincidentes.map((id) => porId.get(id)).filter(Boolean) as NonNullable<typeof data>;
    if (!products.length) return ok([]);

    const productIds = products.map((product) => product.id);
    const brandIds = [...new Set([...products.map((product) => product.brand_id), ...(input.brand ? [input.brand] : [])])];
    const templateIds = [...new Set(products.map((product) => product.template_id).filter(Boolean))];
    const categoryIds = [...new Set(products.map((product) => product.category_id))];
    const [brandsResult, templatesResult, categoriesResult, valuesResult] = await Promise.all([
      supabase.from("brands").select("id, name, is_generic").in("id", brandIds),
      supabase.from("attribute_templates").select("id, code").in("id", templateIds),
      supabase.from("categories").select("id, slug").in("id", categoryIds),
      supabase.from("product_attribute_values").select("product_id, attribute_definition_id, option_id, value_text, value_number, value_boolean").in("product_id", productIds)
    ]);
    for (const result of [brandsResult, templatesResult, categoriesResult, valuesResult]) {
      if (result.error) throw result.error;
    }

    const values = valuesResult.data ?? [];
    const definitionIds = [...new Set(values.map((value) => value.attribute_definition_id))];
    const optionIds = [...new Set(values.map((value) => value.option_id).filter(Boolean))];
    const definitionsResult = definitionIds.length
      ? await supabase.from("attribute_definitions").select("id, code").in("id", definitionIds)
      : { data: [], error: null };
    const optionsResult = optionIds.length
      ? await supabase.from("attribute_options").select("id, value").in("id", optionIds)
      : { data: [], error: null };
    if (definitionsResult.error) throw definitionsResult.error;
    if (optionsResult.error) throw optionsResult.error;

    const brandById = new Map((brandsResult.data ?? []).map((brand) => [brand.id, brand]));
    const templateById = new Map((templatesResult.data ?? []).map((template) => [template.id, template]));
    const categoryById = new Map((categoriesResult.data ?? []).map((category) => [category.id, category]));
    const definitionCodeById = new Map((definitionsResult.data ?? []).map((definition) => [definition.id, definition.code]));
    const optionValueById = new Map((optionsResult.data ?? []).map((option) => [option.id, option.value]));
    const attributesByProduct = new Map<string, Record<string, string | number | boolean | null>>();

    for (const value of values) {
      const code = definitionCodeById.get(value.attribute_definition_id);
      if (!code) continue;
      const attributes = attributesByProduct.get(value.product_id) ?? {};
      attributes[code] = value.option_id
        ? optionValueById.get(value.option_id) ?? null
        : value.value_boolean ?? value.value_number ?? value.value_text ?? null;
      attributesByProduct.set(value.product_id, attributes);
    }

    const candidates = products.flatMap((product) => {
      const brand = brandById.get(product.brand_id);
      const template = product.template_id ? templateById.get(product.template_id) : null;
      const category = categoryById.get(product.category_id);
      if (!brand || !template || !category || !product.template_id) return [];
      return [{
        id: product.id,
        code: product.code,
        name: product.name,
        slug: product.slug,
        brandId: product.brand_id,
        brandName: brand.name,
        brandIsGeneric: brand.is_generic,
        productLineId: product.product_line_id,
        templateId: product.template_id,
        templateCode: template.code,
        categoryId: product.category_id,
        categorySlug: category.slug,
        attributes: attributesByProduct.get(product.id) ?? {}
      }];
    });

    const currentBrand = input.brand ? brandById.get(input.brand) : null;
    if (input.purpose !== "strip_lash_adhesive") {
      if (!input.source_template || input.scope === "all") return ok(candidates);
      return ok(candidates.filter((candidate) => isRelationCandidateAllowed(candidate, {
        templateCode: input.source_template!,
        brandId: input.brand,
        brandIsGeneric: currentBrand?.is_generic ?? false,
        accessoryDomain: input.accessory_domain,
        adhesiveApplication: input.adhesive_application,
        adhesiveBrandScope: input.adhesive_brand_scope
      }, input.scope)));
    }

    const safeCandidates = candidates
      .filter((candidate) => isSafeStripLashAdhesive(candidate, input.brand && currentBrand ? { id: input.brand, isGeneric: currentBrand.is_generic } : null))
      .sort((left, right) => {
        const leftUniversal = left.attributes.adhesive_brand_scope === "universal";
        const rightUniversal = right.attributes.adhesive_brand_scope === "universal";
        return Number(rightUniversal) - Number(leftUniversal) || left.name.localeCompare(right.name);
      });

    return ok(safeCandidates);
  } catch (error) {
    return handleApiError(error);
  }
}
