import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import { getCatalogV2Bootstrap, saveCatalogV2Product } from "@/lib/admin/catalog-v2-service";
import type {
  AdminV2AttributeValue,
  AdminV2ProductInput,
  AdminV2RelationInput,
  AdminV2TemplateAttribute
} from "@/lib/admin/catalog-v2";
import { adminV2ProductSchema } from "@/lib/catalog/validation";
import type {
  CatalogImportCommitResult,
  CatalogImportIssue,
  CatalogImportProductLineApproval,
  CatalogImportPreview
} from "@/lib/admin/catalog-import-types";
import type {
  CatalogImportRawRow,
  CatalogImportWorkbook
} from "@/lib/admin/catalog-import-xlsx";

type Supabase = SupabaseClient;

type SelectedRow = CatalogImportRawRow;

type TonePlan = {
  row: number;
  brandId: string;
  productLineId: string | null;
  code: string;
  name: string;
  colorFamilyOptionId: string;
  referenceColor: string | null;
  scopeKey: string;
};

type ProductLinePlan = {
  key: string;
  virtualId: string;
  firstRow: number;
  brandId: string;
  brandSlug: string;
  brandName: string;
  slug: string;
  suggestedName: string;
  templateIds: string[];
  templateCodes: string[];
};

type ResolvedProductLine = {
  id: string;
  brandId: string;
  name: string;
  slug: string;
  templateIds: string[];
  proposal?: ProductLinePlan;
};

type RelationPlan = {
  row: number;
  targetCode: string;
  relationType: AdminV2RelationInput["relationType"];
  compatibilityStatus: AdminV2RelationInput["compatibilityStatus"];
  notes: string | null;
  sortOrder: number;
};

type ProductPlan = {
  row: number;
  input: AdminV2ProductInput;
  relationPlans: RelationPlan[];
  raw: Record<string, unknown>;
};

export type CatalogImportAnalysis = {
  preview: CatalogImportPreview;
  plans: ProductPlan[];
  productLinesToCreate: ProductLinePlan[];
  tonesToCreate: TonePlan[];
};

const EDITORIAL_STATUSES = new Set(["draft", "in_review", "published", "hidden", "incomplete"]);
const AVAILABILITY = new Set(["available", "sold_out", "consult"]);
const MEDIA_ROLES = new Set(["main", "gallery", "color_chart", "technical_sheet", "catalog_pdf", "swatch", "packaging", "detail"]);
const RELATION_TYPES = new Set(["spare_part_for", "accessory_for", "replacement_for", "requires", "included_with", "recommended_with", "compatible_with", "alternative_to"]);
const COMPATIBILITY = new Set(["unknown", "conditional", "confirmed", "not_compatible"]);
const PSEUDO_UUID = "00000000-0000-4000-8000-000000000001";
const SAFE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

function text(row: SelectedRow, field: string) {
  const value = row[field];
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableText(row: SelectedRow, field: string) {
  return text(row, field) || null;
}

function selectedRows(rows: CatalogImportRawRow[], sheet: string, issues: CatalogImportIssue[]) {
  const result: SelectedRow[] = [];
  for (const row of rows) {
    const raw = row.importar;
    const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    if (normalized === true || normalized === 1 || normalized === "true" || normalized === "sí" || normalized === "si") {
      result.push(row);
    } else if (!(normalized === false || normalized === 0 || normalized === null || normalized === "" || normalized === "false" || normalized === "no")) {
      issues.push({ severity: "error", code: "invalid_import_flag", sheet, row: row.__row, field: "importar", message: "Usa TRUE para importar o FALSE para omitir la fila." });
    }
  }
  return result;
}

function addError(issues: CatalogImportIssue[], code: string, message: string, sheet?: string, row?: number, field?: string) {
  issues.push({ severity: "error", code, message, sheet, row, field });
}

function addWarning(issues: CatalogImportIssue[], code: string, message: string, sheet?: string, row?: number, field?: string) {
  issues.push({ severity: "warning", code, message, sheet, row, field });
}

function parseBoolean(row: SelectedRow, field: string, issues: CatalogImportIssue[], sheet: string, fallback?: boolean) {
  const value = row[field];
  if (value === true || value === 1 || (typeof value === "string" && ["true", "sí", "si", "1"].includes(value.trim().toLowerCase()))) return true;
  if (value === false || value === 0 || (typeof value === "string" && ["false", "no", "0"].includes(value.trim().toLowerCase()))) return false;
  if ((value === null || value === "") && fallback !== undefined) return fallback;
  addError(issues, "invalid_boolean", `El campo ${field} debe ser TRUE o FALSE.`, sheet, row.__row, field);
  return fallback ?? false;
}

function parseNumber(row: SelectedRow, field: string, issues: CatalogImportIssue[], sheet: string, options: { required?: boolean; integer?: boolean; min?: number; max?: number } = {}) {
  const raw = row[field];
  if (raw === null || raw === "") {
    if (options.required) addError(issues, "required_number", `Falta el valor numérico ${field}.`, sheet, row.__row, field);
    return null;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
  if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value)) || (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max)) {
    addError(issues, "invalid_number", `El valor de ${field} no es válido.`, sheet, row.__row, field);
    return null;
  }
  return value;
}

function requireText(row: SelectedRow, field: string, issues: CatalogImportIssue[], sheet: string, max = 512) {
  const value = text(row, field);
  if (!value) addError(issues, "required_text", `Falta el campo ${field}.`, sheet, row.__row, field);
  if (value.length > max) addError(issues, "text_too_long", `${field} supera ${max} caracteres.`, sheet, row.__row, field);
  return value;
}

function toneScopeKey(brandId: string, productLineId: string | null, code: string) {
  return `${brandId}|${productLineId ?? ""}|${code.trim().toLowerCase()}`;
}

function productLineScopeKey(brandId: string, slug: string) {
  return `${brandId}|${slug.trim().toLowerCase()}`;
}

function suggestedNameFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function virtualUuid(index: number) {
  return `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
}

function mediaPathIsSafe(value: string) {
  return !/^(?:https?:|data:|javascript:)|(^|\/)\.\.(?:\/|$)/i.test(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function validateMediaPath(value: string, issues: CatalogImportIssue[], sheet: string, row: number, field: string) {
  if (!mediaPathIsSafe(value)) {
    addError(issues, "invalid_media_path", `${field} debe ser una ruta interna segura de catalog-assets.`, sheet, row, field);
  }
}

function conditionMatches(condition: AdminV2TemplateAttribute["conditions"][number], values: AdminV2AttributeValue[]) {
  const source = values.find((value) => value.attributeDefinitionId === condition.sourceAttributeDefinitionId);
  if (condition.operator === "equals_boolean") return source?.valueBoolean === condition.expectedBoolean;
  if (condition.operator === "equals_option") return source?.optionId === condition.expectedOptionId;
  if (condition.operator === "not_equals_option") return Boolean(source?.optionId) && source?.optionId !== condition.expectedOptionId;
  return Boolean(source);
}

function validateRequiredAttributes(
  templateAttributes: AdminV2TemplateAttribute[],
  scope: "product" | "variant",
  values: AdminV2AttributeValue[],
  issues: CatalogImportIssue[],
  ownerLabel: string,
  row: number
) {
  for (const attribute of templateAttributes.filter((item) => item.scope === scope || item.scope === "both")) {
    const visible = attribute.conditions.every((condition) => conditionMatches(condition, values));
    const required = attribute.isRequired || attribute.conditions.some((condition) => condition.isRequiredWhenVisible && conditionMatches(condition, values));
    const exists = values.some((value) => value.attributeDefinitionId === attribute.id);
    if (visible && required && !exists) {
      addError(issues, "required_attribute_missing", `Falta el atributo obligatorio ${attribute.code} en ${ownerLabel}.`, scope === "product" ? "Atributos_producto" : "Atributos_variante", row, "attribute_code");
    }
    if (!visible && exists) {
      addError(issues, "conditional_attribute_not_applicable", `El atributo ${attribute.code} no corresponde según sus condiciones.`, scope === "product" ? "Atributos_producto" : "Atributos_variante", row, "attribute_code");
    }
  }
}

function resolveAttributeValue(
  row: SelectedRow,
  attribute: AdminV2TemplateAttribute,
  shadeByCode: Map<string, { toneOptionId: string }>,
  issues: CatalogImportIssue[],
  sheet: "Atributos_producto" | "Atributos_variante"
): AdminV2AttributeValue | null {
  const base = { attributeDefinitionId: attribute.id };
  if (["single_option", "multi_option", "color"].includes(attribute.dataType)) {
    if (attribute.code === "tone") {
      const toneCode = requireText(row, "tone_code", issues, sheet, 80).toLowerCase();
      const shade = shadeByCode.get(toneCode);
      if (!shade) {
        addError(issues, "tone_not_found", `No existe ni se declaró el tono ${toneCode}.`, sheet, row.__row, "tone_code");
        return null;
      }
      return { ...base, optionId: shade.toneOptionId };
    }
    const optionValue = requireText(row, "option_value", issues, sheet, 100);
    const option = attribute.options.find((item) => item.value.toLowerCase() === optionValue.toLowerCase());
    if (!option) {
      addError(issues, "attribute_option_not_found", `La opción ${optionValue} no existe para ${attribute.code}.`, sheet, row.__row, "option_value");
      return null;
    }
    return { ...base, optionId: option.id };
  }
  if (["integer", "decimal", "measurement"].includes(attribute.dataType)) {
    const value = parseNumber(row, "value_number", issues, sheet, { required: true, integer: attribute.dataType === "integer", min: attribute.validationRules.min, max: attribute.validationRules.max });
    return value === null ? null : { ...base, valueNumber: value };
  }
  if (attribute.dataType === "boolean") {
    return { ...base, valueBoolean: parseBoolean(row, "value_boolean", issues, sheet) };
  }
  if (attribute.dataType === "date") {
    const value = requireText(row, "value_date", issues, sheet, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      addError(issues, "invalid_date", "La fecha debe usar YYYY-MM-DD.", sheet, row.__row, "value_date");
      return null;
    }
    return { ...base, valueDate: value };
  }
  if (attribute.dataType === "json") {
    const value = requireText(row, "value_json", issues, sheet, 20_000);
    try {
      return { ...base, valueJson: JSON.parse(value) };
    } catch {
      addError(issues, "invalid_json_value", "value_json debe contener JSON válido.", sheet, row.__row, "value_json");
      return null;
    }
  }
  return { ...base, valueText: requireText(row, "value_text", issues, sheet, 2000) };
}

async function databaseConflicts(supabase: Supabase, codes: string[], slugs: string[], skus: string[]) {
  const [byCode, bySlug, bySku] = await Promise.all([
    codes.length ? supabase.from("products").select("id, code, name").in("code", codes) : Promise.resolve({ data: [], error: null }),
    slugs.length ? supabase.from("products").select("id, slug, name").in("slug", slugs) : Promise.resolve({ data: [], error: null }),
    skus.length ? supabase.from("product_variants").select("id, sku").in("sku", skus) : Promise.resolve({ data: [], error: null })
  ]);
  for (const result of [byCode, bySlug, bySku]) {
    if (result.error) throw new HttpError(400, "catalog_import_conflict_lookup_failed", result.error.message);
  }
  return {
    codes: new Set((byCode.data ?? []).map((item) => String((item as { code: string }).code).toLowerCase())),
    slugs: new Set((bySlug.data ?? []).map((item) => String((item as { slug: string }).slug).toLowerCase())),
    skus: new Set((bySku.data ?? []).map((item) => String((item as { sku: string }).sku).toLowerCase()))
  };
}

export async function analyzeCatalogImport(supabase: Supabase, workbook: CatalogImportWorkbook): Promise<CatalogImportAnalysis> {
  const issues: CatalogImportIssue[] = [];
  const products = selectedRows(workbook.sheets.Productos, "Productos", issues);
  const tones = selectedRows(workbook.sheets.Tonos, "Tonos", issues);
  const variants = selectedRows(workbook.sheets.Variantes, "Variantes", issues);
  const productAttributes = selectedRows(workbook.sheets.Atributos_producto, "Atributos_producto", issues);
  const variantAttributes = selectedRows(workbook.sheets.Atributos_variante, "Atributos_variante", issues);
  const media = selectedRows(workbook.sheets.Medios, "Medios", issues);
  const relations = selectedRows(workbook.sheets.Relaciones, "Relaciones", issues);

  if (!products.length) addError(issues, "no_products_selected", "No hay productos con importar=TRUE.", "Productos");
  const bootstrap = await getCatalogV2Bootstrap(supabase);
  const brandBySlug = new Map(bootstrap.brands.map((item) => [item.slug.toLowerCase(), item]));
  const lineByScope = new Map<string, ResolvedProductLine>(bootstrap.productLines.map((item) => [productLineScopeKey(item.brandId, item.slug), item]));
  const productLinePlansByScope = new Map<string, ProductLinePlan>();
  for (const row of products) {
    const brandSlug = text(row, "brand_slug").toLowerCase();
    const lineSlug = nullableText(row, "product_line_slug")?.toLowerCase() ?? null;
    const templateCode = text(row, "template_code").toUpperCase();
    const brand = brandBySlug.get(brandSlug);
    const template = bootstrap.templates.find((item) => item.code === templateCode);
    if (!brand || !template || !lineSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lineSlug)) continue;
    const key = productLineScopeKey(brand.id, lineSlug);
    if (lineByScope.has(key)) continue;
    const existingPlan = productLinePlansByScope.get(key);
    if (existingPlan) {
      if (!existingPlan.templateIds.includes(template.id)) {
        existingPlan.templateIds.push(template.id);
        existingPlan.templateCodes.push(template.code);
      }
      continue;
    }
    productLinePlansByScope.set(key, {
      key,
      virtualId: virtualUuid(productLinePlansByScope.size),
      firstRow: row.__row,
      brandId: brand.id,
      brandSlug: brand.slug,
      brandName: brand.name,
      slug: lineSlug,
      suggestedName: suggestedNameFromSlug(lineSlug),
      templateIds: [template.id],
      templateCodes: [template.code]
    });
  }
  const productLinePlans = [...productLinePlansByScope.values()];
  for (const plan of productLinePlans) {
    lineByScope.set(plan.key, {
      id: plan.virtualId,
      brandId: plan.brandId,
      name: plan.suggestedName,
      slug: plan.slug,
      templateIds: plan.templateIds,
      proposal: plan
    });
    addWarning(
      issues,
      "product_line_creation_proposed",
      `Se propone crear la línea ${plan.suggestedName} (${plan.slug}) para ${plan.brandName} y asociarla a ${plan.templateCodes.join(", ")}. Requiere autorización explícita.`,
      "Productos",
      plan.firstRow,
      "product_line_slug"
    );
  }
  const familyAttribute = bootstrap.attributes.find((item) => item.code === "color_family");
  const tonePlans: TonePlan[] = [];
  const shadeByScope = new Map(bootstrap.colorShades.map((item) => [toneScopeKey(item.brandId, item.productLineId, item.code), item]));
  const pendingShadeByScope = new Map<string, { toneOptionId: string; colorFamilyOptionId: string }>();
  const reportedMissingToneBrands = new Set<string>();
  const reportedMissingToneLines = new Set<string>();

  for (const row of tones) {
    const brandSlug = requireText(row, "brand_slug", issues, "Tonos", 120).toLowerCase();
    const brand = brandBySlug.get(brandSlug);
    if (!brand && !reportedMissingToneBrands.has(brandSlug)) {
      reportedMissingToneBrands.add(brandSlug);
      addError(issues, "brand_not_found", `No existe la marca ${brandSlug}.`, "Tonos", row.__row, "brand_slug");
    }
    const lineSlug = nullableText(row, "product_line_slug")?.toLowerCase() ?? null;
    const lineKey = brand && lineSlug ? productLineScopeKey(brand.id, lineSlug) : null;
    const line = lineKey ? lineByScope.get(lineKey) : null;
    if (lineSlug && !line && lineKey && !reportedMissingToneLines.has(lineKey)) {
      reportedMissingToneLines.add(lineKey);
      addError(issues, "product_line_not_declared", `La línea ${lineSlug} no existe y ningún producto seleccionado permite proponer su creación. Declárala en Productos.`, "Tonos", row.__row, "product_line_slug");
    }
    const code = requireText(row, "tone_code", issues, "Tonos", 80);
    const name = requireText(row, "tone_name", issues, "Tonos", 120);
    const familyValue = requireText(row, "color_family_value", issues, "Tonos", 100);
    const family = familyAttribute?.options.find((item) => item.value.toLowerCase() === familyValue.toLowerCase());
    if (!family) addError(issues, "color_family_not_found", `No existe la familia cromática ${familyValue}.`, "Tonos", row.__row, "color_family_value");
    const referenceColor = nullableText(row, "reference_color");
    if (referenceColor && !/^#[0-9A-Fa-f]{6}$/.test(referenceColor)) addError(issues, "invalid_reference_color", "reference_color debe usar #RRGGBB.", "Tonos", row.__row, "reference_color");
    const active = parseBoolean(row, "is_active", issues, "Tonos", true);
    if (!active) addWarning(issues, "inactive_tone_ignored", `El tono ${code} está inactivo y no se creará.`, "Tonos", row.__row, "is_active");
    if (!brand || (lineSlug && !line) || !family || !code || !name || !active) continue;
    const scopeKey = toneScopeKey(brand.id, line?.id ?? null, code);
    const existing = shadeByScope.get(scopeKey);
    if (existing) {
      if (existing.name.trim().toLowerCase() !== name.toLowerCase() || existing.colorFamilyOptionId !== family.id) {
        addError(issues, "tone_conflict", `El tono ${code} ya existe con nombre o familia diferente.`, "Tonos", row.__row, "tone_code");
      }
      continue;
    }
    if (pendingShadeByScope.has(scopeKey)) {
      addError(issues, "duplicate_tone", `El tono ${code} está repetido en el archivo.`, "Tonos", row.__row, "tone_code");
      continue;
    }
    tonePlans.push({ row: row.__row, brandId: brand.id, productLineId: line?.id ?? null, code, name, colorFamilyOptionId: family.id, referenceColor, scopeKey });
    pendingShadeByScope.set(scopeKey, { toneOptionId: PSEUDO_UUID, colorFamilyOptionId: family.id });
  }

  const codes = products.map((row) => text(row, "product_code")).filter(Boolean);
  const slugs = products.map((row) => text(row, "slug")).filter(Boolean);
  const skus = variants.map((row) => text(row, "sku")).filter(Boolean);
  const conflicts = await databaseConflicts(supabase, codes, slugs, skus);
  const duplicateCodes = new Set<string>();
  const duplicateSlugs = new Set<string>();
  const duplicateSkus = new Set<string>();
  const plans: ProductPlan[] = [];
  const selectedProductCodes = new Set(codes.map((item) => item.toLowerCase()));

  for (const row of products) {
    const code = requireText(row, "product_code", issues, "Productos", 64);
    const slug = requireText(row, "slug", issues, "Productos", 180).toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(code)) addError(issues, "invalid_product_code", "product_code solo admite letras, números, punto, guion y guion bajo.", "Productos", row.__row, "product_code");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) addError(issues, "invalid_slug", "slug debe usar minúsculas y guiones.", "Productos", row.__row, "slug");
    if (duplicateCodes.has(code.toLowerCase())) addError(issues, "duplicate_product_code", `El código ${code} está repetido.`, "Productos", row.__row, "product_code");
    if (duplicateSlugs.has(slug)) addError(issues, "duplicate_product_slug", `El slug ${slug} está repetido.`, "Productos", row.__row, "slug");
    duplicateCodes.add(code.toLowerCase());
    duplicateSlugs.add(slug);
    if (conflicts.codes.has(code.toLowerCase())) addError(issues, "product_code_exists", `Ya existe un producto con código ${code}; esta versión solo crea productos nuevos.`, "Productos", row.__row, "product_code");
    if (conflicts.slugs.has(slug)) addError(issues, "product_slug_exists", `Ya existe un producto con slug ${slug}.`, "Productos", row.__row, "slug");

    const templateCode = requireText(row, "template_code", issues, "Productos", 80).toUpperCase();
    const template = bootstrap.templates.find((item) => item.code === templateCode);
    if (!template) addError(issues, "template_not_found", `No existe la plantilla ${templateCode}.`, "Productos", row.__row, "template_code");
    const categoryPath = requireText(row, "category_path", issues, "Productos", 300).toLowerCase();
    const category = bootstrap.categories.find((item) => item.path.toLowerCase() === categoryPath);
    if (!category) addError(issues, "category_not_found", `No existe la categoría ${categoryPath}.`, "Productos", row.__row, "category_path");
    if (category && template && category.templateId && category.templateId !== template.id) addError(issues, "category_template_mismatch", "La categoría no corresponde a la plantilla elegida.", "Productos", row.__row, "category_path");
    const brandSlug = requireText(row, "brand_slug", issues, "Productos", 120).toLowerCase();
    const brand = brandBySlug.get(brandSlug);
    if (!brand) addError(issues, "brand_not_found", `No existe la marca ${brandSlug}.`, "Productos", row.__row, "brand_slug");
    if (brand && template && !brand.isGeneric && !brand.templateIds.includes(template.id)) addError(issues, "brand_template_mismatch", "La marca no está habilitada para esta plantilla.", "Productos", row.__row, "brand_slug");
    const lineSlug = nullableText(row, "product_line_slug")?.toLowerCase() ?? null;
    if (lineSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lineSlug)) addError(issues, "invalid_product_line_slug", "product_line_slug debe usar minúsculas y guiones.", "Productos", row.__row, "product_line_slug");
    const line = brand && lineSlug ? lineByScope.get(productLineScopeKey(brand.id, lineSlug)) : null;
    if (lineSlug && !line) addError(issues, "product_line_not_found", `No existe la línea ${lineSlug} para esta marca.`, "Productos", row.__row, "product_line_slug");
    if (line && template && !line.templateIds.includes(template.id)) addError(issues, "line_template_mismatch", "La línea no está habilitada para esta plantilla.", "Productos", row.__row, "product_line_slug");
    const editorialStatus = requireText(row, "editorial_status", issues, "Productos", 20) || "draft";
    if (!EDITORIAL_STATUSES.has(editorialStatus)) addError(issues, "invalid_editorial_status", `Estado editorial inválido: ${editorialStatus}.`, "Productos", row.__row, "editorial_status");
    if (editorialStatus === "published") addWarning(issues, "publishes_immediately", `${code} quedará publicado inmediatamente.`, "Productos", row.__row, "editorial_status");
    const mixing = nullableText(row, "wholesale_mixing_policy") ?? "same_product";
    if (!["same_product", "same_variant"].includes(mixing)) addError(issues, "invalid_mixing_policy", "wholesale_mixing_policy debe ser same_product o same_variant.", "Productos", row.__row, "wholesale_mixing_policy");

    const productVariantRows = variants.filter((item) => text(item, "product_code").toLowerCase() === code.toLowerCase());
    if (!productVariantRows.length) addError(issues, "variants_missing", `El producto ${code} no tiene variantes seleccionadas.`, "Variantes", undefined, "product_code");
    const shadeByCode = new Map<string, { id: string; toneOptionId: string; colorFamilyOptionId: string }>();
    if (brand) {
      for (const shade of bootstrap.colorShades.filter((item) => item.brandId === brand.id && item.productLineId === (line?.id ?? null))) {
        shadeByCode.set(shade.code.toLowerCase(), shade);
      }
      for (const tone of tonePlans.filter((item) => item.brandId === brand.id && item.productLineId === (line?.id ?? null))) {
        shadeByCode.set(tone.code.toLowerCase(), { id: PSEUDO_UUID, toneOptionId: PSEUDO_UUID, colorFamilyOptionId: tone.colorFamilyOptionId });
      }
    }

    const inputVariants = productVariantRows.map((variantRow) => {
      const sku = requireText(variantRow, "sku", issues, "Variantes", 120);
      if (duplicateSkus.has(sku.toLowerCase())) addError(issues, "duplicate_sku", `El SKU ${sku} está repetido.`, "Variantes", variantRow.__row, "sku");
      duplicateSkus.add(sku.toLowerCase());
      if (conflicts.skus.has(sku.toLowerCase())) addError(issues, "sku_exists", `Ya existe el SKU ${sku}.`, "Variantes", variantRow.__row, "sku");
      const availability = requireText(variantRow, "availability", issues, "Variantes", 20);
      if (!AVAILABILITY.has(availability)) addError(issues, "invalid_availability", `Disponibilidad inválida: ${availability}.`, "Variantes", variantRow.__row, "availability");
      const toneCode = nullableText(variantRow, "tone_code")?.toLowerCase() ?? null;
      const shade = toneCode ? shadeByCode.get(toneCode) : null;
      if (toneCode && !shade) addError(issues, "tone_not_found", `No existe ni se declaró el tono ${toneCode} para la marca/línea del producto.`, "Variantes", variantRow.__row, "tone_code");
      const attributeRows = variantAttributes.filter((item) => text(item, "sku").toLowerCase() === sku.toLowerCase());
      const values: AdminV2AttributeValue[] = [];
      if (template) {
        for (const attributeRow of attributeRows) {
          const attributeCode = requireText(attributeRow, "attribute_code", issues, "Atributos_variante", 80);
          const attribute = template.attributes.find((item) => item.code === attributeCode);
          if (!attribute || !["variant", "both"].includes(attribute.scope)) {
            addError(issues, "variant_attribute_not_allowed", `El atributo ${attributeCode} no corresponde a variantes de ${template.code}.`, "Atributos_variante", attributeRow.__row, "attribute_code");
            continue;
          }
          if (values.some((item) => item.attributeDefinitionId === attribute.id)) {
            addError(issues, "duplicate_variant_attribute", `El atributo ${attributeCode} está repetido para ${sku}.`, "Atributos_variante", attributeRow.__row, "attribute_code");
            continue;
          }
          const value = resolveAttributeValue(attributeRow, attribute, shadeByCode, issues, "Atributos_variante");
          if (value) values.push(value);
        }
        validateRequiredAttributes(template.attributes, "variant", values, issues, sku, variantRow.__row);
      }
      return {
        sku,
        name: requireText(variantRow, "name", issues, "Variantes", 180),
        variantKey: requireText(variantRow, "variant_key", issues, "Variantes", 200),
        availability: (AVAILABILITY.has(availability) ? availability : "consult") as "available" | "sold_out" | "consult",
        isDefault: parseBoolean(variantRow, "is_default", issues, "Variantes", false),
        isActive: parseBoolean(variantRow, "is_active", issues, "Variantes", true),
        sortOrder: parseNumber(variantRow, "sort_order", issues, "Variantes", { integer: true, min: 0, max: 9999 }) ?? 0,
        retailPrice: parseNumber(variantRow, "retail_price_pen", issues, "Variantes", { required: true, min: 0, max: 999999 }),
        wholesalePrice: parseNumber(variantRow, "wholesale_price_pen", issues, "Variantes", { min: 0, max: 999999 }),
        wholesaleMinimum: parseNumber(variantRow, "wholesale_minimum", issues, "Variantes", { required: true, integer: true, min: 1, max: 9999 }) ?? 1,
        attributes: values,
        colorShadeId: shade?.id ?? null,
        mediaPath: nullableText(variantRow, "media_path")
      };
    }).sort((a, b) => a.sortOrder - b.sortOrder);

    const productValues: AdminV2AttributeValue[] = [];
    if (template) {
      for (const attributeRow of productAttributes.filter((item) => text(item, "product_code").toLowerCase() === code.toLowerCase())) {
        const attributeCode = requireText(attributeRow, "attribute_code", issues, "Atributos_producto", 80);
        const attribute = template.attributes.find((item) => item.code === attributeCode);
        if (!attribute || !["product", "both"].includes(attribute.scope)) {
          addError(issues, "product_attribute_not_allowed", `El atributo ${attributeCode} no corresponde a productos de ${template.code}.`, "Atributos_producto", attributeRow.__row, "attribute_code");
          continue;
        }
        if (productValues.some((item) => item.attributeDefinitionId === attribute.id)) {
          addError(issues, "duplicate_product_attribute", `El atributo ${attributeCode} está repetido para ${code}.`, "Atributos_producto", attributeRow.__row, "attribute_code");
          continue;
        }
        const value = resolveAttributeValue(attributeRow, attribute, shadeByCode, issues, "Atributos_producto");
        if (value) productValues.push(value);
      }
      validateRequiredAttributes(template.attributes, "product", productValues, issues, code, row.__row);
    }

    const productMedia = media.filter((item) => text(item, "product_code").toLowerCase() === code.toLowerCase());
    const mediaInput = productMedia.filter((item) => !nullableText(item, "sku")).map((item) => {
      const role = requireText(item, "role", issues, "Medios", 40);
      if (!MEDIA_ROLES.has(role)) addError(issues, "invalid_media_role", `Rol de medio inválido: ${role}.`, "Medios", item.__row, "role");
      const pathValue = requireText(item, "path", issues, "Medios", 512);
      validateMediaPath(pathValue, issues, "Medios", item.__row, "path");
      const mimeType = requireText(item, "mime_type", issues, "Medios", 120).toLowerCase();
      if (!SAFE_MEDIA_TYPES.has(mimeType)) addError(issues, "unsafe_media_type", `No se admite el tipo de medio ${mimeType}.`, "Medios", item.__row, "mime_type");
      const isPrimary = parseBoolean(item, "is_primary", issues, "Medios", role !== "gallery");
      return {
        path: pathValue,
        role: (MEDIA_ROLES.has(role) ? role : "gallery") as AdminV2ProductInput["media"][number]["role"],
        mimeType,
        altText: nullableText(item, "alt_text"),
        sortOrder: parseNumber(item, "sort_order", issues, "Medios", { integer: true, min: 0, max: 9999 }) ?? 0,
        isPrimary
      };
    }).sort((a, b) => a.sortOrder - b.sortOrder).map((item) => ({
      path: item.path,
      role: item.role,
      mimeType: item.mimeType,
      altText: item.altText,
      sortOrder: item.sortOrder,
      isPrimary: item.isPrimary
    }));
    if (mediaInput.filter((item) => item.role === "main").length > 1) addError(issues, "multiple_main_media", `${code} tiene más de un medio principal.`, "Medios");
    if (mediaInput.some((item) => item.role === "main") && !mediaInput.some((item) => item.role === "main" && item.isPrimary)) addError(issues, "main_media_not_primary", `${code} debe marcar su medio main con is_primary=TRUE.`, "Medios");
    for (const role of MEDIA_ROLES) {
      if (mediaInput.filter((item) => item.role === role && item.isPrimary).length > 1) addError(issues, "multiple_primary_media_role", `${code} tiene más de un medio primario para el rol ${role}.`, "Medios");
    }
    for (const variant of inputVariants) {
      if (variant.mediaPath) validateMediaPath(variant.mediaPath, issues, "Variantes", productVariantRows.find((item) => text(item, "sku").toLowerCase() === variant.sku.toLowerCase())?.__row ?? row.__row, "media_path");
      const rows = productMedia.filter((item) => text(item, "sku").toLowerCase() === variant.sku.toLowerCase());
      if (rows.length > 1) addError(issues, "multiple_variant_media", `${variant.sku} tiene más de un medio en Medios.`, "Medios");
      if (rows[0]) {
        const role = text(rows[0], "role");
        if (role !== "main" && role !== "swatch") addError(issues, "variant_media_role", "El medio de una variante debe usar role=main o role=swatch.", "Medios", rows[0].__row, "role");
        if (!parseBoolean(rows[0], "is_primary", issues, "Medios", true)) addError(issues, "variant_media_not_primary", "El medio de una variante debe usar is_primary=TRUE.", "Medios", rows[0].__row, "is_primary");
        const mediaPath = requireText(rows[0], "path", issues, "Medios", 512);
        if (variant.mediaPath && variant.mediaPath !== mediaPath) addError(issues, "variant_media_path_mismatch", "media_path de Variantes no coincide con path de Medios.", "Medios", rows[0].__row, "path");
        variant.mediaPath = mediaPath;
      }
    }

    const relationPlans: RelationPlan[] = relations.filter((item) => text(item, "source_product_code").toLowerCase() === code.toLowerCase()).map((item) => {
      const targetCode = requireText(item, "target_product_code", issues, "Relaciones", 64);
      const relationType = requireText(item, "relation_type", issues, "Relaciones", 40);
      const compatibilityStatus = requireText(item, "compatibility_status", issues, "Relaciones", 30);
      if (!RELATION_TYPES.has(relationType)) addError(issues, "invalid_relation_type", `Tipo de relación inválido: ${relationType}.`, "Relaciones", item.__row, "relation_type");
      if (!COMPATIBILITY.has(compatibilityStatus)) addError(issues, "invalid_compatibility_status", `Estado de compatibilidad inválido: ${compatibilityStatus}.`, "Relaciones", item.__row, "compatibility_status");
      if (targetCode.toLowerCase() === code.toLowerCase()) addError(issues, "self_relation", "Un producto no puede relacionarse consigo mismo.", "Relaciones", item.__row, "target_product_code");
      const notes = nullableText(item, "notes");
      if (notes && notes.length > 1000) addError(issues, "text_too_long", "notes supera 1000 caracteres.", "Relaciones", item.__row, "notes");
      return {
        row: item.__row,
        targetCode,
        relationType: (RELATION_TYPES.has(relationType) ? relationType : "recommended_with") as RelationPlan["relationType"],
        compatibilityStatus: (COMPATIBILITY.has(compatibilityStatus) ? compatibilityStatus : "unknown") as RelationPlan["compatibilityStatus"],
        notes,
        sortOrder: parseNumber(item, "sort_order", issues, "Relaciones", { integer: true, min: 0, max: 9999 }) ?? 0
      };
    }).sort((a, b) => a.sortOrder - b.sortOrder);
    if (relationPlans.length > 100) addError(issues, "too_many_relations", `${code} supera 100 relaciones.`, "Relaciones");

    if (template && category && brand && (!lineSlug || line)) {
      const input: AdminV2ProductInput = {
        code,
        slug,
        brandId: brand.id,
        productLineId: line?.id ?? null,
        categoryId: category.id,
        templateId: template.id,
        name: requireText(row, "name", issues, "Productos", 180),
        shortDescription: nullableText(row, "short_description"),
        description: nullableText(row, "description"),
        editorialStatus: (EDITORIAL_STATUSES.has(editorialStatus) ? editorialStatus : "draft") as AdminV2ProductInput["editorialStatus"],
        isActive: parseBoolean(row, "is_active", issues, "Productos", true),
        isFeatured: parseBoolean(row, "is_featured", issues, "Productos", false),
        productAttributes: productValues,
        variants: inputVariants,
        media: mediaInput,
        relations: [],
        wholesaleMixingPolicy: (mixing === "same_variant" ? "same_variant" : "same_product")
      };
      const parsed = adminV2ProductSchema.safeParse(input);
      if (!parsed.success) {
        for (const schemaIssue of parsed.error.issues) addError(issues, "product_schema_invalid", `${code}: ${schemaIssue.message}`, "Productos", row.__row, schemaIssue.path.join("."));
      }
      plans.push({ row: row.__row, input, relationPlans, raw: { ...row } });
    }
  }

  for (const row of variants) {
    if (!selectedProductCodes.has(text(row, "product_code").toLowerCase())) addError(issues, "variant_product_not_selected", `La variante apunta a un producto no seleccionado: ${text(row, "product_code")}.`, "Variantes", row.__row, "product_code");
  }
  const selectedSkus = new Set(skus.map((item) => item.toLowerCase()));
  for (const row of variantAttributes) {
    if (!selectedSkus.has(text(row, "sku").toLowerCase())) addError(issues, "attribute_variant_not_selected", `El atributo apunta a un SKU no seleccionado: ${text(row, "sku")}.`, "Atributos_variante", row.__row, "sku");
  }
  for (const row of productAttributes) {
    if (!selectedProductCodes.has(text(row, "product_code").toLowerCase())) addError(issues, "attribute_product_not_selected", `El atributo apunta a un producto no seleccionado: ${text(row, "product_code")}.`, "Atributos_producto", row.__row, "product_code");
  }
  for (const row of media) {
    if (!selectedProductCodes.has(text(row, "product_code").toLowerCase())) addError(issues, "media_product_not_selected", `El medio apunta a un producto no seleccionado: ${text(row, "product_code")}.`, "Medios", row.__row, "product_code");
  }

  const assetLocations = new Map<string, { sheet: string; row: number; field: string }>();
  for (const row of media) {
    const value = text(row, "path");
    if (value && mediaPathIsSafe(value) && !assetLocations.has(value)) assetLocations.set(value, { sheet: "Medios", row: row.__row, field: "path" });
  }
  for (const row of variants) {
    const value = text(row, "media_path");
    if (value && mediaPathIsSafe(value) && !assetLocations.has(value)) assetLocations.set(value, { sheet: "Variantes", row: row.__row, field: "media_path" });
  }
  const assetEntries = [...assetLocations.entries()];
  for (let offset = 0; offset < assetEntries.length; offset += 12) {
    const checks = await Promise.all(assetEntries.slice(offset, offset + 12).map(async ([storagePath, location]) => {
      const result = await supabase.storage.from("catalog-assets").exists(storagePath);
      const status = result.error ? (result.error as { status?: number }).status : undefined;
      if (result.error && ![400, 404].includes(status ?? 0)) throw new HttpError(502, "catalog_import_asset_lookup_failed", `No se pudo verificar ${storagePath}: ${result.error.message}`);
      return { storagePath, location, exists: result.data };
    }));
    for (const check of checks) {
      if (!check.exists) addError(issues, "media_asset_missing", `El archivo ${check.storagePath} no existe en catalog-assets. Súbelo antes de importar.`, check.location.sheet, check.location.row, check.location.field);
    }
  }

  const relationTargets = [...new Set(plans.flatMap((plan) => plan.relationPlans.map((relation) => relation.targetCode)).filter((code) => !selectedProductCodes.has(code.toLowerCase())))];
  if (relationTargets.length) {
    const result = await supabase.from("products").select("id, code").in("code", relationTargets);
    if (result.error) throw new HttpError(400, "catalog_import_relation_lookup_failed", result.error.message);
    const found = new Set((result.data ?? []).map((item) => item.code.toLowerCase()));
    for (const plan of plans) for (const relation of plan.relationPlans) {
      if (!selectedProductCodes.has(relation.targetCode.toLowerCase()) && !found.has(relation.targetCode.toLowerCase())) addError(issues, "relation_target_not_found", `No existe ni se importa el producto relacionado ${relation.targetCode}.`, "Relaciones", relation.row, "target_product_code");
    }
  }

  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  return {
    plans,
    productLinesToCreate: productLinePlans,
    tonesToCreate: tonePlans,
    preview: {
      fileName: workbook.fileName,
      fileSha256: workbook.fileSha256,
      canCommit: errors === 0 && plans.length > 0,
      security: workbook.security,
      summary: {
        products: products.length,
        variants: variants.length,
        productLinesToCreate: productLinePlans.length,
        tonesToCreate: tonePlans.length,
        productAttributes: productAttributes.length,
        variantAttributes: variantAttributes.length,
        media: media.length,
        relations: relations.length,
        warnings,
        errors
      },
      products: plans.map((plan) => ({
        code: plan.input.code,
        name: plan.input.name,
        brand: bootstrap.brands.find((item) => item.id === plan.input.brandId)?.name ?? "",
        line: [...lineByScope.values()].find((item) => item.id === plan.input.productLineId)?.name ?? null,
        variants: plan.input.variants.length,
        editorialStatus: plan.input.editorialStatus
      })),
      productLinesToCreate: productLinePlans.map((plan) => ({
        brandSlug: plan.brandSlug,
        brandName: plan.brandName,
        slug: plan.slug,
        suggestedName: plan.suggestedName,
        templateCodes: plan.templateCodes
      })),
      issues
    }
  };
}

async function insertAuditBatch(supabase: Supabase, workbook: CatalogImportWorkbook, userId: string, plans: ProductPlan[]) {
  const batch = await supabase.from("import_batches").insert({
    source_type: "xlsx",
    source_name: "catalog_v2_developer",
    original_file_name: workbook.fileName,
    status: "approved",
    total_rows: plans.length,
    created_by: userId,
    file_sha256: workbook.fileSha256,
    security_report: workbook.security
  }).select("id").single();
  if (batch.error || !batch.data) throw new HttpError(400, "catalog_import_batch_create_failed", batch.error?.message ?? "No se pudo crear la auditoría de importación.");
  const rows = await supabase.from("import_rows").insert(plans.map((plan) => ({
    batch_id: batch.data.id,
    row_number: plan.row,
    raw_data: plan.raw,
    normalized_data: { productCode: plan.input.code, productName: plan.input.name, variantCount: plan.input.variants.length },
    proposed_action: "create_product",
    status: "approved"
  }))).select("id, row_number");
  if (rows.error) throw new HttpError(400, "catalog_import_rows_create_failed", rows.error.message);
  return { batchId: batch.data.id as string, rowIdByNumber: new Map((rows.data ?? []).map((item) => [item.row_number, item.id])) };
}

function approvedProductLineNames(
  analysis: CatalogImportAnalysis,
  approvals: CatalogImportProductLineApproval[],
  confirmation: string
) {
  if (!analysis.productLinesToCreate.length) {
    if (confirmation !== "IMPORTAR") throw new HttpError(400, "catalog_import_confirmation_required", "Escribe IMPORTAR para confirmar.");
    if (approvals.length) throw new HttpError(422, "catalog_import_unexpected_structure_approval", "El archivo no propone crear líneas de producto.");
    return new Map<string, string>();
  }
  if (confirmation !== "AUTORIZAR E IMPORTAR") {
    throw new HttpError(422, "catalog_import_structure_approval_required", "Debes autorizar explícitamente la creación de las líneas propuestas.", analysis.preview);
  }
  const proposalByApprovalKey = new Map(analysis.productLinesToCreate.map((plan) => [`${plan.brandSlug.toLowerCase()}|${plan.slug}`, plan]));
  const names = new Map<string, string>();
  for (const approval of approvals) {
    const brandSlug = typeof approval?.brandSlug === "string" ? approval.brandSlug.trim().toLowerCase() : "";
    const slug = typeof approval?.slug === "string" ? approval.slug.trim().toLowerCase() : "";
    const name = typeof approval?.name === "string" ? approval.name.trim() : "";
    const plan = proposalByApprovalKey.get(`${brandSlug}|${slug}`);
    if (!plan) throw new HttpError(422, "catalog_import_unknown_structure_approval", `La autorización para ${brandSlug}/${slug} no corresponde a una propuesta vigente.`);
    if (names.has(plan.key)) throw new HttpError(422, "catalog_import_duplicate_structure_approval", `La línea ${brandSlug}/${slug} fue autorizada más de una vez.`);
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new HttpError(422, "catalog_import_invalid_product_line_name", `El nombre autorizado para ${brandSlug}/${slug} debe tener entre 1 y 120 caracteres válidos.`);
    }
    names.set(plan.key, name);
  }
  const missing = analysis.productLinesToCreate.filter((plan) => !names.has(plan.key));
  if (missing.length) {
    throw new HttpError(422, "catalog_import_structure_approval_incomplete", `Falta autorizar: ${missing.map((plan) => `${plan.brandSlug}/${plan.slug}`).join(", ")}.`, analysis.preview);
  }
  return names;
}

export async function commitCatalogImport(
  supabase: Supabase,
  userId: string,
  workbook: CatalogImportWorkbook,
  expectedSha256: string,
  approvals: CatalogImportProductLineApproval[] = [],
  confirmation = "IMPORTAR"
): Promise<CatalogImportCommitResult> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || expectedSha256 !== workbook.fileSha256) {
    throw new HttpError(409, "catalog_import_file_changed", "El archivo no coincide con la previsualización aprobada.");
  }
  let analysis = await analyzeCatalogImport(supabase, workbook);
  if (!analysis.preview.canCommit) throw new HttpError(422, "catalog_import_has_errors", "Corrige los errores antes de confirmar.", analysis.preview);
  const approvedLineNames = approvedProductLineNames(analysis, approvals, confirmation);
  const audit = await insertAuditBatch(supabase, workbook, userId, analysis.plans);
  const createdProductIds: string[] = [];
  const createdProductLineIds: string[] = [];
  const createdProductLineAssociations: Array<{ productLineId: string; templateId: string }> = [];
  const createdTones: Array<{ shadeId: string; toneOptionId: string | null }> = [];
  const created: Array<{ id: string; code: string; name: string }> = [];
  const startedAt = new Date().toISOString();

  try {
    await supabase.from("import_batches").update({ status: "parsing" }).eq("id", audit.batchId);
    for (const linePlan of analysis.productLinesToCreate) {
      let lineId: string;
      const current = await supabase.from("product_lines").select("id").eq("brand_id", linePlan.brandId).eq("slug", linePlan.slug).maybeSingle();
      if (current.error) throw new HttpError(400, "catalog_import_product_line_lookup_failed", current.error.message);
      if (current.data) {
        lineId = String(current.data.id);
      } else {
        const approvedName = approvedLineNames.get(linePlan.key);
        if (!approvedName) throw new HttpError(422, "catalog_import_structure_approval_incomplete", `Falta autorizar: ${linePlan.brandSlug}/${linePlan.slug}.`);
        const inserted = await supabase.from("product_lines").insert({
          brand_id: linePlan.brandId,
          name: approvedName,
          slug: linePlan.slug,
          is_active: true
        }).select("id").single();
        if (inserted.error) throw new HttpError(400, "catalog_import_product_line_create_failed", inserted.error.message);
        lineId = String(inserted.data.id);
        createdProductLineIds.push(lineId);
      }
      const associations = await supabase.from("product_line_product_families").select("template_id").eq("product_line_id", lineId).in("template_id", linePlan.templateIds);
      if (associations.error) throw new HttpError(400, "catalog_import_product_line_family_lookup_failed", associations.error.message);
      const existingTemplateIds = new Set((associations.data ?? []).map((item) => String(item.template_id)));
      for (const templateId of linePlan.templateIds.filter((item) => !existingTemplateIds.has(item))) {
        const association = await supabase.from("product_line_product_families").insert({ product_line_id: lineId, template_id: templateId });
        if (association.error) throw new HttpError(400, "catalog_import_product_line_family_create_failed", association.error.message);
        createdProductLineAssociations.push({ productLineId: lineId, templateId });
      }
    }
    if (analysis.productLinesToCreate.length) {
      analysis = await analyzeCatalogImport(supabase, workbook);
      if (!analysis.preview.canCommit || analysis.productLinesToCreate.length) {
        throw new HttpError(422, "catalog_import_structure_revalidation_failed", "La revalidación posterior a crear líneas de producto falló.", analysis.preview);
      }
    }
    for (const tone of analysis.tonesToCreate) {
      const result = await supabase.rpc("create_color_shade", {
        p_brand_id: tone.brandId,
        p_product_line_id: tone.productLineId,
        p_name: tone.name,
        p_code: tone.code,
        p_color_family_option_id: tone.colorFamilyOptionId,
        p_reference_color: tone.referenceColor
      });
      if (result.error) throw new HttpError(400, "catalog_import_tone_create_failed", result.error.message);
      const shadeId = String(result.data);
      createdTones.push({ shadeId, toneOptionId: null });
      const createdShade = await supabase.from("color_shades").select("tone_option_id").eq("id", shadeId).single();
      if (createdShade.error) throw new HttpError(400, "catalog_import_tone_verify_failed", createdShade.error.message);
      createdTones[createdTones.length - 1].toneOptionId = createdShade.data.tone_option_id;
    }
    if (analysis.tonesToCreate.length) analysis = await analyzeCatalogImport(supabase, workbook);
    if (!analysis.preview.canCommit) throw new HttpError(422, "catalog_import_revalidation_failed", "La revalidación posterior a crear tonos falló.", analysis.preview);

    const idByCode = new Map<string, string>();
    for (const plan of analysis.plans) {
      const product = await saveCatalogV2Product(supabase, { ...plan.input, relations: [] });
      createdProductIds.push(product.id);
      idByCode.set(plan.input.code.toLowerCase(), product.id);
      created.push({ id: product.id, code: product.code, name: product.name });
      await supabase.from("import_rows").update({ status: "committed", target_product_id: product.id }).eq("id", audit.rowIdByNumber.get(plan.row));
    }

    const externalTargets = [...new Set(analysis.plans.flatMap((plan) => plan.relationPlans.map((relation) => relation.targetCode)).filter((code) => !idByCode.has(code.toLowerCase())))];
    if (externalTargets.length) {
      const targetResult = await supabase.from("products").select("id, code").in("code", externalTargets);
      if (targetResult.error) throw new HttpError(400, "catalog_import_relation_lookup_failed", targetResult.error.message);
      for (const item of targetResult.data ?? []) idByCode.set(item.code.toLowerCase(), item.id);
    }
    const relationRows = analysis.plans.flatMap((plan) => plan.relationPlans.map((relation) => ({
      source_product_id: idByCode.get(plan.input.code.toLowerCase())!,
      target_product_id: idByCode.get(relation.targetCode.toLowerCase())!,
      relation_type: relation.relationType,
      compatibility_status: relation.compatibilityStatus,
      notes: relation.notes,
      sort_order: relation.sortOrder,
      is_active: true
    })));
    if (relationRows.length) {
      const relationInsert = await supabase.from("product_relations").insert(relationRows);
      if (relationInsert.error) throw new HttpError(400, "catalog_import_relations_create_failed", relationInsert.error.message);
    }
    await supabase.from("import_batches").update({ status: "committed", processed_rows: analysis.plans.length, error_rows: 0, committed_at: new Date().toISOString() }).eq("id", audit.batchId);
    return {
      batchId: audit.batchId,
      fileSha256: workbook.fileSha256,
      createdProductLineCount: createdProductLineIds.length,
      createdToneCount: createdTones.length,
      products: created
    };
  } catch (error) {
    await supabase.from("import_rows").update({ status: "failed", target_product_id: null, target_variant_id: null }).eq("batch_id", audit.batchId);
    const productCodes = analysis.plans.map((plan) => plan.input.code);
    if (productCodes.length) {
      const partialProducts = await supabase.from("products").select("id").in("code", productCodes).gte("created_at", startedAt);
      const partialIds = (partialProducts.data ?? []).map((item) => item.id);
      if (partialIds.length) {
        const partialVariants = await supabase.from("product_variants").select("id").in("product_id", partialIds);
        const partialVariantIds = (partialVariants.data ?? []).map((item) => item.id);
        await supabase.from("product_relations").delete().in("source_product_id", partialIds);
        await supabase.from("product_relations").delete().in("target_product_id", partialIds);
        await supabase.from("wholesale_rules").delete().in("product_id", partialIds);
        if (partialVariantIds.length) {
          await supabase.from("product_relations").delete().in("source_variant_id", partialVariantIds);
          await supabase.from("product_relations").delete().in("target_variant_id", partialVariantIds);
          await supabase.from("wholesale_rules").delete().in("variant_id", partialVariantIds);
        }
        await supabase.from("products").delete().in("id", partialIds);
      }
    } else if (createdProductIds.length) {
      await supabase.from("products").delete().in("id", createdProductIds);
    }
    const importedMediaPaths = [...new Set(analysis.plans.flatMap((plan) => [
      ...plan.input.media.map((item) => item.path),
      ...plan.input.variants.map((item) => item.mediaPath).filter((item): item is string => Boolean(item))
    ]))];
    if (importedMediaPaths.length) await supabase.from("media_assets").delete().in("storage_path", importedMediaPaths).gte("created_at", startedAt);
    for (const tone of createdTones.reverse()) {
      await supabase.from("color_shades").delete().eq("id", tone.shadeId);
      if (tone.toneOptionId) await supabase.from("attribute_options").delete().eq("id", tone.toneOptionId);
    }
    for (const association of createdProductLineAssociations.reverse()) {
      await supabase.from("product_line_product_families").delete().eq("product_line_id", association.productLineId).eq("template_id", association.templateId);
    }
    for (const productLineId of createdProductLineIds.reverse()) {
      await supabase.from("product_lines").delete().eq("id", productLineId);
    }
    await supabase.from("import_batches").update({ status: "failed", processed_rows: 0, error_rows: analysis.plans.length }).eq("id", audit.batchId);
    throw error;
  }
}
