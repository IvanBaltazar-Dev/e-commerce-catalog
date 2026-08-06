"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ImageSlot } from "@/components/admin/ImageSlot";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import { formatPrice } from "@/lib/admin/api";
import { isSafeStripLashAdhesive, stripLashAdhesiveRecommendationReason } from "@/lib/admin/relation-recommendations";
import { relationProductTypeLabel, type RelationSearchScope } from "@/lib/admin/relation-context";
import type {
  AdminV2Attribute,
  AdminV2AttributeValue,
  AdminV2Bootstrap,
  AdminV2ProductInput,
  AdminV2RelationCandidate,
  AdminV2RelationInput,
  AdminV2Template,
  AdminV2TemplateAttribute,
  AdminV2VariantInput,
  EditorialStatus
} from "@/lib/admin/catalog-v2";

type FormStep = 1 | 2 | 3;

type ProductTypeProfile = {
  key: string;
  label: string;
  description: string;
  example: string;
  icon: string;
  templateCodes: string[];
  categorySlugs: string[];
};

const PRODUCT_TYPES: ProductTypeProfile[] = [
  { key: "nail-polish", label: "Esmalte", description: "Tonos, fórmula y carta de colores", example: "Masglo Gel Evolution", icon: "◉", templateCodes: ["ESMALTE_TONOS"], categorySlugs: ["esmaltes", "gel-semipermanente"] },
  { key: "strip-lash", label: "Pestaña en tira", description: "Estilo, color y contenido", example: "1 o varios pares", icon: "⌒", templateCodes: ["PESTANA_TIRA"], categorySlugs: ["pestanas-en-tira"] },
  { key: "extension", label: "Extensión profesional", description: "Curva, grosor y longitud", example: "Bandejas para lashistas", icon: "≋", templateCodes: ["EXTENSIONES_PRO", "EXTENSIONES"], categorySlugs: ["extensiones-profesionales-v2", "extensiones-profesionales"] },
  { key: "adhesive", label: "Adhesivo", description: "Secado, humedad y retención", example: "Adhesivo profesional", icon: "●", templateCodes: ["ADHESIVO_PRO"], categorySlugs: ["adhesivos-profesionales"] },
  { key: "lamp", label: "Lámpara", description: "Potencia, tecnología y carga", example: "UV, LED o dual", icon: "☼", templateCodes: ["LAMPARA"], categorySlugs: ["lamparas"] },
  { key: "drill", label: "Torno o pulidor", description: "RPM, potencia y alimentación", example: "Torno profesional 35 000 RPM", icon: "⚙", templateCodes: ["TORNO_ELECTRICO"], categorySlugs: ["tornos"] },
  { key: "clipper", label: "Máquina de corte", description: "Clipper, trimmer o shaver", example: "Barbería y cabello", icon: "✂", templateCodes: ["MAQUINA_CORTE"], categorySlugs: ["maquinas-de-corte"] },
  { key: "part", label: "Accesorio o repuesto", description: "Compatibilidad y datos técnicos", example: "Cargador, fresa o micromotor", icon: "＋", templateCodes: ["ACCESORIO_REPUESTO"], categorySlugs: ["accesorios"] }
];

const RELATION_LABELS: Record<AdminV2RelationInput["relationType"], string> = {
  recommended_with: "Se recomienda con",
  compatible_with: "Es compatible con",
  spare_part_for: "Es repuesto de",
  accessory_for: "Es accesorio de",
  replacement_for: "Reemplaza a",
  requires: "Requiere",
  included_with: "Viene incluido con",
  alternative_to: "Es alternativa a"
};

const ATTRIBUTE_HELP: Record<string, string> = {
  net_content_amount: "Ingresa únicamente la cantidad; la unidad se selecciona en el campo siguiente.",
  net_content_unit: "Selecciona la unidad impresa en el envase.",
  formula_system: "Indica cómo seca o cura el esmalte.",
  requires_lamp_v2: "Elige Sí solo si el esmalte debe curarse con lámpara.",
  lamp_technology: "Selecciona la tecnología compatible indicada por el fabricante.",
  general_finish: "Selecciona el efecto visual predominante del esmalte.",
  collection: "Nombre de la colección comercial, si corresponde.",
  content_quantity: "Cantidad de pares, unidades, líneas o bandejas incluidas.",
  content_unit: "Indica cómo se contabiliza el contenido del empaque.",
  power_mode: "Indica si funciona conectado, con batería o de ambas formas.",
  charging_method: "Solo corresponde a equipos que funcionan con batería.",
  timers: "Ej. 30, 60 y 90 segundos.",
  voltage: "Selecciona el voltaje indicado por el fabricante.",
  compatibility_level: "Indica qué tan específica es la compatibilidad del accesorio.",
  compatibility_note: "Especifica marcas, familias o modelos compatibles.",
  accessory_domain: "Define el área en la que puede usarse. Esta clasificación evita sugerir, por ejemplo, un accesorio de uñas dentro de pestañas.",
  adhesive_application: "Selecciona Pestañas en tira únicamente si el fabricante autoriza ese uso. Los adhesivos para extensiones no se recomiendan para pestañas en tira.",
  adhesive_brand_scope: "Define si puede usarse con cualquier marca o si está limitado a la misma marca o a un sistema específico."
};

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function optionValue(value: string) {
  return slugify(value).slice(0, 100) || `opcion-${Date.now()}`;
}

