import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import type {
  AdminV2AttributeValue,
  AdminV2Bootstrap,
  AdminV2Product,
  AdminV2ProductInput,
  AdminV2VariantInput
} from "@/lib/admin/catalog-v2";

type Supabase = SupabaseClient;

function fail(code: string, error: { message: string } | null) {
  if (error) throw new HttpError(400, code, error.message);
}

function clean(value: string | null | undefined) {
  const result = value?.trim();
  return result ? result : null;
}

function attributeRow(owner: { product_id?: string; variant_id?: string }, value: AdminV2AttributeValue) {
  return {
    ...owner,
    attribute_definition_id: value.attributeDefinitionId,
    option_id: value.optionId ?? null,
    value_text: clean(value.valueText),
    value_number: value.valueNumber ?? null,
    value_boolean: value.valueBoolean ?? null,
    value_date: value.valueDate ?? null,
    value_json: value.valueJson ?? null
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function attributeValueKey(row: Record<string, unknown>, ownerColumn: "product_id" | "variant_id") {
  return stableJson([
    row[ownerColumn],
    row.attribute_definition_id,
    row.option_id ?? null,
    row.value_text ?? null,
    row.value_number === null || row.value_number === undefined ? null : Number(row.value_number),
    row.value_boolean ?? null,
    row.value_date ?? null,
    row.value_json ?? null,
  ]);
}

async function syncAttributeValues(
  supabase: Supabase,
  table: "product_attribute_values" | "variant_attribute_values",
  ownerColumn: "product_id" | "variant_id",
  ownerIds: string[],
  desiredRows: Array<Record<string, unknown>>,
  errorPrefix: string,
) {
  if (!ownerIds.length) return;
  const existingResult = await supabase
    .from(table)
    .select(`id,${ownerColumn},attribute_definition_id,option_id,value_text,value_number,value_boolean,value_date,value_json,provenance_id,needs_review`)
    .in(ownerColumn, ownerIds);
  fail(`${errorPrefix}_lookup_failed`, existingResult.error);

  const existingByKey = new Map<string, Array<{ id: string }>>();
  for (const row of existingResult.data ?? []) {
    const key = attributeValueKey(row, ownerColumn);
    const entries = existingByKey.get(key) ?? [];
    entries.push({ id: String(row.id) });
    existingByKey.set(key, entries);
  }

  const retained = new Set<string>();
  const pendingInsert: Array<Record<string, unknown>> = [];
  for (const row of desiredRows) {
    const match = existingByKey.get(attributeValueKey(row, ownerColumn))?.shift();
    if (match) retained.add(match.id);
    else pendingInsert.push(row);
  }

  const removedRows = (existingResult.data ?? [])
    .filter((row) => !retained.has(String(row.id)));
  const replacedSourcedFacts = new Set(
    removedRows
      .filter((row) => row.provenance_id)
      .map((row) => `${(row as Record<string, unknown>)[ownerColumn]}:${row.attribute_definition_id}`),
  );
  if (removedRows.length) {
    fail(`${errorPrefix}_delete_failed`, (
      await supabase.from(table).delete().in("id", removedRows.map((row) => row.id))
    ).error);
  }
  if (pendingInsert.length) {
    const reviewedRows = pendingInsert.map((row) => (
      replacedSourcedFacts.has(`${row[ownerColumn]}:${row.attribute_definition_id}`)
        ? { ...row, needs_review: true }
        : row
    ));
    fail(`${errorPrefix}_insert_failed`, (await supabase.from(table).insert(reviewedRows)).error);
  }
}

async function syncProductRelations(supabase: Supabase, productId: string, input: AdminV2ProductInput) {
  const existingResult = await supabase
    .from("product_relations")
    .select("id,target_product_id,relation_type,compatibility_status,knowledge_status")
    .eq("source_product_id", productId)
    .not("target_product_id", "is", null)
    .eq("is_active", true);
  fail("catalog_v2_relations_lookup_failed", existingResult.error);

  const existingById = new Map((existingResult.data ?? []).map((row) => [String(row.id), row]));
  const retained = new Set<string>();

  for (const [index, relation] of input.relations.entries()) {
    const existing = relation.id ? existingById.get(relation.id) : undefined;
    const semanticChanged = existing && (
      existing.target_product_id !== relation.targetProductId
      || existing.relation_type !== relation.relationType
      || existing.compatibility_status !== relation.compatibilityStatus
    );
    const row = {
      source_product_id: productId,
      target_product_id: relation.targetProductId,
      relation_type: relation.relationType,
      compatibility_status: relation.compatibilityStatus,
      notes: clean(relation.notes),
      sort_order: index,
      ...(semanticChanged ? {
        knowledge_status: "needs_evidence",
        evidence_set_id: null,
        decided_by: null,
        decided_at: null,
      } : {}),
    };

    if (existing) {
      fail("catalog_v2_relation_update_failed", (
        await supabase.from("product_relations").update(row).eq("id", existing.id)
      ).error);
      retained.add(String(existing.id));
    } else {
      fail("catalog_v2_relation_insert_failed", (
        await supabase.from("product_relations").insert(row)
      ).error);
    }
  }

  const removed = (existingResult.data ?? []).filter((row) => !retained.has(String(row.id)));
  const approvedIds = removed.filter((row) => row.knowledge_status === "approved").map((row) => row.id);
  const discardableIds = removed.filter((row) => row.knowledge_status !== "approved").map((row) => row.id);
  if (approvedIds.length) {
    fail("catalog_v2_relations_supersede_failed", (
      await supabase.from("product_relations").update({
        knowledge_status: "superseded",
        is_active: false,
        decided_at: new Date().toISOString(),
      }).in("id", approvedIds)
    ).error);
  }
  if (discardableIds.length) {
    fail("catalog_v2_relations_delete_failed", (
      await supabase.from("product_relations").delete().in("id", discardableIds)
    ).error);
  }
}

function mapAttributeValue(row: Record<string, unknown>): AdminV2AttributeValue {
  return {
    attributeDefinitionId: String(row.attribute_definition_id),
    optionId: row.option_id ? String(row.option_id) : null,
    valueText: row.value_text === null ? null : String(row.value_text),
    valueNumber: row.value_number === null ? null : Number(row.value_number),
    valueBoolean: row.value_boolean === null ? null : Boolean(row.value_boolean),
    valueDate: row.value_date === null ? null : String(row.value_date),
    valueJson: row.value_json ?? undefined
  };
}

function mimeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export async function getCatalogV2Bootstrap(supabase: Supabase): Promise<AdminV2Bootstrap> {
  const [brands, brandFamilies, productLines, productLineFamilies, colorShades, categories, paths, templates, definitions, options, associations, conditions, priceLists, products] = await Promise.all([
    supabase.from("brands").select("id, name, slug, is_generic").eq("is_active", true).order("name"),
    supabase.from("brand_product_families").select("brand_id, template_id"),
    supabase.from("product_lines").select("id, brand_id, name, slug").eq("is_active", true).order("name"),
    supabase.from("product_line_product_families").select("product_line_id, template_id"),
    supabase.from("color_shades").select("id, brand_id, product_line_id, name, code, tone_option_id, color_family_option_id, reference_color").eq("is_active", true).order("name"),
    supabase.from("categories").select("id, parent_id, template_id, name, slug").eq("is_active", true).order("sort_order"),
    supabase.from("category_paths").select("id, canonical_path, depth"),
    supabase.from("attribute_templates").select("id, code, name, description").eq("is_active", true).order("name"),
    supabase.from("attribute_definitions").select("id, code, name, data_type, unit, scope, is_required, is_variant_axis, is_filterable, sort_order, validation_rules").eq("is_active", true).order("sort_order"),
    supabase.from("attribute_options").select("id, attribute_definition_id, value, label, sort_order").eq("is_active", true).order("sort_order"),
    supabase.from("template_attributes").select("template_id, attribute_definition_id, is_required_override, scope_override, sort_order"),
    supabase.from("template_attribute_conditions").select("template_id, target_attribute_definition_id, source_attribute_definition_id, operator, expected_boolean, expected_option_id, is_required_when_visible"),
    supabase.from("price_lists").select("id, code, name, price_type, currency").eq("is_active", true).order("priority", { ascending: false }),
    supabase.from("products").select("id, code, name, slug, brand_id, product_line_id, template_id, category_id").eq("is_active", true).not("template_id", "is", null).order("name").limit(30)
  ]);

  for (const [code, result] of [["brands", brands], ["brand_families", brandFamilies], ["product_lines", productLines], ["product_line_families", productLineFamilies], ["color_shades", colorShades], ["categories", categories], ["paths", paths], ["templates", templates], ["definitions", definitions], ["options", options], ["associations", associations], ["conditions", conditions], ["price_lists", priceLists], ["products", products]] as const) {
    fail(`catalog_v2_bootstrap_${code}_failed`, result.error);
  }

  const pathById = new Map((paths.data ?? []).map((row) => [row.id, row]));
  const optionsByDefinition = new Map<string, Array<{ id: string; value: string; label: string; sortOrder: number }>>();
  for (const option of options.data ?? []) {
    const list = optionsByDefinition.get(option.attribute_definition_id) ?? [];
    list.push({ id: option.id, value: option.value, label: option.label, sortOrder: option.sort_order });
    optionsByDefinition.set(option.attribute_definition_id, list);
  }

  const mappedDefinitions = (definitions.data ?? []).map((definition) => ({
    id: definition.id,
    code: definition.code,
    name: definition.name,
    dataType: definition.data_type,
    unit: definition.unit,
    scope: definition.scope,
    isRequired: definition.is_required,
    isVariantAxis: definition.is_variant_axis,
    isFilterable: definition.is_filterable,
    sortOrder: definition.sort_order,
    validationRules: definition.validation_rules ?? {},
    options: optionsByDefinition.get(definition.id) ?? []
  }));
  const definitionById = new Map(mappedDefinitions.map((item) => [item.id, item]));
  const brandById = new Map((brands.data ?? []).map((brand) => [brand.id, brand]));
  const templateById = new Map((templates.data ?? []).map((item) => [item.id, item]));
  const categoryById = new Map((categories.data ?? []).map((category) => [category.id, category]));

  return {
    brands: (brands.data ?? []).map((brand) => ({
      id: brand.id,
      name: brand.name,
      slug: brand.slug,
      isGeneric: brand.is_generic,
      templateIds: (brandFamilies.data ?? []).filter((item) => item.brand_id === brand.id).map((item) => item.template_id)
    })),
    productLines: (productLines.data ?? []).map((line) => ({
      id: line.id,
      brandId: line.brand_id,
      name: line.name,
      slug: line.slug,
      templateIds: (productLineFamilies.data ?? []).filter((item) => item.product_line_id === line.id).map((item) => item.template_id)
    })),
    colorShades: (colorShades.data ?? []).filter((shade) => shade.tone_option_id).map((shade) => ({
      id: shade.id,
      brandId: shade.brand_id,
      productLineId: shade.product_line_id,
      name: shade.name,
      code: shade.code,
      toneOptionId: shade.tone_option_id!,
      colorFamilyOptionId: shade.color_family_option_id,
      referenceColor: shade.reference_color
    })),
    categories: (categories.data ?? []).map((category) => ({
      id: category.id,
      parentId: category.parent_id,
      templateId: category.template_id,
      name: category.name,
      slug: category.slug,
      path: pathById.get(category.id)?.canonical_path ?? category.slug,
      depth: pathById.get(category.id)?.depth ?? 0
    })),
    attributes: mappedDefinitions,
    templates: (templates.data ?? []).map((template) => ({
      id: template.id,
      code: template.code,
      name: template.name,
      description: template.description,
      attributes: (associations.data ?? [])
        .filter((association) => association.template_id === template.id)
        .map((association) => {
          const definition = definitionById.get(association.attribute_definition_id)!;
          return {
            ...definition,
            isRequired: association.is_required_override ?? definition.isRequired,
            scope: association.scope_override ?? definition.scope,
            templateSortOrder: association.sort_order,
            conditions: (conditions.data ?? [])
              .filter((condition) => condition.template_id === template.id && condition.target_attribute_definition_id === definition.id)
              .map((condition) => ({
                sourceAttributeDefinitionId: condition.source_attribute_definition_id,
                operator: condition.operator,
                expectedBoolean: condition.expected_boolean,
                expectedOptionId: condition.expected_option_id,
                isRequiredWhenVisible: condition.is_required_when_visible
              }))
          };
        })
        .sort((a, b) => a.templateSortOrder - b.templateSortOrder)
    })),
    priceLists: (priceLists.data ?? []).map((list) => ({ id: list.id, code: list.code, name: list.name, type: list.price_type, currency: list.currency })),
    relationCandidates: (products.data ?? []).flatMap((product) => {
      const brand = brandById.get(product.brand_id);
      const relationTemplate = product.template_id ? templateById.get(product.template_id) : null;
      const category = categoryById.get(product.category_id);
      if (!brand || !relationTemplate || !category || !product.template_id) return [];
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
        templateCode: relationTemplate.code,
        categoryId: product.category_id,
        categorySlug: category.slug,
        attributes: {}
      }];
    })
  };
}

