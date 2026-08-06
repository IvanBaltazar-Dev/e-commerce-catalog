import type { AvailabilityStatus } from "@/lib/catalog/contracts";

export type EditorialStatus = "draft" | "in_review" | "published" | "hidden" | "incomplete";
export type AttributeDataType =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "single_option"
  | "multi_option"
  | "color"
  | "measurement"
  | "json";
export type AttributeScope = "product" | "variant" | "both";

export type AdminV2AttributeOption = {
  id: string;
  value: string;
  label: string;
  sortOrder: number;
};

export type AdminV2Attribute = {
  id: string;
  code: string;
  name: string;
  dataType: AttributeDataType;
  unit: string | null;
  scope: AttributeScope;
  isRequired: boolean;
  isVariantAxis: boolean;
  isFilterable: boolean;
  sortOrder: number;
  validationRules: { min?: number; max?: number };
  options: AdminV2AttributeOption[];
};

export type AdminV2AttributeCondition = {
  sourceAttributeDefinitionId: string;
  operator: "equals_boolean" | "equals_option" | "not_equals_option" | "is_set";
  expectedBoolean: boolean | null;
  expectedOptionId: string | null;
  isRequiredWhenVisible: boolean;
};

export type AdminV2TemplateAttribute = AdminV2Attribute & {
  isRequired: boolean;
  scope: AttributeScope;
  templateSortOrder: number;
  conditions: AdminV2AttributeCondition[];
};

export type AdminV2Template = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  attributes: AdminV2TemplateAttribute[];
};

export type AdminV2Category = {
  id: string;
  parentId: string | null;
  templateId: string | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
};

export type AdminV2RelationCandidate = {
  id: string;
  code: string;
  name: string;
  slug: string;
  brandId: string;
  brandName: string;
  brandIsGeneric: boolean;
  productLineId: string | null;
  templateId: string;
  templateCode: string;
  categoryId: string;
  categorySlug: string;
  attributes: Record<string, string | number | boolean | null>;
};

export type AdminV2Bootstrap = {
  brands: Array<{ id: string; name: string; slug: string; isGeneric: boolean; templateIds: string[] }>;
  productLines: Array<{ id: string; brandId: string; name: string; slug: string; templateIds: string[] }>;
  colorShades: Array<{
    id: string;
    brandId: string;
    productLineId: string | null;
    name: string;
    code: string;
    toneOptionId: string;
    colorFamilyOptionId: string;
    referenceColor: string | null;
  }>;
  categories: AdminV2Category[];
  templates: AdminV2Template[];
  attributes: AdminV2Attribute[];
  priceLists: Array<{ id: string; code: string; name: string; type: string; currency: string }>;
  relationCandidates: AdminV2RelationCandidate[];
};

export type AdminV2AttributeValue = {
  attributeDefinitionId: string;
  optionId?: string | null;
  valueText?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;
  valueDate?: string | null;
  valueJson?: unknown;
};

export type AdminV2VariantInput = {
  id?: string;
  sku: string;
  name: string;
  variantKey: string;
  availability: AvailabilityStatus;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  retailPrice: number | null;
  wholesalePrice: number | null;
  wholesaleMinimum: number;
  attributes: AdminV2AttributeValue[];
  colorShadeId?: string | null;
  mediaPath?: string | null;
};

export type AdminV2RelationInput = {
  id?: string;
  targetProductId: string;
  relationType:
    | "spare_part_for"
    | "accessory_for"
    | "replacement_for"
    | "requires"
    | "included_with"
    | "recommended_with"
    | "compatible_with"
    | "alternative_to";
  compatibilityStatus: "unknown" | "conditional" | "confirmed" | "not_compatible";
  notes?: string | null;
};

export type AdminV2ProductInput = {
  id?: string;
  code: string;
  slug: string;
  brandId: string;
  productLineId?: string | null;
  categoryId: string;
  templateId: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  editorialStatus: EditorialStatus;
  isActive: boolean;
  isFeatured: boolean;
  productAttributes: AdminV2AttributeValue[];
  variants: AdminV2VariantInput[];
  media: Array<{
    path: string;
    role: "main" | "gallery" | "color_chart" | "technical_sheet" | "catalog_pdf" | "swatch" | "packaging" | "detail";
    mimeType: string;
    altText?: string | null;
    sortOrder?: number;
    isPrimary?: boolean;
  }>;
  relations: AdminV2RelationInput[];
  wholesaleMixingPolicy?: "same_variant" | "same_product" | null;
};

export type AdminV2Product = AdminV2ProductInput & {
  id: string;
  publishedAt: string | null;
};