function searchValue(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function emptyVariant(code = ""): AdminV2VariantInput {
  return {
    sku: code ? `${code}-BASE` : "",
    name: "Opción única de venta",
    variantKey: "presentation=base",
    availability: "consult",
    isDefault: true,
    isActive: true,
    sortOrder: 0,
    retailPrice: null,
    wholesalePrice: null,
    wholesaleMinimum: 3,
    attributes: [],
    colorShadeId: null,
    mediaPath: null
  };
}

function emptyForm(): AdminV2ProductInput {
  return {
    code: "",
    slug: "",
    brandId: "",
    productLineId: null,
    categoryId: "",
    templateId: "",
    name: "",
    shortDescription: "",
    description: "",
    editorialStatus: "draft",
    isActive: true,
    isFeatured: false,
    productAttributes: [],
    variants: [emptyVariant()],
    media: [],
    relations: [],
    wholesaleMixingPolicy: "same_product"
  };
}

function rawValue(value: AdminV2AttributeValue | undefined) {
  if (!value) return "";
  if (value.optionId) return value.optionId;
  if (value.valueBoolean !== null && value.valueBoolean !== undefined) return String(value.valueBoolean);
  if (value.valueNumber !== null && value.valueNumber !== undefined) return String(value.valueNumber);
  if (value.valueJson !== null && value.valueJson !== undefined) return typeof value.valueJson === "string" ? value.valueJson : JSON.stringify(value.valueJson);
  return value.valueDate ?? value.valueText ?? "";
}

function typedValue(attribute: AdminV2Attribute, raw: string): AdminV2AttributeValue | null {
  if (raw === "") return null;
  const base = { attributeDefinitionId: attribute.id };
  if (["single_option", "multi_option", "color"].includes(attribute.dataType)) return { ...base, optionId: raw };
  if (["integer", "decimal", "measurement"].includes(attribute.dataType)) return { ...base, valueNumber: Number(raw) };
  if (attribute.dataType === "boolean") return { ...base, valueBoolean: raw === "true" };
  if (attribute.dataType === "date") return { ...base, valueDate: raw };
  if (attribute.dataType === "json") {
    try {
      return { ...base, valueJson: JSON.parse(raw) };
    } catch {
      return { ...base, valueText: raw };
    }
  }
  return { ...base, valueText: raw };
}

function conditionMatches(
  condition: AdminV2TemplateAttribute["conditions"][number],
  values: AdminV2AttributeValue[]
) {
  const source = values.find((value) => value.attributeDefinitionId === condition.sourceAttributeDefinitionId);
  if (condition.operator === "equals_boolean") return source?.valueBoolean === condition.expectedBoolean;
  if (condition.operator === "equals_option") return source?.optionId === condition.expectedOptionId;
  if (condition.operator === "not_equals_option") return Boolean(source?.optionId) && source?.optionId !== condition.expectedOptionId;
  return Boolean(source);
}

function attributeIsVisible(attribute: AdminV2TemplateAttribute, values: AdminV2AttributeValue[]) {
  return attribute.conditions.every((condition) => conditionMatches(condition, values));
}

function attributeIsRequired(attribute: AdminV2TemplateAttribute, values: AdminV2AttributeValue[]) {
  return attribute.isRequired || attribute.conditions.some((condition) => condition.isRequiredWhenVisible && conditionMatches(condition, values));
}

function sanitizeProductForTemplate(input: AdminV2ProductInput, template: AdminV2Template): AdminV2ProductInput {
  const productDefinitions = template.attributes.filter((attribute) => attribute.scope === "product" || attribute.scope === "both");
  const variantDefinitions = template.attributes.filter((attribute) => attribute.scope === "variant" || attribute.scope === "both");
  const productIds = new Set(productDefinitions.map((attribute) => attribute.id));
  const variantIds = new Set(variantDefinitions.map((attribute) => attribute.id));
  const supportsColorShade = variantDefinitions.some((attribute) => attribute.code === "tone");
  const supportsColorChart = template.code === "ESMALTE_TONOS";
  let productAttributes = input.productAttributes.filter((value) => productIds.has(value.attributeDefinitionId));

  let changed = true;
  while (changed) {
    const visibleIds = new Set(productDefinitions.filter((attribute) => attributeIsVisible(attribute, productAttributes)).map((attribute) => attribute.id));
    const cleaned = productAttributes.filter((value) => {
      const definition = productDefinitions.find((attribute) => attribute.id === value.attributeDefinitionId);
      return !definition?.conditions.length || visibleIds.has(value.attributeDefinitionId);
    });
    changed = cleaned.length !== productAttributes.length;
    productAttributes = cleaned;
  }

  return {
    ...input,
    productAttributes,
    media: input.media.filter((medium) => medium.role !== "color_chart" || supportsColorChart),
    variants: input.variants.map((variant) => ({
      ...variant,
      attributes: variant.attributes.filter((value) => variantIds.has(value.attributeDefinitionId)),
      colorShadeId: supportsColorShade ? variant.colorShadeId ?? null : null
    }))
  };
}

function AttributeField({ attribute, value, onChange }: {
  attribute: AdminV2Attribute;
  value?: AdminV2AttributeValue;
  onChange: (value: AdminV2AttributeValue | null) => void;
}) {
  const common = {
    className: "input",
    value: rawValue(value),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange(typedValue(attribute, event.target.value))
  };
  const label = `${attribute.name}${attribute.isRequired ? " *" : ""}${attribute.unit ? ` (${attribute.unit})` : ""}`;
  const isNumeric = ["integer", "decimal", "measurement"].includes(attribute.dataType);
  const numericLimits = isNumeric
    ? [attribute.validationRules.min === undefined ? null : `mínimo ${attribute.validationRules.min}`, attribute.validationRules.max === undefined ? null : `máximo ${attribute.validationRules.max}`].filter(Boolean).join(" y ")
    : "";
  const help = ATTRIBUTE_HELP[attribute.code]
    ?? (isNumeric ? `Ingresa solo el valor numérico${attribute.unit ? `; se guardará en ${attribute.unit}` : ""}${numericLimits ? ` (${numericLimits})` : ""}.` : attribute.dataType === "boolean" ? "Selecciona Sí o No." : attribute.dataType === "json" ? "Usa un objeto o arreglo JSON válido." : null);
  return (
    <label className="product-field">
      <span className="field-label">{label}</span>
      {["single_option", "multi_option", "color"].includes(attribute.dataType) ? (
        <select {...common}><option value="">Seleccionar…</option>{attribute.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
      ) : attribute.dataType === "boolean" ? (
        <select {...common}><option value="">Seleccionar Sí o No…</option><option value="true">Sí</option><option value="false">No</option></select>
      ) : attribute.dataType === "json" ? (
        <textarea {...common} className="input textarea" rows={3} />
      ) : (
        <input {...common} type={isNumeric ? "number" : attribute.dataType === "date" ? "date" : "text"} min={isNumeric ? attribute.validationRules.min : undefined} max={isNumeric ? attribute.validationRules.max : undefined} step={["decimal", "measurement"].includes(attribute.dataType) ? "0.01" : undefined} />
      )}
      {help ? <small className="field-hint">{help}</small> : null}
    </label>
  );
}

function cartesian<T>(groups: T[][]): T[][] {
  return groups.reduce<T[][]>((result, group) => result.flatMap((items) => group.map((item) => [...items, item])), [[]]);
}

function templateForProfile(data: AdminV2Bootstrap, profile: ProductTypeProfile) {
  for (const code of profile.templateCodes) {
    const template = data.templates.find((item) => item.code === code);
    if (template) return template;
  }
  return null;
}

function categoryForProfile(data: AdminV2Bootstrap, profile: ProductTypeProfile, templateId: string) {
  return data.categories.find((item) => profile.categorySlugs.includes(item.slug) && item.templateId === templateId)
    ?? data.categories.find((item) => item.templateId === templateId)
    ?? null;
}

function initialFormForContext(data: AdminV2Bootstrap, typeKey?: string, initialAttributeOptions?: Record<string, string>) {
  const base = emptyForm();
  const profile = typeKey ? PRODUCT_TYPES.find((item) => item.key === typeKey) : null;
  if (!profile) return base;
  const initialTemplate = templateForProfile(data, profile);
  if (!initialTemplate) return base;
  const category = categoryForProfile(data, profile, initialTemplate.id);
  if (!category) return base;

  const productAttributes = Object.entries(initialAttributeOptions ?? {}).flatMap(([attributeCode, optionValueToSelect]) => {
    const attribute = initialTemplate.attributes.find((item) => item.code === attributeCode && (item.scope === "product" || item.scope === "both"));
    const option = attribute?.options.find((item) => item.value === optionValueToSelect);
    return attribute && option ? [{ attributeDefinitionId: attribute.id, optionId: option.id }] : [];
  });

  return {
    ...base,
    categoryId: category.id,
    templateId: initialTemplate.id,
    productAttributes,
    variants: initialTemplate.attributes.some((attribute) => attribute.isVariantAxis) ? [] : [emptyVariant()]
  };
}

function selectedProductOptionValue(
  values: AdminV2AttributeValue[],
  attributes: AdminV2TemplateAttribute[],
  code: string
) {
  const attribute = attributes.find((item) => item.code === code);
  const optionId = attribute ? values.find((value) => value.attributeDefinitionId === attribute.id)?.optionId : null;
  return attribute?.options.find((option) => option.id === optionId)?.value;
}

type CatalogV2ProductFormProps = {
  productId?: string;
  initialTypeKey?: string;
  initialAttributeOptions?: Record<string, string>;
  creationContext?: "strip-lash-adhesive";
};

export function CatalogV2ProductForm({ productId, initialTypeKey, initialAttributeOptions, creationContext }: CatalogV2ProductFormProps) {
  const router = useRouter();
  const showToast = useToast();
  const handleApiError = useApiError();
  const [bootstrap, setBootstrap] = useState<AdminV2Bootstrap | null>(null);
  const [form, setForm] = useState<AdminV2ProductInput | null>(null);
  const [step, setStep] = useState<FormStep>(productId ? 2 : 1);
  const [axisSelections, setAxisSelections] = useState<Record<string, string[]>>({});
  const [axisOptionDrafts, setAxisOptionDrafts] = useState<Record<string, string>>({});
  const [creatingOptionId, setCreatingOptionId] = useState<string | null>(null);
  const [productOptionDrafts, setProductOptionDrafts] = useState<Record<string, string>>({});
  const [showProductOptionCreatorId, setShowProductOptionCreatorId] = useState<string | null>(null);
  const [creatingProductOptionId, setCreatingProductOptionId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicateMode, setDuplicateMode] = useState(false);
  const [showBrandCreator, setShowBrandCreator] = useState(false);
  const [brandQuery, setBrandQuery] = useState("");
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [showLineCreator, setShowLineCreator] = useState(false);
  const [lineQuery, setLineQuery] = useState("");
  const [linePickerOpen, setLinePickerOpen] = useState(false);
  const [newLineName, setNewLineName] = useState("");
  const [creatingLine, setCreatingLine] = useState(false);
  const [toneQuery, setToneQuery] = useState("");
  const [toneFamilyId, setToneFamilyId] = useState<string>("");
  const [showShadeCreator, setShowShadeCreator] = useState(false);
  const [newShadeName, setNewShadeName] = useState("");
  const [newShadeCode, setNewShadeCode] = useState("");
  const [newShadeFamilyId, setNewShadeFamilyId] = useState("");
  const [newShadeReference, setNewShadeReference] = useState("#C96A82");
  const [creatingShade, setCreatingShade] = useState(false);
  const [relationQuery, setRelationQuery] = useState("");
  const [relationOptions, setRelationOptions] = useState<AdminV2Bootstrap["relationCandidates"]>([]);
  const [relationScope, setRelationScope] = useState<RelationSearchScope>("same_type");
  const [loadingRelationOptions, setLoadingRelationOptions] = useState(false);
  const [adhesiveRecommendations, setAdhesiveRecommendations] = useState<AdminV2RelationCandidate[]>([]);
  const [loadingAdhesiveRecommendations, setLoadingAdhesiveRecommendations] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.catalogV2Bootstrap();
      const product = productId ? await adminApi.getCatalogV2Product(productId) : null;
      setBootstrap(data);
      setRelationOptions([]);
      const loadedTemplate = product ? data.templates.find((item) => item.id === product.templateId) : null;
      const normalizedProduct = product && loadedTemplate
        ? sanitizeProductForTemplate({ ...product, productLineId: product.productLineId ?? null, wholesaleMixingPolicy: product.wholesaleMixingPolicy ?? "same_product" }, loadedTemplate)
        : product;
      const initialProduct = initialFormForContext(data, initialTypeKey, initialAttributeOptions);
      setForm(normalizedProduct ? { ...normalizedProduct, productLineId: normalizedProduct.productLineId ?? null, wholesaleMixingPolicy: normalizedProduct.wholesaleMixingPolicy ?? "same_product" } : initialProduct);
      if (!normalizedProduct && initialProduct.templateId) setStep(2);
      if (normalizedProduct) {
        const selections: Record<string, string[]> = {};
        for (const variant of normalizedProduct.variants) {
          for (const value of variant.attributes) {
            if (value.optionId) selections[value.attributeDefinitionId] = [...new Set([...(selections[value.attributeDefinitionId] ?? []), value.optionId])];
          }
        }
        setAxisSelections(selections);
      }
    } catch (error) {
      handleApiError(error, "No se pudo cargar el registro de productos.");
      router.replace("/admin/productos");
    }
  }, [productId, initialTypeKey, initialAttributeOptions, handleApiError, router]);

  useEffect(() => { load(); }, [load]);

  const template = useMemo(() => bootstrap?.templates.find((item) => item.id === form?.templateId) ?? null, [bootstrap, form?.templateId]);
  const selectedType = useMemo(() => template ? PRODUCT_TYPES.find((profile) => profile.templateCodes.includes(template.code)) ?? null : null, [template]);
  const productAttributes = useMemo(() => template?.attributes.filter((item) => item.scope === "product" || item.scope === "both") ?? [], [template]);
  const displayedProductAttributes = useMemo(() => {
    const values = form?.productAttributes ?? [];
    return productAttributes
      .filter((attribute) => attributeIsVisible(attribute, values))
      .map((attribute) => ({ ...attribute, isRequired: attributeIsRequired(attribute, values) }));
  }, [form?.productAttributes, productAttributes]);
  const variantAttributes = useMemo(() => template?.attributes.filter((item) => item.scope === "variant" || item.scope === "both") ?? [], [template]);
  const axes = useMemo(() => variantAttributes.filter((item) => item.isVariantAxis), [variantAttributes]);
  const selectedBrand = useMemo(() => bootstrap?.brands.find((brand) => brand.id === form?.brandId) ?? null, [bootstrap, form?.brandId]);
  const selectedProductLine = useMemo(() => bootstrap?.productLines.find((line) => line.id === form?.productLineId) ?? null, [bootstrap, form?.productLineId]);
  const selectedBrandLines = useMemo(() => bootstrap?.productLines.filter((line) => line.brandId === form?.brandId) ?? [], [bootstrap, form?.brandId]);
  const scopedBrandCount = useMemo(() => bootstrap?.brands.filter((brand) => brand.isGeneric || brand.templateIds.includes(form?.templateId ?? "")).length ?? 0, [bootstrap, form?.templateId]);
  const brandResults = useMemo(() => {
    if (!bootstrap || !form) return [];
    const query = searchValue(brandQuery);
    return bootstrap.brands
      .filter((brand) => !query || searchValue(`${brand.name} ${brand.slug}`).includes(query))
      .map((brand) => ({ ...brand, scoped: brand.isGeneric || brand.templateIds.includes(form.templateId) }))
      .filter((brand) => query || brand.scoped)
      .sort((a, b) => Number(b.scoped) - Number(a.scoped) || Number(b.isGeneric) - Number(a.isGeneric) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [bootstrap, form, brandQuery]);
  const lineResults = useMemo(() => {
    if (!form) return [];
    const query = searchValue(lineQuery);
    return selectedBrandLines
      .filter((line) => !query || searchValue(`${line.name} ${line.slug}`).includes(query))
      .map((line) => ({ ...line, scoped: line.templateIds.includes(form.templateId) }))
      .filter((line) => query || line.scoped)
      .sort((a, b) => Number(b.scoped) - Number(a.scoped) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [form, lineQuery, selectedBrandLines]);
  const includesAdhesiveAttribute = useMemo(() => productAttributes.find((attribute) => attribute.code === "includes_adhesive") ?? null, [productAttributes]);
  const includesAdhesiveValue = useMemo(() => includesAdhesiveAttribute
    ? form?.productAttributes.find((value) => value.attributeDefinitionId === includesAdhesiveAttribute.id)?.valueBoolean
    : undefined, [form?.productAttributes, includesAdhesiveAttribute]);
  const accessoryDomain = useMemo(() => form ? selectedProductOptionValue(form.productAttributes, productAttributes, "accessory_domain") : undefined, [form, productAttributes]);
  const adhesiveApplication = useMemo(() => form ? selectedProductOptionValue(form.productAttributes, productAttributes, "adhesive_application") : undefined, [form, productAttributes]);
  const adhesiveBrandScope = useMemo(() => form ? selectedProductOptionValue(form.productAttributes, productAttributes, "adhesive_brand_scope") : undefined, [form, productAttributes]);
  const shouldRecommendStripLashAdhesive = template?.code === "PESTANA_TIRA" && includesAdhesiveValue === false;
  const refreshAdhesiveRecommendations = useCallback(async (silent = false) => {
    if (!shouldRecommendStripLashAdhesive) {
      setAdhesiveRecommendations([]);
      return;
    }
    setLoadingAdhesiveRecommendations(true);
    try {
      const candidates = await adminApi.searchCatalogV2Relations("", productId, {
        purpose: "strip_lash_adhesive",
        brandId: form?.brandId || undefined
      });
      setAdhesiveRecommendations(candidates);
    } catch (error) {
      setAdhesiveRecommendations([]);
      if (!silent) handleApiError(error, "No se pudieron actualizar los pegamentos compatibles.");
    } finally {
      setLoadingAdhesiveRecommendations(false);
    }
  }, [form?.brandId, handleApiError, productId, shouldRecommendStripLashAdhesive]);

  useEffect(() => {
    if (!shouldRecommendStripLashAdhesive) {
      setAdhesiveRecommendations([]);
      return;
    }
    void refreshAdhesiveRecommendations(true);
  }, [refreshAdhesiveRecommendations, shouldRecommendStripLashAdhesive]);

  const refreshRelationOptions = useCallback(async (query = "", silent = false) => {
    if (!template) {
      setRelationOptions([]);
      return;
    }
    setLoadingRelationOptions(true);
    try {
      setRelationOptions(await adminApi.searchCatalogV2Relations(query, productId, {
        scope: relationScope,
        sourceTemplateCode: template.code,
        brandId: form?.brandId || undefined,
        accessoryDomain,
        adhesiveApplication,
        adhesiveBrandScope
      }));
    } catch (error) {
      setRelationOptions([]);
      if (!silent) handleApiError(error, "No se pudieron buscar productos relacionados.");
    } finally {
      setLoadingRelationOptions(false);
    }
  }, [accessoryDomain, adhesiveApplication, adhesiveBrandScope, form?.brandId, handleApiError, productId, relationScope, template]);

  useEffect(() => {
    void refreshRelationOptions("", true);
  }, [refreshRelationOptions]);

  const safeAdhesiveRecommendations = useMemo(() => adhesiveRecommendations.filter((candidate) => (
    isSafeStripLashAdhesive(candidate, form?.brandId && selectedBrand ? { id: form.brandId, isGeneric: selectedBrand.isGeneric } : null)
    && !form?.relations.some((relation) => relation.targetProductId === candidate.id)
  )), [adhesiveRecommendations, form?.brandId, form?.relations, selectedBrand]);

  const combinedRelationOptions = useMemo(() => {
    const byId = new Map<string, AdminV2RelationCandidate>();
    for (const candidate of [...relationOptions, ...adhesiveRecommendations]) byId.set(candidate.id, candidate);
    const selectedRelationIds = new Set(form?.relations.map((relation) => relation.targetProductId) ?? []);
    for (const candidate of bootstrap?.relationCandidates ?? []) {
      if (selectedRelationIds.has(candidate.id)) byId.set(candidate.id, candidate);
    }
    return [...byId.values()];
  }, [adhesiveRecommendations, bootstrap?.relationCandidates, form?.relations, relationOptions]);
  const toneAxis = useMemo(() => axes.find((axis) => axis.code === "tone") ?? null, [axes]);
  const colorFamilyAttribute = useMemo(() => variantAttributes.find((attribute) => attribute.code === "color_family") ?? null, [variantAttributes]);
  const shadeResults = useMemo(() => {
    if (!bootstrap || !form?.brandId) return [];
    const query = searchValue(toneQuery);
    return bootstrap.colorShades
      .filter((shade) => shade.brandId === form.brandId)
      .filter((shade) => form.productLineId ? shade.productLineId === form.productLineId || shade.productLineId === null : shade.productLineId === null)
      .filter((shade) => !toneFamilyId || shade.colorFamilyOptionId === toneFamilyId)
      .filter((shade) => !query || searchValue(`${shade.name} ${shade.code}`).includes(query))
      .slice(0, 12);
  }, [bootstrap, form?.brandId, form?.productLineId, toneFamilyId, toneQuery]);

  function patch(partial: Partial<AdminV2ProductInput>) {
    setForm((current) => current ? { ...current, ...partial } : current);
  }

  function resetVariantContext() {
    setAxisSelections({});
    setAxisOptionDrafts({});
    setToneQuery("");
    setToneFamilyId("");
    setShowShadeCreator(false);
    setNewShadeName("");
    setNewShadeCode("");
    setNewShadeFamilyId("");
    setNewShadeReference("#C96A82");
  }

  function resetProductTypeContext() {
    resetVariantContext();
    setProductOptionDrafts({});
    setShowProductOptionCreatorId(null);
    setBrandQuery("");
    setBrandPickerOpen(false);
    setShowBrandCreator(false);
    setNewBrandName("");
    setLineQuery("");
    setLinePickerOpen(false);
    setShowLineCreator(false);
    setNewLineName("");
  }

  function chooseBrand(brandId: string) {
    if (!form) return;
    patch({ brandId, productLineId: null, variants: axes.length ? [] : [emptyVariant(form.code)] });
    resetVariantContext();
  }

  function chooseProductLine(productLineId: string | null) {
    if (!form) return;
    patch({ productLineId, variants: axes.length ? [] : [emptyVariant(form.code)] });
    resetVariantContext();
  }

  function chooseProductType(profile: ProductTypeProfile) {
    if (!bootstrap || !form) return;
    const nextTemplate = templateForProfile(bootstrap, profile);
    if (!nextTemplate) {
      showToast(`El tipo de producto ${profile.label} aún no tiene sus campos configurados.`);
      return;
    }
    const category = categoryForProfile(bootstrap, profile, nextTemplate.id);
    if (!category) {
      showToast(`No se encontró la categoría interna para ${profile.label}.`);
      return;
    }
    patch({
      categoryId: category.id,
      templateId: nextTemplate.id,
      brandId: "",
      productLineId: null,
      productAttributes: [],
      variants: nextTemplate.attributes.some((attribute) => attribute.isVariantAxis) ? [] : [emptyVariant(form.code)],
      media: form.media.filter((medium) => medium.role === "main" || medium.role === "gallery"),
      relations: [],
      wholesaleMixingPolicy: "same_product"
    });
    setAdhesiveRecommendations([]);
    setRelationScope("same_type");
    setRelationQuery("");
    setRelationOptions([]);
    resetProductTypeContext();
    setStep(2);
  }

  function setProductAttribute(attribute: AdminV2TemplateAttribute, next: AdminV2AttributeValue | null) {
    if (!form) return;
    let values = [...form.productAttributes.filter((item) => item.attributeDefinitionId !== attribute.id), ...(next ? [next] : [])];
    let changed = true;
    while (changed) {
      changed = false;
      const visibleIds = new Set(productAttributes.filter((item) => attributeIsVisible(item, values)).map((item) => item.id));
      const cleaned = values.filter((value) => {
        const definition = productAttributes.find((item) => item.id === value.attributeDefinitionId);
        return !definition?.conditions.length || visibleIds.has(value.attributeDefinitionId);
      });
      changed = cleaned.length !== values.length;
      values = cleaned;
    }
    patch({ productAttributes: values });
  }

  function patchVariant(index: number, partial: Partial<AdminV2VariantInput>) {
    if (!form) return;
    patch({ variants: form.variants.map((variant, itemIndex) => itemIndex === index ? { ...variant, ...partial } : variant) });
  }

  function setVariantDefault(index: number) {
    if (!form) return;
    patch({ variants: form.variants.map((variant, itemIndex) => ({ ...variant, isDefault: itemIndex === index, isActive: itemIndex === index ? true : variant.isActive })) });
  }

  function setMedia(role: AdminV2ProductInput["media"][number]["role"], path: string | null, mimeType = "image/webp") {
    if (!form) return;
    patch({ media: [...form.media.filter((item) => item.role !== role), ...(path ? [{ path, role, mimeType, altText: form.name }] : [])] });
  }

  async function createBrand() {
    if (!form || !newBrandName.trim() || creatingBrand) return;
    setCreatingBrand(true);
    try {
      const brand = await adminApi.createBrand(newBrandName.trim());
      await adminApi.assignCatalogV2BrandFamily(brand.id, form.templateId);
      const refreshed = await adminApi.catalogV2Bootstrap();
      setBootstrap(refreshed);
      chooseBrand(brand.id);
      setNewBrandName("");
      setShowBrandCreator(false);
      setBrandPickerOpen(false);
      setBrandQuery("");
      showToast(`Marca ${brand.name} creada ✓`);
    } catch (error) {
      handleApiError(error, "No se pudo crear la marca.");
    } finally {
      setCreatingBrand(false);
    }
  }

  async function createProductLine() {
    if (!form?.brandId || !newLineName.trim() || creatingLine) return;
    setCreatingLine(true);
    try {
      const line = await adminApi.createCatalogV2ProductLine(form.brandId, form.templateId, newLineName.trim(), slugify(newLineName));
      const refreshed = await adminApi.catalogV2Bootstrap();
      setBootstrap(refreshed);
      chooseProductLine(line.id);
      setNewLineName("");
      setShowLineCreator(false);
      setLinePickerOpen(false);
      setLineQuery("");
      showToast(`Línea ${line.name} creada ✓`);
    } catch (error) {
      handleApiError(error, "No se pudo crear la línea.");
    } finally {
      setCreatingLine(false);
    }
  }

  async function createColorShade() {
    if (!form?.brandId || !toneAxis || !newShadeName.trim() || !newShadeCode.trim() || !newShadeFamilyId || creatingShade) return;
    setCreatingShade(true);
    try {
      const shade = await adminApi.createCatalogV2ColorShade({
        brandId: form.brandId,
        productLineId: form.productLineId ?? null,
        name: newShadeName.trim(),
        code: newShadeCode.trim(),
        colorFamilyOptionId: newShadeFamilyId,
        referenceColor: newShadeReference
      });
      const refreshed = await adminApi.catalogV2Bootstrap();
      setBootstrap(refreshed);
      setAxisSelections((current) => ({ ...current, [toneAxis.id]: [...new Set([...(current[toneAxis.id] ?? []), shade.tone_option_id])] }));
      setToneFamilyId(newShadeFamilyId);
      setNewShadeName("");
      setNewShadeCode("");
      setShowShadeCreator(false);
      showToast(`Tono ${shade.name} creado y seleccionado`);
    } catch (error) {
      handleApiError(error, "No se pudo crear el tono.");
    } finally {
      setCreatingShade(false);
    }
  }

  async function createAxisOption(axis: AdminV2Attribute) {
    const label = axisOptionDrafts[axis.id]?.trim();
    if (!label || creatingOptionId) return;
    setCreatingOptionId(axis.id);
    try {
      const created = await adminApi.createCatalogV2AttributeOption(axis.id, optionValue(label), label);
      const refreshed = await adminApi.catalogV2Bootstrap();
      setBootstrap(refreshed);
      setAxisSelections((current) => ({ ...current, [axis.id]: [...new Set([...(current[axis.id] ?? []), created.id])] }));
      setAxisOptionDrafts((current) => ({ ...current, [axis.id]: "" }));
      showToast(`${label} agregado a ${axis.name}`);
    } catch (error) {
      handleApiError(error, `No se pudo agregar la opción de ${axis.name}.`);
    } finally {
      setCreatingOptionId(null);
    }
  }

  async function createProductAttributeOption(attribute: AdminV2TemplateAttribute) {
    const label = productOptionDrafts[attribute.id]?.trim();
    if (!label || creatingProductOptionId) return;
    setCreatingProductOptionId(attribute.id);
    try {
      const created = await adminApi.createCatalogV2AttributeOption(attribute.id, optionValue(label), label);
      const refreshed = await adminApi.catalogV2Bootstrap();
      setBootstrap(refreshed);
      setProductAttribute(attribute, { attributeDefinitionId: attribute.id, optionId: created.id });
      setProductOptionDrafts((current) => ({ ...current, [attribute.id]: "" }));
      setShowProductOptionCreatorId(null);
      showToast(`${label} agregado y seleccionado`);
    } catch (error) {
      handleApiError(error, `No se pudo agregar ${attribute.name.toLowerCase()}.`);
    } finally {
      setCreatingProductOptionId(null);
    }
  }

  function generateVariants() {
    if (!form) return;
    if (axes.length === 0) {
      patch({ variants: [{ ...emptyVariant(form.code), availability: "available" }] });
      showToast("La opción de venta está lista para completar");
      return;
    }
    const missingRequiredAxis = axes.find((axis) => axis.isRequired && !(axisSelections[axis.id] ?? []).length);
    if (missingRequiredAxis) {
      showToast(`Selecciona al menos una opción en ${missingRequiredAxis.name}.`);
      return;
    }
    const configured = axes
      .map((axis) => ({ axis, options: axis.options.filter((option) => (axisSelections[axis.id] ?? []).includes(option.id)) }))
      .filter((item) => item.options.length > 0);
    if (!configured.length) {
      patch({ variants: [emptyVariant(form.code)] });
      showToast("Se creó una sola opción de venta");
      return;
    }
    const combinations = cartesian(configured.map((item) => item.options));
    if (combinations.length > 100) {
      showToast("La combinación supera 100 opciones. Reduce la selección.");
      return;
    }
    patch({ variants: combinations.map((options, index) => {
      const toneIndex = configured.findIndex((item) => item.axis.code === "tone");
      const shade = toneIndex >= 0 ? bootstrap?.colorShades.find((item) => item.toneOptionId === options[toneIndex].id) : null;
      const attributes: AdminV2AttributeValue[] = options.map((option, optionIndex) => ({ attributeDefinitionId: configured[optionIndex].axis.id, optionId: option.id }));
      if (shade && colorFamilyAttribute && !attributes.some((item) => item.attributeDefinitionId === colorFamilyAttribute.id)) {
        attributes.push({ attributeDefinitionId: colorFamilyAttribute.id, optionId: shade.colorFamilyOptionId });
      }
      const skuParts = options.map((option) => {
        const optionShade = bootstrap?.colorShades.find((item) => item.toneOptionId === option.id);
        return (optionShade?.code ?? option.value).replace(/[^a-z0-9]/gi, "").slice(0, 12);
      });
      return {
        sku: `${form.code || "SKU"}-${skuParts.join("-")}`.toUpperCase(),
        name: options.map((option) => option.label).join(" · "),
        variantKey: options.map((option, optionIndex) => `${configured[optionIndex].axis.code}=${option.value}`).join("|"),
        availability: "available" as const,
        isDefault: index === 0,
        isActive: true,
        sortOrder: index * 10,
        retailPrice: null,
        wholesalePrice: null,
        wholesaleMinimum: 3,
        attributes,
        colorShadeId: shade?.id ?? null,
        mediaPath: null
      };
    }) });
    showToast(template?.code === "ESMALTE_TONOS" ? `${combinations.length} tonos listos para completar` : `${combinations.length} opciones de venta creadas`);
  }

  const missing = useMemo(() => {
    if (!form) return [];
    const issues: string[] = [];
    if (!form.templateId || !form.categoryId) issues.push("Elige qué tipo de producto vas a registrar");
    if (!form.name) issues.push("Ingresa el nombre comercial");
    if (!form.code) issues.push("Ingresa el código del producto");
    if (!form.brandId) issues.push("Selecciona o crea la marca");
    for (const attribute of displayedProductAttributes) {
      if (attribute.isRequired && !form.productAttributes.some((item) => item.attributeDefinitionId === attribute.id)) issues.push(`Completa ${attribute.name}`);
      const number = form.productAttributes.find((item) => item.attributeDefinitionId === attribute.id)?.valueNumber;
      if (number !== null && number !== undefined && attribute.validationRules.min !== undefined && number < attribute.validationRules.min) issues.push(`${attribute.name} no puede ser menor que ${attribute.validationRules.min}`);
      if (number !== null && number !== undefined && attribute.validationRules.max !== undefined && number > attribute.validationRules.max) issues.push(`${attribute.name} no puede superar ${attribute.validationRules.max}`);
    }
    const productNumber = (code: string) => {
      const definition = productAttributes.find((attribute) => attribute.code === code);
      return definition ? form.productAttributes.find((value) => value.attributeDefinitionId === definition.id)?.valueNumber : undefined;
    };
    for (const [lowerCode, upperCode, message] of [
      ["humidity_min", "humidity_max", "La humedad mínima no puede superar la humedad máxima"],
      ["temperature_min", "temperature_max", "La temperatura mínima no puede superar la temperatura máxima"],
      ["rpm_min", "rpm_max", "Las RPM mínimas no pueden superar las RPM máximas"]
    ] as const) {
      const lower = productNumber(lowerCode);
      const upper = productNumber(upperCode);
      if (lower !== null && lower !== undefined && upper !== null && upper !== undefined && lower > upper) issues.push(message);
    }
    if (creationContext === "strip-lash-adhesive" && template?.code === "ADHESIVO_PRO") {
      const application = selectedProductOptionValue(form.productAttributes, productAttributes, "adhesive_application");
      const brandScope = selectedProductOptionValue(form.productAttributes, productAttributes, "adhesive_brand_scope");
      if (application !== "strip-lashes" && application !== "both") issues.push("El uso del pegamento debe incluir pestañas en tira");
      if (!brandScope || brandScope === "unconfirmed") issues.push("Confirma la compatibilidad de marca del pegamento");
      if (brandScope === "specific-brand") {
        const noteAttribute = productAttributes.find((item) => item.code === "compatibility_note");
        const note = noteAttribute ? form.productAttributes.find((value) => value.attributeDefinitionId === noteAttribute.id)?.valueText?.trim() : "";
        if (!note) issues.push("Indica la marca o sistema específico compatible con el pegamento");
      }
    }
    if (!form.variants.length) issues.push(template?.code === "ESMALTE_TONOS" ? "Agrega al menos un tono al producto" : "Agrega al menos una opción de venta");
    if (form.variants.some((variant) => !variant.sku)) issues.push("Hay opciones sin SKU");
    if (form.editorialStatus === "published" && form.variants.some((variant) => variant.isActive && variant.availability === "available" && variant.retailPrice === null)) issues.push("Completa el precio de las opciones disponibles");
    if (form.variants.filter((variant) => variant.isActive && variant.isDefault).length !== 1) issues.push("Elige una opción principal");
    for (const attribute of variantAttributes) {
      if (attribute.isRequired && form.variants.some((variant) => !variant.attributes.some((value) => value.attributeDefinitionId === attribute.id))) issues.push(`Completa ${attribute.name} en todas las opciones`);
      if (form.variants.some((variant) => {
        const number = variant.attributes.find((value) => value.attributeDefinitionId === attribute.id)?.valueNumber;
        return number !== null && number !== undefined && ((attribute.validationRules.min !== undefined && number < attribute.validationRules.min) || (attribute.validationRules.max !== undefined && number > attribute.validationRules.max));
      })) issues.push(`Revisa los valores de ${attribute.name} en las opciones`);
    }
    if (form.relations.some((relation) => !relation.targetProductId)) issues.push("Completa o elimina la relación vacía");
    return [...new Set(issues)];
  }, [creationContext, form, displayedProductAttributes, productAttributes, template?.code, variantAttributes]);

  async function save() {
    if (!form || saving) return;
    if (missing.length) { showToast(missing[0]); return; }
    if (form.editorialStatus === "published" && !window.confirm("¿Publicar este producto y mostrarlo en el catálogo?")) return;
    setSaving(true);
    try {
      const currentTemplate = bootstrap?.templates.find((item) => item.id === form.templateId);
      const cleanForm = currentTemplate ? sanitizeProductForTemplate(form, currentTemplate) : form;
      const payload = { ...cleanForm, slug: cleanForm.slug || slugify(cleanForm.name) };
      const saved = productId && !duplicateMode
        ? await adminApi.updateCatalogV2Product(productId, payload)
        : await adminApi.createCatalogV2Product({ ...payload, id: undefined, variants: payload.variants.map((variant) => ({ ...variant, id: undefined })) });
      showToast(form.editorialStatus === "published" ? "Producto publicado ✓" : "Producto guardado sin publicar ✓");
      router.push(`/admin/productos/${saved.id}`);
      router.refresh();
    } catch (error) {
      handleApiError(error, "No se pudo guardar el producto.");
      setSaving(false);
    }
  }

  async function searchRelations() {
    await refreshRelationOptions(relationQuery, false);
  }

  function addEmptyRelation() {
    if (!form) return;
    patch({ relations: [...form.relations, { targetProductId: "", relationType: "recommended_with", compatibilityStatus: "unknown", notes: "" }] });
  }

  function addRecommendedAdhesive(candidate: AdminV2RelationCandidate) {
    if (!form) return;
    if (form.relations.some((relation) => relation.targetProductId === candidate.id)) {
      showToast(`${candidate.name} ya está asociado.`);
      return;
    }
    const isUniversal = candidate.attributes.adhesive_brand_scope === "universal";
    patch({
      relations: [...form.relations, {
        targetProductId: candidate.id,
        relationType: "requires",
        compatibilityStatus: "confirmed",
        notes: isUniversal
          ? "Pegamento para pestañas en tira con compatibilidad universal declarada."
          : `Pegamento para pestañas en tira de la misma marca (${candidate.brandName}).`
      }]
    });
    showToast(`${candidate.name} asociado como pegamento compatible.`);
  }

  if (!bootstrap || !form) return <div className="loading-block"><span className="spinner spinner--pink" /> Preparando el registro…</div>;

  const mainImage = form.media.find((item) => item.role === "main")?.path ?? null;
  const canContinueGeneral = Boolean(form.name && form.code && form.brandId && form.templateId && form.categoryId);
  const isEnamel = template?.code === "ESMALTE_TONOS";
  const isStripLash = template?.code === "PESTANA_TIRA";
  const newStripLashAdhesiveHref = "/admin/productos/nuevo?tipo=adhesive&usoAdhesivo=strip-lashes&contexto=pestanas-sin-adhesivo";
  const saleChoiceSingular = isEnamel ? "tono" : "opción de venta";
  const saleChoicePlural = isEnamel ? "tonos" : "opciones de venta";
  const selectedToneCount = toneAxis ? (axisSelections[toneAxis.id] ?? []).length : 0;
  const selectedAxisValueCount = axes.reduce((total, axis) => total + (axisSelections[axis.id] ?? []).length, 0);
  const hasMissingRequiredAxis = axes.some((axis) => axis.isRequired && !(axisSelections[axis.id] ?? []).length);
  const primaryChoiceLabel = isEnamel ? "Tono principal del producto" : "Opción principal del producto";
  const choosePrimaryLabel = isEnamel ? "Usar como tono principal" : "Usar como opción principal";
  const primaryChoiceHelp = isEnamel
    ? "Este tono representa al producto en el catálogo y aparece seleccionado al abrir su ficha."
    : "Esta opción representa al producto en el catálogo y aparece seleccionada al abrir su ficha.";
  const requiresLampAttribute = productAttributes.find((attribute) => attribute.code === "requires_lamp_v2");
  const doesNotRequireLamp = requiresLampAttribute
    ? form.productAttributes.find((value) => value.attributeDefinitionId === requiresLampAttribute.id)?.valueBoolean === false
    : false;
  const stepThreeTitle = isEnamel ? "Selecciona todos los tonos de este esmalte" : axes.length ? "Configura cómo se venderá el producto" : "Completa el precio y la disponibilidad";
  const stepThreeHelp = isEnamel ? "Cada tono seleccionado aparecerá debajo para completar su SKU, precio, disponibilidad e imagen." : axes.length ? "Selecciona únicamente las características que deban venderse por separado. Cada combinación tendrá su propio SKU, precio e imagen; los grupos opcionales pueden quedar vacíos." : "Completa la única opción en que se venderá este producto: SKU, precio y disponibilidad.";

  return (
    <div className="form-page product-wizard br-fade">
      <button type="button" className="back-btn" onClick={() => router.push("/admin/productos")}>← Volver a productos</button>

      <div className="form-head product-wizard-head">
        <div>
          <div className="form-title">{duplicateMode ? "Duplicar producto" : productId ? "Editar producto" : "Nuevo producto"}</div>
          <div className="field-hint">El sistema elige los campos adecuados según el tipo de producto.</div>
        </div>
        {productId && !duplicateMode ? (
          <button type="button" className="btn-cancel" onClick={() => {
            setDuplicateMode(true);
            patch({ code: `${form.code}-COPIA`, slug: `${form.slug}-copia`, editorialStatus: "draft", variants: form.variants.map((variant) => ({ ...variant, id: undefined, sku: `${variant.sku}-COPIA` })) });
          }}>Duplicar</button>
        ) : null}
      </div>

      <nav className="product-wizard-steps" aria-label="Pasos para registrar producto">
        <button type="button" className={step === 1 ? "active" : "done"} onClick={() => setStep(1)}><b>1</b><span>Tipo de producto</span></button>
        <button type="button" className={step === 2 ? "active" : step > 2 ? "done" : ""} disabled={!form.templateId} onClick={() => setStep(2)}><b>2</b><span>Datos y características</span></button>
        <button type="button" className={step === 3 ? "active" : ""} disabled={!canContinueGeneral} onClick={() => setStep(3)}><b>3</b><span>Opciones y precio</span></button>
      </nav>

      {step === 1 ? (
        <section className="form-card product-type-step">
          <div className="product-step-heading"><span>Paso 1</span><h2>¿Qué producto vas a registrar?</h2><p>Elige un tipo para mostrar únicamente los campos necesarios.</p></div>
          <div className="product-type-grid">
            {PRODUCT_TYPES.map((profile) => {
              const available = Boolean(templateForProfile(bootstrap, profile));
              const active = selectedType?.key === profile.key;
              return (
                <button key={profile.key} type="button" disabled={!available} className={active ? "product-type-card product-type-card--active" : "product-type-card"} onClick={() => chooseProductType(profile)}>
                  <span className="product-type-icon" aria-hidden="true">{profile.icon}</span>
                  <span><strong>{profile.label}</strong><small>{profile.description}</small><em>Ej.: {profile.example}</em></span>
                  <span className="product-type-arrow">→</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <>
          <section className="product-selected-type">
            <span className="product-type-icon">{selectedType?.icon ?? "•"}</span>
            <span><small>Tipo elegido</small><strong>{selectedType?.label ?? template?.name}</strong></span>
            {!productId || duplicateMode ? <button type="button" onClick={() => setStep(1)}>Cambiar</button> : null}
          </section>

          {creationContext === "strip-lash-adhesive" && template?.code === "ADHESIVO_PRO" ? (
            <section className="product-creation-context">
              <strong>Estás registrando un producto nuevo e independiente</strong>
              <span>Se preseleccionó el uso para pestañas en tira. Completa su marca y compatibilidad; después vuelve a la pestaña anterior para asociarlo.</span>
            </section>
          ) : null}

          <section className="form-card">
            <div className="product-step-heading product-step-heading--compact"><span>Paso 2</span><h2>Datos generales</h2></div>
            <div className="grid-fields form-section">
              <label className="product-field"><span className="field-label">Nombre comercial *</span><input className="input" value={form.name} onChange={(event) => patch({ name: event.target.value, slug: slugify(event.target.value) })} placeholder="Ej. Nombre con el que reconocerás el producto" /></label>
              <label className="product-field"><span className="field-label">Código del producto *</span><input className="input" value={form.code} onChange={(event) => {
                const code = event.target.value.toUpperCase().replace(/\s+/g, "-");
                patch({ code, variants: form.variants.length === 1 && form.variants[0].variantKey === "presentation=base" ? [{ ...form.variants[0], sku: code ? `${code}-BASE` : "" }] : form.variants });
              }} placeholder="Ej. ADM-TOR-001" /></label>
            </div>

            <div className="grid-fields form-section">
              <div className="product-field">
                <span className="field-label">Marca *</span>
                {!showBrandCreator ? selectedBrand && !brandPickerOpen ? (
                  <div className="product-picked-value"><span><b>{selectedBrand.name}</b><small>{selectedBrand.isGeneric ? "Producto sin marca comercial" : selectedBrand.templateIds.includes(form.templateId) ? `Disponible para ${selectedType?.label ?? "este tipo de producto"}` : `Se habilitará para ${selectedType?.label ?? "este tipo de producto"}`}</small></span><button type="button" onClick={() => { setBrandPickerOpen(true); setBrandQuery(""); }}>Cambiar</button></div>
                ) : (
                  <div className="product-entity-picker">
              <div className="product-entity-search"><span aria-hidden="true">⌕</span><input className="input" role="combobox" aria-controls="product-brand-results" aria-expanded={brandPickerOpen} value={brandQuery} onFocus={() => setBrandPickerOpen(true)} onChange={(event) => { setBrandQuery(event.target.value); setBrandPickerOpen(true); }} placeholder={`Buscar marca para ${selectedType?.label.toLowerCase() ?? "este producto"}…`} /><button type="button" onClick={() => { setNewBrandName(brandQuery); setBrandPickerOpen(false); setShowBrandCreator(true); }}>+ Registrar</button></div>
              {brandPickerOpen ? <div id="product-brand-results" className="product-entity-results" role="listbox">
                      <div className="product-entity-caption"><span>{brandQuery ? "Marcas encontradas" : `${scopedBrandCount} ${scopedBrandCount === 1 ? "marca disponible" : "marcas disponibles"} para este tipo`}</span><small>{brandQuery ? "También busca entre todas las marcas" : "Se muestran hasta 8 resultados"}</small></div>
                      {brandResults.map((brand) => <button key={brand.id} type="button" role="option" aria-selected={brand.id === form.brandId} onClick={() => { chooseBrand(brand.id); setBrandPickerOpen(false); setBrandQuery(""); setLineQuery(""); }}><span><b>{brand.name}</b><small>{brand.isGeneric ? "Genérica / sin marca" : brand.scoped ? `Disponible para ${selectedType?.label}` : `Aún no usada en ${selectedType?.label} · se habilitará al elegirla`}</small></span>{brand.scoped ? <em>✓</em> : <em>+</em>}</button>)}
                      {!brandResults.length ? <div className="product-entity-empty">No se encontró. Puedes registrarla sin salir de aquí.</div> : null}
                    </div> : null}
                  </div>
                ) : null}
                {showBrandCreator ? <div className="product-inline-create product-inline-create--panel"><div><b>Nueva marca para {selectedType?.label}</b><small>Se guardará una sola vez y podrás reutilizarla con otros tipos de producto.</small></div><input className="input" value={newBrandName} onChange={(event) => setNewBrandName(event.target.value)} placeholder="Nombre de la nueva marca" /><div className="product-inline-create-actions"><button type="button" onClick={() => setShowBrandCreator(false)}>Cancelar</button><button type="button" disabled={creatingBrand || !newBrandName.trim()} onClick={createBrand}>{creatingBrand ? "Creando…" : "Crear y seleccionar"}</button></div></div> : null}
              </div>
              <div className="product-field">
                <span className="field-label">Línea comercial <small>(opcional)</small></span>
                {!showLineCreator ? !form.brandId ? <div className="product-field-placeholder">Primero selecciona una marca.</div> : selectedProductLine && !linePickerOpen ? (
                  <div className="product-picked-value"><span><b>{selectedProductLine.name}</b><small>{selectedProductLine.templateIds.includes(form.templateId) ? `Disponible para ${selectedType?.label}` : `Se habilitará para ${selectedType?.label}`}</small></span><button type="button" onClick={() => { setLinePickerOpen(true); setLineQuery(""); }}>Cambiar</button></div>
                ) : (
                  <div className="product-entity-picker">
              <div className="product-entity-search"><span aria-hidden="true">⌕</span><input className="input" role="combobox" aria-controls="product-line-results" aria-expanded={linePickerOpen} value={lineQuery} onFocus={() => setLinePickerOpen(true)} onChange={(event) => { setLineQuery(event.target.value); setLinePickerOpen(true); }} placeholder={`Buscar línea de ${selectedBrand?.name ?? "la marca"}…`} /><button type="button" onClick={() => { setNewLineName(lineQuery); setLinePickerOpen(false); setShowLineCreator(true); }}>+ Registrar</button></div>
              {linePickerOpen ? <div id="product-line-results" className="product-entity-results" role="listbox">
                      <button type="button" className="product-entity-none" onClick={() => { chooseProductLine(null); setLinePickerOpen(false); setLineQuery(""); }}><span><b>Sin línea comercial</b><small>El producto pertenece directamente a la marca</small></span><em>—</em></button>
                      {lineResults.map((line) => <button key={line.id} type="button" role="option" aria-selected={line.id === form.productLineId} onClick={() => { chooseProductLine(line.id); setLinePickerOpen(false); setLineQuery(""); }}><span><b>{line.name}</b><small>{line.scoped ? `Disponible para ${selectedType?.label}` : `Aún no usada en ${selectedType?.label} · se habilitará al elegirla`}</small></span>{line.scoped ? <em>✓</em> : <em>+</em>}</button>)}
                      {!lineResults.length && lineQuery ? <div className="product-entity-empty">No se encontró esa línea.</div> : null}
                    </div> : null}
                  </div>
                ) : null}
                {showLineCreator ? <div className="product-inline-create product-inline-create--panel"><div><b>Nueva línea de {selectedBrand?.name}</b><small>Se guardará dentro de esta marca y quedará disponible para próximos productos.</small></div><input className="input" value={newLineName} onChange={(event) => setNewLineName(event.target.value)} placeholder="Ej. Gel Evolution" /><div className="product-inline-create-actions"><button type="button" onClick={() => setShowLineCreator(false)}>Cancelar</button><button type="button" disabled={creatingLine || !newLineName.trim()} onClick={createProductLine}>{creatingLine ? "Creando…" : "Crear y seleccionar"}</button></div></div> : null}
              </div>
            </div>

            <label className="product-field form-section"><span className="field-label">Descripción corta</span><input className="input" value={form.shortDescription ?? ""} onChange={(event) => patch({ shortDescription: event.target.value })} placeholder="Una frase breve para identificar el producto" /></label>
            <label className="product-field form-section"><span className="field-label">Descripción para el catálogo</span><textarea className="input textarea" value={form.description ?? ""} onChange={(event) => patch({ description: event.target.value })} placeholder="Características y beneficios que verá la clienta" /></label>
          </section>

          <section className="form-card">
            <div className="product-step-heading product-step-heading--compact"><span>Datos específicos</span><h2>Características de {selectedType?.label.toLowerCase() ?? "este producto"}</h2><p>Completa los datos disponibles. Los campos marcados con * son obligatorios; los demás pueden completarse después.</p></div>
            {displayedProductAttributes.length ? <div className="grid-fields form-section">{displayedProductAttributes.map((attribute) => <div key={attribute.id} className="product-attribute-entry"><AttributeField attribute={attribute} value={form.productAttributes.find((item) => item.attributeDefinitionId === attribute.id)} onChange={(value) => setProductAttribute(attribute, value)} />{attribute.code === "general_finish" ? <>{showProductOptionCreatorId === attribute.id ? <div className="product-inline-create product-attribute-option-create"><input className="input" value={productOptionDrafts[attribute.id] ?? ""} onChange={(event) => setProductOptionDrafts((current) => ({ ...current, [attribute.id]: event.target.value }))} placeholder="Nombre del nuevo acabado" /><div className="product-inline-create-actions"><button type="button" onClick={() => setShowProductOptionCreatorId(null)}>Cancelar</button><button type="button" disabled={creatingProductOptionId === attribute.id || !productOptionDrafts[attribute.id]?.trim()} onClick={() => createProductAttributeOption(attribute)}>{creatingProductOptionId === attribute.id ? "Guardando…" : "Crear y seleccionar"}</button></div></div> : <button type="button" className="product-add-controlled-option" onClick={() => setShowProductOptionCreatorId(attribute.id)}>+ Registrar otro acabado</button>}</> : null}</div>)}</div> : <div className="carta-note form-section">Este tipo no necesita características adicionales.</div>}
            {doesNotRequireLamp ? <div className="carta-note form-section">No se solicitará la tecnología de lámpara porque este esmalte no la requiere.</div> : null}
          </section>

          <section className="form-card product-relations-card">
            <div className="product-step-heading product-step-heading--compact">
              <span>Asociaciones</span>
              <h2>Productos relacionados</h2>
              <p>Agrega compatibilidad, repuestos o recomendaciones después de completar las características del producto.</p>
            </div>

            {isStripLash && includesAdhesiveValue === false ? (
              <div className="product-adhesive-recommendation form-section">
                <div className="product-adhesive-recommendation-head">
                  <div><strong>Estas pestañas necesitan pegamento</strong><span>Como no incluyen adhesivo, solo sugerimos productos declarados para pestañas en tira y compatibles con la marca elegida.</span></div>
                  <button type="button" className="btn-cancel" disabled={loadingAdhesiveRecommendations} onClick={() => void refreshAdhesiveRecommendations(false)}>{loadingAdhesiveRecommendations ? "Actualizando…" : "Actualizar"}</button>
                </div>
                {safeAdhesiveRecommendations.length ? (
                  <div className="product-adhesive-options">
                    {safeAdhesiveRecommendations.map((candidate) => {
                      return <article key={candidate.id}><div><b>{candidate.name}</b><small>{candidate.code} · {candidate.brandName}</small><span>{stripLashAdhesiveRecommendationReason(candidate)}</span></div><button type="button" className="btn-soft" onClick={() => addRecommendedAdhesive(candidate)}>Asociar pegamento</button></article>;
                    })}
                  </div>
                ) : !loadingAdhesiveRecommendations ? (
                  <div className="product-recommendation-empty"><b>No encontramos un pegamento que podamos recomendar con seguridad.</b><span>No mostramos adhesivos para extensiones, exclusivos de otra marca ni productos cuya compatibilidad esté sin confirmar.</span></div>
                ) : null}
                <div className="product-adhesive-create">
                  <span>¿No existe el pegamento correcto? Regístralo como un producto separado para mantener el catálogo ordenado.</span>
                  <Link className="btn-cancel" href={newStripLashAdhesiveHref} target="_blank">Registrar pegamento compatible ↗</Link>
                </div>
              </div>
            ) : null}

            {isStripLash && includesAdhesiveValue === true ? <div className="carta-note form-section">Este producto ya incluye adhesivo. No sugeriremos otro pegamento; por defecto, las relaciones manuales mostrarán únicamente otras pestañas en tira.</div> : null}

            <details className="product-advanced product-relation-search">
              <summary>Buscar o agregar una relación manual</summary>
              <div className="product-relation-scope form-section">
                <span className="field-label">Qué productos mostrar</span>
                <div className="product-relation-scope-options" role="radiogroup" aria-label="Alcance de la búsqueda de productos relacionados">
                  <button type="button" role="radio" aria-checked={relationScope === "same_type"} className={relationScope === "same_type" ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setRelationScope("same_type")}>Mismo tipo</button>
                  <button type="button" role="radio" aria-checked={relationScope === "compatible"} className={relationScope === "compatible" ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setRelationScope("compatible")}>Familias compatibles</button>
                  <button type="button" role="radio" aria-checked={relationScope === "all"} className={relationScope === "all" ? "opt-chip opt-chip--active product-relation-scope-all" : "opt-chip product-relation-scope-all"} onClick={() => setRelationScope("all")}>Todo el catálogo · avanzado</button>
                </div>
                <small className="field-hint">
                  {relationScope === "same_type"
                    ? `Solo se muestran productos del tipo ${selectedType?.label ?? template?.name}.`
                    : relationScope === "compatible"
                      ? "Se agregan únicamente familias coherentes y accesorios clasificados para esta área. La compatibilidad concreta todavía debe verificarse."
                      : "Modo avanzado: puede mostrar productos sin relación natural. Úsalo solo cuando tengas una razón comercial o técnica comprobable."}
                </small>
              </div>
              <div className="pub-search-row form-section"><input className="input" value={relationQuery} onChange={(event) => setRelationQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchRelations(); } }} placeholder={`Buscar ${relationScope === "same_type" ? (selectedType?.label ?? "este tipo de producto").toLowerCase() : "por código o nombre"}…`} /><button type="button" className="btn-cancel" disabled={loadingRelationOptions} onClick={() => void searchRelations()}>{loadingRelationOptions ? "Buscando…" : "Buscar"}</button><button type="button" className="btn-cancel" onClick={addEmptyRelation}>+ Agregar relación</button></div>
              <div className="product-relation-results-summary">{loadingRelationOptions ? "Actualizando opciones…" : `${relationOptions.length} ${relationOptions.length === 1 ? "producto disponible" : "productos disponibles"} con este filtro.`}</div>
            </details>

            {form.relations.length ? <div className="product-relations-list form-section">{form.relations.map((relation, index) => <div key={relation.id ?? index} className="product-relation"><div className="grid-fields"><label className="product-field"><span className="field-label">Producto relacionado</span><select className="input" value={relation.targetProductId} onChange={(event) => patch({ relations: form.relations.map((item, itemIndex) => itemIndex === index ? { ...item, targetProductId: event.target.value } : item) })}><option value="">Seleccionar producto…</option>{combinedRelationOptions.filter((item) => item.id !== productId).map((item) => <option key={item.id} value={item.id}>[{relationProductTypeLabel(item.templateCode)}] {item.code} · {item.name} · {item.brandName}</option>)}</select><small className="field-hint">La etiqueta entre corchetes identifica el tipo para evitar cruces accidentales.</small></label><label className="product-field"><span className="field-label">Cómo se relaciona</span><select className="input" value={relation.relationType} onChange={(event) => patch({ relations: form.relations.map((item, itemIndex) => itemIndex === index ? { ...item, relationType: event.target.value as AdminV2RelationInput["relationType"] } : item) })}>{Object.entries(RELATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="product-field"><span className="field-label">Estado de compatibilidad</span><select className="input" value={relation.compatibilityStatus} onChange={(event) => patch({ relations: form.relations.map((item, itemIndex) => itemIndex === index ? { ...item, compatibilityStatus: event.target.value as AdminV2RelationInput["compatibilityStatus"] } : item) })}><option value="unknown">Por confirmar</option><option value="conditional">Compatible con condiciones</option><option value="confirmed">Compatibilidad confirmada</option><option value="not_compatible">No compatible</option></select></label></div><label className="product-field form-section"><span className="field-label">Detalle o condición</span><input className="input" value={relation.notes ?? ""} onChange={(event) => patch({ relations: form.relations.map((item, itemIndex) => itemIndex === index ? { ...item, notes: event.target.value } : item) })} placeholder="Ej. Compatible únicamente con el modelo X" /></label><button type="button" className="btn-cancel" onClick={() => patch({ relations: form.relations.filter((_, itemIndex) => itemIndex !== index) })}>Quitar relación</button></div>)}</div> : <div className="product-relations-empty">Todavía no hay productos asociados. Es opcional.</div>}
          </section>

          <section className="form-card product-publish-choice">
            <div><strong>¿Qué ocurrirá al guardar?</strong><small>Como borrador no será visible en el catálogo; publicado sí podrá mostrarse a las clientas.</small></div>
            <div className="chip-row"><button type="button" className={form.editorialStatus === "draft" ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => patch({ editorialStatus: "draft" })}>Guardar sin publicar</button><button type="button" className={form.editorialStatus === "published" ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => patch({ editorialStatus: "published" })}>Publicar al terminar</button></div>
            <details className="product-advanced"><summary>Configuración avanzada</summary><div className="grid-fields form-section"><label className="product-field"><span className="field-label">Texto del enlace público</span><input className="input" value={form.slug} onChange={(event) => patch({ slug: slugify(event.target.value) })} placeholder="Ej. esmalte-gel-rojo" /><small className="field-hint">Se genera automáticamente a partir del nombre. Modifícalo solo si necesitas otro enlace.</small></label><label className="product-field"><span className="field-label">Estado de publicación</span><select className="input" value={form.editorialStatus} onChange={(event) => patch({ editorialStatus: event.target.value as EditorialStatus })}><option value="draft">Borrador · no visible</option><option value="in_review">En revisión · no visible</option><option value="published">Publicado · visible</option><option value="hidden">Oculto · no visible</option><option value="incomplete">Incompleto · no visible</option></select></label></div><div className="chip-row form-section"><button type="button" className={form.isActive ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => patch({ isActive: !form.isActive })}>{form.isActive ? "Producto habilitado" : "Producto deshabilitado"}</button><button type="button" className={form.isFeatured ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => patch({ isFeatured: !form.isFeatured })}>{form.isFeatured ? "Destacado en el catálogo" : "No destacado"}</button></div></details>
          </section>

          <div className="product-step-actions"><button type="button" className="btn-cancel" onClick={() => setStep(1)}>Atrás</button><button type="button" className="btn-save" disabled={!canContinueGeneral} onClick={() => setStep(3)}>{template?.code === "ESMALTE_TONOS" ? "Continuar para seleccionar tonos →" : axes.length ? "Continuar con las opciones de venta →" : "Continuar con precio y disponibilidad →"}</button></div>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <section className="product-selected-type">
            <span className="product-type-icon">{selectedType?.icon ?? "•"}</span>
            <span><small>Producto</small><strong>{form.name || selectedType?.label}</strong></span>
            <button type="button" onClick={() => setStep(2)}>Editar datos</button>
          </section>

          <section className="form-card">
            <div className="product-step-heading product-step-heading--compact"><span>Paso 3</span><h2>{stepThreeTitle}</h2><p>{stepThreeHelp}</p></div>
            {axes.length ? (
              <div className="product-axis-list form-section">
                {axes.map((axis) => {
                  const selectedIds = axisSelections[axis.id] ?? [];
                  if (axis.code === "tone" && colorFamilyAttribute) {
                    const selectedShades = bootstrap.colorShades.filter((shade) => selectedIds.includes(shade.toneOptionId));
                    return (
                      <div key={axis.id} className="product-axis product-tone-picker">
                        <div className="product-axis-head"><strong>Tonos del esmalte{axis.isRequired ? " *" : ""}</strong><small>{selectedIds.length} {selectedIds.length === 1 ? "tono seleccionado" : "tonos seleccionados"}</small></div>
                        <p className="product-axis-help">Busca por nombre o código, o elige una familia cromática para reducir los resultados. Pulsa un tono para seleccionarlo.</p>

                        {selectedShades.length ? <div className="product-tone-selected">{selectedShades.map((shade) => <button key={shade.id} type="button" onClick={() => setAxisSelections((current) => ({ ...current, [axis.id]: (current[axis.id] ?? []).filter((id) => id !== shade.toneOptionId) }))}><span className="product-color-dot" style={{ background: shade.referenceColor ?? "#d8d2d5" }} /><span><b>{shade.name}</b><small>{shade.code}</small></span><em>×</em></button>)}</div> : null}

                        <div className="product-tone-filters">
                          <div className="product-tone-search"><span aria-hidden="true">⌕</span><input className="input" value={toneQuery} onChange={(event) => setToneQuery(event.target.value)} placeholder="Buscar tono o código…" /></div>
                          <div className="chip-row product-family-chips"><button type="button" className={!toneFamilyId ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setToneFamilyId("")}>Todas las familias</button>{colorFamilyAttribute.options.map((family) => <button key={family.id} type="button" className={toneFamilyId === family.id ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setToneFamilyId(family.id)}>{family.label}</button>)}</div>
                        </div>

                        <div className="product-tone-results">
                          {shadeResults.map((shade) => {
                            const selected = selectedIds.includes(shade.toneOptionId);
                            const family = colorFamilyAttribute.options.find((item) => item.id === shade.colorFamilyOptionId);
                            return <button key={shade.id} type="button" className={selected ? "product-tone-result product-tone-result--selected" : "product-tone-result"} onClick={() => setAxisSelections((current) => ({ ...current, [axis.id]: selected ? (current[axis.id] ?? []).filter((id) => id !== shade.toneOptionId) : [...(current[axis.id] ?? []), shade.toneOptionId] }))}><span className="product-color-dot product-color-dot--large" style={{ background: shade.referenceColor ?? "#d8d2d5" }} /><span><b>{shade.name}</b><small>Código {shade.code} · {family?.label ?? "Sin familia"}</small></span><em>{selected ? "✓" : "+"}</em></button>;
                          })}
                          {!shadeResults.length ? <div className="product-entity-empty">No hay tonos con ese filtro para {selectedBrand?.name}. Puedes agregar uno nuevo.</div> : null}
                        </div>
                        <div className="product-tone-result-note">Se muestran como máximo 12 resultados. Usa la búsqueda o una familia para encontrar más rápido.</div>

                        <button type="button" className="btn-cancel product-shade-create-toggle" onClick={() => { setShowShadeCreator((value) => !value); setNewShadeFamilyId(toneFamilyId); }}>+ Agregar un tono que no existe</button>
                        {showShadeCreator ? <div className="product-shade-create"><div><b>Nuevo tono de {selectedBrand?.name}</b><small>{selectedProductLine ? `Línea ${selectedProductLine.name}` : "Sin línea específica"}</small></div><div className="grid-fields"><label className="product-field"><span className="field-label">Nombre del tono *</span><input className="input" value={newShadeName} onChange={(event) => setNewShadeName(event.target.value)} placeholder="Ej. Apasionada" /></label><label className="product-field"><span className="field-label">Código del tono *</span><input className="input" value={newShadeCode} onChange={(event) => setNewShadeCode(event.target.value)} placeholder="Ej. 123" /></label><label className="product-field"><span className="field-label">Familia cromática *</span><select className="input" value={newShadeFamilyId} onChange={(event) => setNewShadeFamilyId(event.target.value)}><option value="">Seleccionar…</option>{colorFamilyAttribute.options.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}</select></label><label className="product-field"><span className="field-label">Color de referencia</span><input className="input product-color-input" type="color" value={newShadeReference} onChange={(event) => setNewShadeReference(event.target.value)} /></label></div><div className="product-inline-create-actions"><button type="button" onClick={() => setShowShadeCreator(false)}>Cancelar</button><button type="button" disabled={creatingShade || !newShadeName.trim() || !newShadeCode.trim() || !newShadeFamilyId} onClick={createColorShade}>{creatingShade ? "Guardando…" : "Crear y seleccionar"}</button></div></div> : null}
                      </div>
                    );
                  }
                  return (
                    <div key={axis.id} className="product-axis">
                      <div className="product-axis-head"><strong>{axis.name}{axis.isRequired ? " *" : " (opcional)"}</strong><small>{selectedIds.length} {selectedIds.length === 1 ? "opción seleccionada" : "opciones seleccionadas"}</small></div>
                      <div className="chip-row">{axis.options.slice(0, 20).map((option) => { const selected = selectedIds.includes(option.id); return <button key={option.id} type="button" className={selected ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setAxisSelections((current) => ({ ...current, [axis.id]: selected ? (current[axis.id] ?? []).filter((id) => id !== option.id) : [...(current[axis.id] ?? []), option.id] }))}>{option.label}</button>; })}</div>
                      <div className="product-option-create"><input className="input" value={axisOptionDrafts[axis.id] ?? ""} onChange={(event) => setAxisOptionDrafts((current) => ({ ...current, [axis.id]: event.target.value }))} placeholder={`Agregar nuevo valor de ${axis.name.toLowerCase()}…`} /><button type="button" disabled={creatingOptionId === axis.id || !axisOptionDrafts[axis.id]?.trim()} onClick={() => createAxisOption(axis)}>+ Agregar</button></div>
                    </div>
                  );
                })}
                <button type="button" className="btn-save product-generate" disabled={hasMissingRequiredAxis} onClick={generateVariants}>{isEnamel ? `Agregar ${selectedToneCount} ${selectedToneCount === 1 ? "tono" : "tonos"} al producto` : selectedAxisValueCount ? "Crear las opciones de venta" : "Continuar con una sola opción de venta"}</button>
              </div>
            ) : null}
          </section>

          <section className="form-card">
            <div className="form-head"><div><div className="form-title" style={{ fontSize: 18 }}>{isEnamel ? "Completa los datos de venta de cada tono" : "Opciones de venta del producto"}</div><div className="field-hint">{form.variants.length ? `${form.variants.length} ${form.variants.length === 1 ? saleChoiceSingular : saleChoicePlural}` : isEnamel ? "Aún no has agregado tonos al producto" : "Aún no has creado opciones de venta"}</div></div>{!axes.length ? <button type="button" className="btn-cancel" onClick={() => { const next = form.variants.length + 1; patch({ variants: [...form.variants, { ...emptyVariant(form.code), sku: `${form.code || "SKU"}-P${next}`, name: `Opción de venta ${next}`, variantKey: `presentation=${next}`, isDefault: form.variants.length === 0 }] }); }}>+ Agregar otra opción de venta</button> : null}</div>
            <div className="product-variants-list form-section">
              {!form.variants.length ? <div className="product-variants-empty"><b>{isEnamel ? "Selecciona los tonos arriba" : "Define cómo se venderá el producto"}</b><span>{isEnamel ? "Después agrégalos al producto para completar precio, disponibilidad e imagen." : "Selecciona características si se venderán por separado o continúa con una sola opción de venta."}</span></div> : null}
              {form.variants.map((variant, index) => {
                const secondaryAttributes = variantAttributes.filter((item) => !item.isVariantAxis && !(variant.colorShadeId && item.code === "color_family"));
                return (
                  <details key={variant.id ?? `${variant.variantKey}-${index}`} className="product-variant-card" open={form.variants.length === 1 ? true : undefined}>
                    <summary><span><b>{variant.name || `Opción ${index + 1}`}</b><small>{variant.sku || "Sin SKU"}</small></span><span><b>{variant.retailPrice === null ? "Sin precio" : formatPrice(variant.retailPrice)}</b><small>{variant.availability === "available" ? "Disponible" : variant.availability === "sold_out" ? "Agotado" : "Por consultar"}</small></span></summary>
                    <div className="product-variant-body">
                      <div className="grid-fields">
                        <label className="product-field"><span className="field-label">{isEnamel ? "Nombre del tono" : "Nombre de la opción de venta"}</span><input className="input" value={variant.name} onChange={(event) => patchVariant(index, { name: event.target.value })} /></label>
                        <label className="product-field"><span className="field-label">SKU *</span><input className="input" value={variant.sku} onChange={(event) => patchVariant(index, { sku: event.target.value.toUpperCase() })} /><small className="field-hint">Código único para identificar esta opción en ventas y búsquedas.</small></label>
                        <label className="product-field"><span className="field-label">Disponibilidad</span><select className="input" value={variant.availability} onChange={(event) => patchVariant(index, { availability: event.target.value as AdminV2VariantInput["availability"] })}><option value="available">Disponible</option><option value="sold_out">Agotado</option><option value="consult">Consultar antes de vender</option></select></label>
                        <label className="product-field"><span className="field-label">Precio de venta</span><input className="input" type="number" min={0} step="0.01" value={variant.retailPrice ?? ""} onChange={(event) => patchVariant(index, { retailPrice: event.target.value === "" ? null : Number(event.target.value) })} /></label>
                        <label className="product-field"><span className="field-label">Precio mayorista <small>(opcional)</small></span><input className="input input--wholesale" type="number" min={0} step="0.01" value={variant.wholesalePrice ?? ""} onChange={(event) => patchVariant(index, { wholesalePrice: event.target.value === "" ? null : Number(event.target.value) })} /></label>
                        {variant.wholesalePrice !== null ? <label className="product-field"><span className="field-label">Cantidad mínima para precio mayorista</span><input className="input" type="number" min={1} value={variant.wholesaleMinimum} onChange={(event) => patchVariant(index, { wholesaleMinimum: Math.max(1, Number(event.target.value)) })} /></label> : null}
                      </div>
                      {secondaryAttributes.length ? <div className="grid-fields form-section">{secondaryAttributes.map((attribute) => <AttributeField key={attribute.id} attribute={attribute} value={variant.attributes.find((item) => item.attributeDefinitionId === attribute.id)} onChange={(value) => patchVariant(index, { attributes: [...variant.attributes.filter((item) => item.attributeDefinitionId !== attribute.id), ...(value ? [value] : [])] })} />)}</div> : null}
                      <div className="form-section product-variant-image"><ImageSlot label="Imagen de esta opción" path={variant.mediaPath ?? null} kind="product-image" onChange={(path) => patchVariant(index, { mediaPath: path })} /></div>
                      <div className="chip-row form-section"><button type="button" aria-pressed={variant.isDefault} title={variant.isDefault ? primaryChoiceHelp : `Seleccionar como ${primaryChoiceLabel.toLowerCase()}`} className={variant.isDefault ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setVariantDefault(index)}>{variant.isDefault ? primaryChoiceLabel : choosePrimaryLabel}</button><button type="button" className={variant.isActive ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => patchVariant(index, { isActive: !variant.isActive })}>{variant.isActive ? "Visible en el catálogo" : "No visible en el catálogo"}</button>{!axes.length ? <button type="button" className="opt-chip" onClick={() => { const next = form.variants.length + 1; patch({ variants: [...form.variants, { ...variant, id: undefined, sku: `${form.code || "SKU"}-P${next}`, name: `Opción de venta ${next}`, variantKey: `presentation=${next}`, isDefault: false }] }); }}>Duplicar opción</button> : null}{form.variants.length > 1 && !variant.isDefault ? <button type="button" className="opt-chip" onClick={() => patch({ variants: form.variants.filter((_, itemIndex) => itemIndex !== index) })}>Quitar</button> : null}</div>
                      {variant.isDefault ? <div className="field-hint">{primaryChoiceHelp}</div> : null}
                    </div>
                  </details>
                );
              })}
            </div>
            {form.variants.some((variant) => variant.wholesalePrice !== null) ? <label className="product-field form-section"><span className="field-label">¿Cómo se alcanza la cantidad mínima mayorista?</span><select className="input" value={form.wholesaleMixingPolicy ?? "same_product"} onChange={(event) => patch({ wholesaleMixingPolicy: event.target.value as "same_variant" | "same_product" })}><option value="same_product">Sumando distintas opciones de este producto</option><option value="same_variant">Solo comprando la misma opción</option></select></label> : null}
          </section>

          <section className="form-card product-media-card">
            <div className="product-step-heading product-step-heading--compact"><span>Imagen</span><h2>Fotografía principal</h2><p>Esta imagen representa al producto. Si cada tono u opción tiene una imagen distinta, agrégala dentro de sus datos de venta.</p></div>
            <div className="img-grid form-section"><ImageSlot label="Imagen principal" path={mainImage} kind="product-image" onChange={(path) => setMedia("main", path)} /></div>
            <details className="product-advanced"><summary>{isEnamel ? "Agregar carta de colores o ficha técnica" : "Agregar ficha técnica PDF"}</summary><div className="grid-fields form-section">{isEnamel ? <label className="product-field"><span className="field-label">Carta de colores</span><input className="input" value={form.media.find((item) => item.role === "color_chart")?.path ?? ""} onChange={(event) => setMedia("color_chart", event.target.value || null)} placeholder="Ruta o enlace de la imagen" /></label> : null}<label className="product-field"><span className="field-label">Ficha técnica PDF</span><input className="input" value={form.media.find((item) => item.role === "technical_sheet")?.path ?? ""} onChange={(event) => setMedia("technical_sheet", event.target.value || null, "application/pdf")} placeholder="Ruta o enlace del archivo PDF" /></label></div></details>
          </section>

          <section className={missing.length ? "product-save-summary product-save-summary--warning" : "product-save-summary"}>
            <div><strong>{missing.length ? "Falta completar" : "Listo para guardar"}</strong><small>{missing.length ? missing[0] : `${form.variants.length} ${form.variants.length === 1 ? saleChoiceSingular : saleChoicePlural} · ${form.editorialStatus === "published" ? "Se publicará en el catálogo" : "Se guardará sin publicar"}`}</small></div>
            {missing.length > 1 ? <details><summary>Ver {missing.length} observaciones</summary>{missing.map((item) => <div key={item}>• {item}</div>)}</details> : null}
          </section>

          <div className="product-step-actions"><button type="button" className="btn-cancel" onClick={() => setStep(2)}>Atrás</button>{productId && form.editorialStatus === "published" ? <Link className="btn-soft" href={`/producto/${form.slug}`} target="_blank">Ver en catálogo ↗</Link> : null}<button type="button" className="btn-save" disabled={saving || missing.length > 0} onClick={save}>{saving ? <span className="spinner" /> : null}{saving ? "Guardando…" : form.editorialStatus === "published" ? "Guardar y publicar" : "Guardar sin publicar"}</button></div>
        </>
      ) : null}
    </div>
  );
}