export async function getCatalogV2Product(supabase: Supabase, productId: string): Promise<AdminV2Product> {
  const variantIdResult = await supabase.from("product_variants").select("id").eq("product_id", productId);
  fail("catalog_v2_variant_ids_failed", variantIdResult.error);
  const variantIds = (variantIdResult.data ?? []).map((row) => row.id);
  const [productResult, variantsResult, productAttributesResult, variantAttributesResult, pricesResult, productMediaResult, variantMediaResult, relationsResult, wholesaleRuleResult] = await Promise.all([
    supabase.from("products").select("id, code, slug, brand_id, product_line_id, category_id, template_id, name, short_description, description, editorial_status, is_active, is_featured, published_at").eq("id", productId).single(),
    supabase.from("product_variants").select("id, sku, name, variant_key, availability_status, is_default, is_active, sort_order, color_shade_id").eq("product_id", productId).order("sort_order"),
    supabase.from("product_attribute_values").select("attribute_definition_id, option_id, value_text, value_number, value_boolean, value_date, value_json").eq("product_id", productId),
    supabase.from("variant_attribute_values").select("variant_id, attribute_definition_id, option_id, value_text, value_number, value_boolean, value_date, value_json, product_variants!inner(product_id)").eq("product_variants.product_id", productId),
    supabase.from("variant_prices").select("variant_id, amount, minimum_quantity, price_lists!inner(code, price_type)").eq("is_active", true).in("variant_id", variantIds),
    supabase.from("product_media").select("product_id, variant_id, media_role, sort_order, is_primary, media_assets!inner(storage_path, mime_type, alt_text)").eq("product_id", productId),
    supabase.from("product_media").select("product_id, variant_id, media_role, sort_order, is_primary, media_assets!inner(storage_path, mime_type, alt_text)").in("variant_id", variantIds),
    supabase.from("product_relations").select("id, target_product_id, relation_type, compatibility_status, notes").eq("source_product_id", productId).eq("is_active", true),
    supabase.from("wholesale_rules").select("mixing_policy").eq("product_id", productId).eq("is_active", true).order("priority", { ascending: false }).limit(1).maybeSingle()
  ]);

  fail("catalog_v2_product_lookup_failed", productResult.error);
  if (!productResult.data) throw new HttpError(404, "catalog_v2_product_not_found", "Producto no encontrado.");
  for (const [code, result] of [["variants", variantsResult], ["product_attributes", productAttributesResult], ["variant_attributes", variantAttributesResult], ["prices", pricesResult], ["product_media", productMediaResult], ["variant_media", variantMediaResult], ["relations", relationsResult], ["wholesale_rule", wholesaleRuleResult]] as const) fail(`catalog_v2_${code}_failed`, result.error);

  const product = productResult.data;
  const variantAttributes = variantAttributesResult.data ?? [];
  const prices = pricesResult.data ?? [];
  const media = [...(productMediaResult.data ?? []), ...(variantMediaResult.data ?? [])];

  return {
    id: product.id,
    code: product.code,
    slug: product.slug,
    brandId: product.brand_id,
    productLineId: product.product_line_id,
    categoryId: product.category_id,
    templateId: product.template_id,
    name: product.name,
    shortDescription: product.short_description,
    description: product.description,
    editorialStatus: product.editorial_status,
    isActive: product.is_active,
    isFeatured: product.is_featured,
    publishedAt: product.published_at,
    productAttributes: (productAttributesResult.data ?? []).map((row) => mapAttributeValue(row)),
    variants: (variantsResult.data ?? []).map((variant) => {
      const variantPrices = prices.filter((price) => price.variant_id === variant.id);
      const retail = variantPrices.find((price) => (price.price_lists as unknown as { price_type: string }).price_type === "retail");
      const wholesale = variantPrices.find((price) => (price.price_lists as unknown as { price_type: string }).price_type === "wholesale");
      const variantMedia = media.find((entry) => entry.variant_id === variant.id && entry.is_primary);
      return {
        id: variant.id,
        sku: variant.sku ?? "",
        name: variant.name,
        variantKey: variant.variant_key,
        availability: variant.availability_status,
        isDefault: variant.is_default,
        isActive: variant.is_active,
        sortOrder: variant.sort_order,
        retailPrice: retail ? Number(retail.amount) : null,
        wholesalePrice: wholesale ? Number(wholesale.amount) : null,
        wholesaleMinimum: wholesale?.minimum_quantity ?? 1,
        attributes: variantAttributes.filter((row) => row.variant_id === variant.id).map((row) => mapAttributeValue(row)),
        colorShadeId: variant.color_shade_id,
        mediaPath: variantMedia ? (variantMedia.media_assets as unknown as { storage_path: string }).storage_path : null
      };
    }),
    media: media.filter((entry) => entry.product_id === productId).map((entry) => {
      const asset = entry.media_assets as unknown as { storage_path: string; mime_type: string; alt_text: string | null };
      return { path: asset.storage_path, role: entry.media_role, mimeType: asset.mime_type, altText: asset.alt_text, sortOrder: entry.sort_order, isPrimary: entry.is_primary };
    }),
    relations: (relationsResult.data ?? []).filter((relation) => relation.target_product_id).map((relation) => ({
      id: relation.id,
      targetProductId: relation.target_product_id!,
      relationType: relation.relation_type,
      compatibilityStatus: relation.compatibility_status,
      notes: relation.notes
    })),
    wholesaleMixingPolicy: wholesaleRuleResult.data?.mixing_policy ?? null
  };
}

async function createMediaAsset(supabase: Supabase, path: string, mimeType?: string | null, altText?: string | null) {
  const fileName = path.split("/").pop() ?? "archivo";
  const { data, error } = await supabase.from("media_assets").upsert({
    bucket: "catalog-assets",
    storage_path: path,
    file_name: fileName,
    mime_type: mimeType ?? mimeForPath(path),
    alt_text: clean(altText)
  }, { onConflict: "bucket,storage_path" }).select("id").single();
  fail("catalog_v2_media_asset_failed", error);
  return data!.id as string;
}

async function replaceCatalogV2Details(supabase: Supabase, productId: string, input: AdminV2ProductInput, variantIds: Map<AdminV2VariantInput, string>) {
  const ids = [...variantIds.values()];
  await syncAttributeValues(
    supabase,
    "product_attribute_values",
    "product_id",
    [productId],
    input.productAttributes.map((value) => attributeRow({ product_id: productId }, value)),
    "catalog_v2_product_attributes",
  );

  if (ids.length) {
    const rows = input.variants.flatMap((variant) => variant.attributes.map((value) => attributeRow({ variant_id: variantIds.get(variant)! }, value)));
    await syncAttributeValues(
      supabase,
      "variant_attribute_values",
      "variant_id",
      ids,
      rows,
      "catalog_v2_variant_attributes",
    );
  }

  fail("catalog_v2_prices_delete_failed", (await supabase.from("variant_prices").delete().in("variant_id", ids)).error);
  const { data: lists, error: listError } = await supabase.from("price_lists").select("id, price_type").in("price_type", ["retail", "wholesale"]).eq("is_active", true);
  fail("catalog_v2_price_lists_failed", listError);
  const retailListId = lists?.find((list) => list.price_type === "retail")?.id;
  const wholesaleListId = lists?.find((list) => list.price_type === "wholesale")?.id;
  const priceRows = input.variants.flatMap((variant) => {
    const variantId = variantIds.get(variant)!;
    return [
      ...(variant.retailPrice === null || !retailListId ? [] : [{ variant_id: variantId, price_list_id: retailListId, amount: variant.retailPrice, minimum_quantity: 1 }]),
      ...(variant.wholesalePrice === null || !wholesaleListId ? [] : [{ variant_id: variantId, price_list_id: wholesaleListId, amount: variant.wholesalePrice, minimum_quantity: variant.wholesaleMinimum }])
    ];
  });
  if (priceRows.length) fail("catalog_v2_prices_insert_failed", (await supabase.from("variant_prices").insert(priceRows)).error);

  fail("catalog_v2_wholesale_delete_failed", (await supabase.from("wholesale_rules").delete().eq("product_id", productId)).error);
  const wholesaleVariants = input.variants.filter((variant) => variant.wholesalePrice !== null);
  if (wholesaleVariants.length && wholesaleListId) {
    fail("catalog_v2_wholesale_insert_failed", (await supabase.from("wholesale_rules").insert({
      name: `Mayorista · ${input.name}`,
      scope_type: "product",
      product_id: productId,
      minimum_quantity: Math.min(...wholesaleVariants.map((variant) => variant.wholesaleMinimum)),
      mixing_policy: input.wholesaleMixingPolicy ?? "same_product",
      price_list_id: wholesaleListId,
      priority: 100
    })).error);
  }

  fail("catalog_v2_product_media_delete_failed", (await supabase.from("product_media").delete().eq("product_id", productId)).error);
  if (ids.length) fail("catalog_v2_variant_media_delete_failed", (await supabase.from("product_media").delete().in("variant_id", ids)).error);
  for (const [index, medium] of input.media.entries()) {
    const assetId = await createMediaAsset(supabase, medium.path, medium.mimeType, medium.altText);
    fail("catalog_v2_product_media_insert_failed", (await supabase.from("product_media").insert({ product_id: productId, media_asset_id: assetId, media_role: medium.role, sort_order: medium.sortOrder ?? index, is_primary: medium.isPrimary ?? (index === 0 || medium.role !== "gallery") })).error);
  }
  for (const variant of input.variants) {
    if (!variant.mediaPath) continue;
    const assetId = await createMediaAsset(supabase, variant.mediaPath);
    fail("catalog_v2_variant_media_insert_failed", (await supabase.from("product_media").insert({ variant_id: variantIds.get(variant), media_asset_id: assetId, media_role: "main", is_primary: true })).error);
  }

  await syncProductRelations(supabase, productId, input);
}

export async function saveCatalogV2Product(supabase: Supabase, input: AdminV2ProductInput, productId?: string) {
  const [conditionResult, mappingResult] = await Promise.all([
    supabase.from("template_attribute_conditions")
      .select("target_attribute_definition_id, source_attribute_definition_id, operator, expected_boolean, expected_option_id, is_required_when_visible")
      .eq("template_id", input.templateId),
    supabase.from("template_attributes")
      .select("attribute_definition_id, scope_override, attribute_definitions!inner(code, scope, data_type, validation_rules)")
      .eq("template_id", input.templateId)
  ]);
  fail("catalog_v2_attribute_conditions_failed", conditionResult.error);
  fail("catalog_v2_template_attributes_failed", mappingResult.error);

  const definitionByAttribute = new Map((mappingResult.data ?? []).map((mapping) => {
    const definition = mapping.attribute_definitions as unknown as {
      code: string;
      scope: "product" | "variant" | "both";
      data_type: string;
      validation_rules: { min?: number; max?: number };
    };
    return [mapping.attribute_definition_id, { ...definition, validation_rules: definition.validation_rules ?? {}, scope: mapping.scope_override ?? definition.scope }] as const;
  }));
  const validateMappedValues = (values: AdminV2AttributeValue[], ownerScope: "product" | "variant") => {
    const seen = new Set<string>();
    for (const value of values) {
      const definition = definitionByAttribute.get(value.attributeDefinitionId);
      if (!definition || (definition.scope !== ownerScope && definition.scope !== "both")) {
        throw new HttpError(400, "catalog_v2_stale_attribute", "Se recibió un campo antiguo o que no corresponde al tipo de producto seleccionado.");
      }
      if (seen.has(value.attributeDefinitionId)) {
        throw new HttpError(400, "catalog_v2_duplicate_attribute", "Un mismo campo fue enviado más de una vez.");
      }
      seen.add(value.attributeDefinitionId);
      if (value.valueNumber !== null && value.valueNumber !== undefined) {
        if (definition.validation_rules.min !== undefined && value.valueNumber < definition.validation_rules.min) {
          throw new HttpError(400, "catalog_v2_attribute_below_minimum", `El valor de ${definition.code} es menor que el mínimo permitido.`);
        }
        if (definition.validation_rules.max !== undefined && value.valueNumber > definition.validation_rules.max) {
          throw new HttpError(400, "catalog_v2_attribute_above_maximum", `El valor de ${definition.code} supera el máximo permitido.`);
        }
      }
      if (definition.data_type === "json" && (value.valueJson === null || value.valueJson === undefined)) {
        throw new HttpError(400, "catalog_v2_invalid_json_attribute", `El valor de ${definition.code} debe ser JSON válido.`);
      }
    }
  };
  validateMappedValues(input.productAttributes, "product");
  for (const variant of input.variants) validateMappedValues(variant.attributes, "variant");
  const productNumber = (code: string) => {
    const entry = [...definitionByAttribute.entries()].find(([, definition]) => definition.code === code);
    return entry ? input.productAttributes.find((value) => value.attributeDefinitionId === entry[0])?.valueNumber : undefined;
  };
  for (const [lowerCode, upperCode] of [["humidity_min", "humidity_max"], ["temperature_min", "temperature_max"], ["rpm_min", "rpm_max"]] as const) {
    const lower = productNumber(lowerCode);
    const upper = productNumber(upperCode);
    if (lower !== null && lower !== undefined && upper !== null && upper !== undefined && lower > upper) {
      throw new HttpError(400, "catalog_v2_invalid_attribute_range", "El valor mínimo de un rango no puede superar su valor máximo.");
    }
  }

  for (const condition of conditionResult.data ?? []) {
    const source = input.productAttributes.find((value) => value.attributeDefinitionId === condition.source_attribute_definition_id);
    const targetExists = input.productAttributes.some((value) => value.attributeDefinitionId === condition.target_attribute_definition_id);
    const matches = condition.operator === "equals_boolean"
      ? source?.valueBoolean === condition.expected_boolean
      : condition.operator === "equals_option"
        ? source?.optionId === condition.expected_option_id
        : condition.operator === "not_equals_option"
          ? Boolean(source?.optionId) && source?.optionId !== condition.expected_option_id
          : Boolean(source);
    if (!matches && targetExists) throw new HttpError(400, "catalog_v2_conditional_attribute_not_applicable", "Se informó un campo que no corresponde según la respuesta anterior.");
    if (matches && condition.is_required_when_visible && !targetExists) throw new HttpError(400, "catalog_v2_conditional_attribute_required", "Falta completar un campo obligatorio según la respuesta anterior.");
  }

  const desiredDefault = input.variants.find((variant) => variant.isDefault && variant.isActive)!;
  let id = productId;
  let createdDefaultId: string | undefined;

  if (!id) {
    const { data, error } = await supabase.rpc("create_product_with_default_variant", {
      p_product: {
        code: input.code,
        slug: input.slug,
        brandId: input.brandId,
        categoryId: input.categoryId,
        templateId: input.templateId,
        name: input.name,
        shortDescription: input.shortDescription,
        description: input.description,
        editorialStatus: "draft",
        isActive: input.isActive,
        isFeatured: input.isFeatured
      },
      p_variant: {
        sku: desiredDefault.sku,
        name: desiredDefault.name,
        variantKey: desiredDefault.variantKey,
        availability: desiredDefault.availability,
        retailPrice: desiredDefault.retailPrice ?? 0,
        ...(desiredDefault.wholesalePrice === null ? {} : { wholesalePrice: desiredDefault.wholesalePrice, wholesaleMinimum: desiredDefault.wholesaleMinimum })
      }
    });
    fail("catalog_v2_atomic_create_failed", error);
    id = String((data as { productId: string }).productId);
    createdDefaultId = String((data as { variantId: string }).variantId);
  } else {
    fail("catalog_v2_prepare_update_failed", (await supabase.from("products").update({ editorial_status: "draft", published_at: null }).eq("id", id)).error);
  }

  fail("catalog_v2_prepare_product_scope_failed", (await supabase.from("products").update({
    brand_id: input.brandId,
    product_line_id: input.productLineId ?? null,
    category_id: input.categoryId,
    template_id: input.templateId
  }).eq("id", id)).error);

  const variantIds = new Map<AdminV2VariantInput, string>();
  for (const [index, variant] of input.variants.entries()) {
    let variantId = variant.id ?? (variant === desiredDefault ? createdDefaultId : undefined);
    const row = {
      product_id: id,
      sku: variant.sku,
      name: variant.name,
      variant_key: variant.variantKey,
      availability_status: variant.availability,
      color_shade_id: variant.colorShadeId ?? null,
      is_active: variant.isActive,
      sort_order: index
    };
    if (variantId) {
      const result = await supabase.from("product_variants").update(row).eq("id", variantId).eq("product_id", id).select("id").single();
      fail("catalog_v2_variant_update_failed", result.error);
    } else {
      const result = await supabase.from("product_variants").insert({ ...row, is_default: false }).select("id").single();
      fail("catalog_v2_variant_create_failed", result.error);
      variantId = result.data!.id;
    }
    variantIds.set(variant, variantId!);
  }

  const desiredDefaultId = variantIds.get(desiredDefault)!;
  fail("catalog_v2_default_replace_failed", (await supabase.rpc("replace_default_variant", { p_product_id: id, p_variant_id: desiredDefaultId })).error);
  const keepIds = [...variantIds.values()];
  const existing = await supabase.from("product_variants").select("id").eq("product_id", id);
  fail("catalog_v2_variant_lookup_failed", existing.error);
  const deactivate = (existing.data ?? []).map((row) => row.id).filter((variantId) => !keepIds.includes(variantId));
  if (deactivate.length) fail("catalog_v2_variant_deactivate_failed", (await supabase.from("product_variants").update({ is_active: false, is_default: false, color_shade_id: null }).in("id", deactivate)).error);

  await replaceCatalogV2Details(supabase, id, input, variantIds);

  const defaultPrice = desiredDefault.retailPrice ?? 0;
  const defaultWholesale = desiredDefault.wholesalePrice ?? defaultPrice;
  const finalProduct = {
    code: input.code,
    slug: input.slug,
    brand_id: input.brandId,
    product_line_id: input.productLineId ?? null,
    category_id: input.categoryId,
    template_id: input.templateId,
    name: input.name,
    short_description: clean(input.shortDescription),
    description: clean(input.description),
    editorial_status: input.editorialStatus,
    is_active: input.isActive,
    is_featured: input.isFeatured,
    published_at: input.editorialStatus === "published" ? new Date().toISOString() : null,
    presentation: desiredDefault.name,
    product_type: "Catálogo V2",
    unit_price: defaultPrice,
    wholesale_price: defaultWholesale,
    wholesale_min_quantity: desiredDefault.wholesaleMinimum,
    availability: desiredDefault.availability,
    main_image_path: input.media.find((medium) => medium.role === "main")?.path ?? null,
    color_chart_image_path: input.media.find((medium) => medium.role === "color_chart")?.path ?? null,
    color_chart_pdf_path: input.media.find((medium) => medium.role === "catalog_pdf")?.path ?? null
  };
  fail("catalog_v2_product_finalize_failed", (await supabase.from("products").update(finalProduct).eq("id", id)).error);
  return getCatalogV2Product(supabase, id);
}
