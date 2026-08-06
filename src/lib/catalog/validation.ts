import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const availabilitySchema = z.enum(["available", "sold_out", "consult"]);
export const colorChartStatusSchema = z.enum(["available", "consult_advisor"]);
export const lampTypeSchema = z.enum(["No", "Sí", "UV/LED"]);
export const toneModeSchema = z.enum([
  "assorted",
  "full_set",
  "specific_codes",
  "confirm_with_advisor"
]);

const optionalNullableText = z
  .string()
  .trim()
  .max(1200)
  .optional()
  .nullable()
  .transform((value) => (value === "" ? null : value));

const priceSchema = z.coerce.number().min(0).max(999999);

export const productImageInputSchema = z.object({
  path: z.string().trim().min(1).max(512),
  altText: z.string().trim().max(180).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0)
});

export const productCreateSchema = z.object({
  code: z.string().trim().min(1).max(64),
  slug: slugSchema.optional(),
  brandId: uuidSchema,
  categoryId: uuidSchema,
  name: z.string().trim().min(1).max(180),
  presentation: z.string().trim().min(1).max(120),
  productType: z.string().trim().min(1).max(120),
  requiresLamp: z.boolean().default(false),
  lampType: lampTypeSchema.optional(),
  description: optionalNullableText,
  unitPrice: priceSchema,
  wholesalePrice: priceSchema,
  wholesaleMinQuantity: z.coerce.number().int().min(1).max(999).default(3),
  availability: availabilitySchema.default("available"),
  colorChartStatus: colorChartStatusSchema.default("consult_advisor"),
  mainImagePath: z.string().trim().max(512).optional().nullable(),
  colorChartImagePath: z.string().trim().max(512).optional().nullable(),
  colorChartPdfPath: z.string().trim().max(512).optional().nullable(),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  gallery: z.array(productImageInputSchema).max(20).optional()
});

export const productUpdateSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    slug: slugSchema.optional(),
    brandId: uuidSchema.optional(),
    categoryId: uuidSchema.optional(),
    name: z.string().trim().min(1).max(180).optional(),
    presentation: z.string().trim().min(1).max(120).optional(),
    productType: z.string().trim().min(1).max(120).optional(),
    requiresLamp: z.boolean().optional(),
    lampType: lampTypeSchema.optional(),
    description: optionalNullableText,
    unitPrice: priceSchema.optional(),
    wholesalePrice: priceSchema.optional(),
    wholesaleMinQuantity: z.coerce.number().int().min(1).max(999).optional(),
    availability: availabilitySchema.optional(),
    colorChartStatus: colorChartStatusSchema.optional(),
    mainImagePath: z.string().trim().max(512).optional().nullable(),
    colorChartImagePath: z.string().trim().max(512).optional().nullable(),
    colorChartPdfPath: z.string().trim().max(512).optional().nullable(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    gallery: z.array(productImageInputSchema).max(20).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const taxonomyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: optionalNullableText,
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0)
});

export const taxonomyUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: slugSchema.optional(),
    description: optionalNullableText,
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const contactSettingsSchema = z.object({
  whatsappNumber: z.string().trim().min(8).max(32),
  businessName: z.string().trim().min(1).max(120).default("Bellaroshe"),
  stockNotice: z.string().trim().max(280).optional().nullable()
});

export const assetUploadSchema = z
  .object({
    kind: z.enum(["product-image", "color-chart", "catalog-pdf"]),
    fileName: z.string().trim().min(1).max(180),
    contentType: z.string().trim().min(3).max(120)
  })
  .superRefine((value, ctx) => {
    const isPdf = value.kind === "catalog-pdf";
    const validImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      value.contentType
    );

    if (isPdf && value.contentType !== "application/pdf") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "catalog-pdf uploads must use application/pdf.",
        path: ["contentType"]
      });
    }

    if (!isPdf && !validImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Catalog image uploads must be png, jpeg, webp, or gif.",
        path: ["contentType"]
      });
    }
  });

export const whatsappSelectionItemSchema = z.object({
  productId: uuidSchema,
  quantity: z.coerce.number().int().min(1).max(999),
  toneMode: toneModeSchema,
  toneCodes: z.array(z.string().trim().min(1).max(32)).max(200).optional(),
  note: z.string().trim().max(280).optional().nullable()
});

export const whatsappRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("product_advisor"),
    productId: uuidSchema,
    quantity: z.coerce.number().int().min(1).max(999).default(1)
  }),
  z.object({
    type: z.literal("color_chart_advisor"),
    productId: uuidSchema,
    quantity: z.coerce.number().int().min(1).max(999).default(1)
  }),
  z.object({
    type: z.literal("selection"),
    items: z.array(whatsappSelectionItemSchema).min(1).max(50),
    deliveryMethod: z.enum(["shipping", "pickup"]).optional(),
    customerNote: z.string().trim().max(500).optional().nullable()
  })
]);

export const paginationSchema = z.object({
  q: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(140).optional(),
  category: z.string().trim().max(140).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const catalogV2QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(140).optional(),
  category: z.string().trim().max(500).optional(),
  availability: availabilitySchema.optional(),
  attributes: z
    .string()
    .max(4000)
    .transform((value, context) => {
      try {
        const parsed = JSON.parse(value) as unknown;
        return z.record(z.array(z.string().trim().min(1).max(100)).max(50)).parse(parsed);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "attributes must be valid JSON filters." });
        return z.NEVER;
      }
    })
    .optional(),
  sort: z.enum(["featured", "name_asc", "name_desc", "price_asc", "price_desc"]).default("featured")
});

export const cartLineInputSchema = z.object({
  variantId: uuidSchema,
  quantity: z.coerce.number().int().min(1).max(999)
});

export const cartEvaluationSchema = z.object({
  lines: z.array(cartLineInputSchema).min(1).max(50)
});

export const whatsappOrderV2Schema = cartEvaluationSchema.extend({
  intent: z.enum(["order", "advice"]).default("order"),
  deliveryMethod: z.enum(["shipping", "pickup"]).optional(),
  customerNote: z.string().trim().max(500).optional().nullable()
});

const adminV2AttributeValueSchema = z
  .object({
    attributeDefinitionId: uuidSchema,
    optionId: uuidSchema.optional().nullable(),
    valueText: z.string().max(2000).optional().nullable(),
    valueNumber: z.coerce.number().optional().nullable(),
    valueBoolean: z.boolean().optional().nullable(),
    valueDate: z.string().date().optional().nullable(),
    valueJson: z.unknown().optional()
  })
  .superRefine((value, context) => {
    const count = [value.optionId, value.valueText, value.valueNumber, value.valueBoolean, value.valueDate, value.valueJson]
      .filter((entry) => entry !== null && entry !== undefined && entry !== "").length;
    if (count !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Cada atributo debe tener exactamente un valor." });
  });

const adminV2VariantSchema = z.object({
  id: uuidSchema.optional(),
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(180),
  variantKey: z.string().trim().min(1).max(500),
  availability: availabilitySchema,
  isDefault: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
  retailPrice: z.coerce.number().min(0).max(999999).nullish().transform((value) => value ?? null),
  wholesalePrice: z.coerce.number().min(0).max(999999).nullish().transform((value) => value ?? null),
  wholesaleMinimum: z.coerce.number().int().min(1).max(9999),
  attributes: z.array(adminV2AttributeValueSchema).max(100),
  colorShadeId: uuidSchema.optional().nullable(),
  mediaPath: z.string().trim().max(512).optional().nullable()
});

const adminV2RelationSchema = z.object({
  id: uuidSchema.optional(),
  targetProductId: uuidSchema,
  relationType: z.enum(["spare_part_for", "accessory_for", "replacement_for", "requires", "included_with", "recommended_with", "compatible_with", "alternative_to"]),
  compatibilityStatus: z.enum(["unknown", "conditional", "confirmed", "not_compatible"]),
  notes: z.string().trim().max(1000).optional().nullable()
});

export const adminV2ProductSchema = z
  .object({
    id: uuidSchema.optional(),
    code: z.string().trim().min(1).max(64),
    slug: slugSchema,
    brandId: uuidSchema,
    productLineId: uuidSchema.optional().nullable(),
    categoryId: uuidSchema,
    templateId: uuidSchema,
    name: z.string().trim().min(1).max(180),
    shortDescription: z.string().trim().max(280).optional().nullable(),
    description: z.string().trim().max(4000).optional().nullable(),
    editorialStatus: z.enum(["draft", "in_review", "published", "hidden", "incomplete"]),
    isActive: z.boolean(),
    isFeatured: z.boolean(),
    productAttributes: z.array(adminV2AttributeValueSchema).max(100),
    variants: z.array(adminV2VariantSchema).min(1).max(500),
    media: z.array(z.object({
      path: z.string().trim().min(1).max(512),
      role: z.enum(["main", "gallery", "color_chart", "technical_sheet", "catalog_pdf", "swatch", "packaging", "detail"]),
      mimeType: z.string().trim().min(3).max(120),
      altText: z.string().trim().max(180).optional().nullable(),
      sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
      isPrimary: z.boolean().optional()
    })).max(100),
    relations: z.array(adminV2RelationSchema).max(100),
    wholesaleMixingPolicy: z.enum(["same_variant", "same_product"]).optional().nullable()
  })
  .superRefine((value, context) => {
    const activeDefaults = value.variants.filter((variant) => variant.isActive && variant.isDefault);
    if (activeDefaults.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Debe existir exactamente una variante predeterminada activa." });
    if (value.editorialStatus === "published" && value.variants.some((variant) => !variant.sku)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Todas las variantes publicadas necesitan SKU." });
    }
  });

export const adminV2StructureSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_category"), name: z.string().trim().min(1).max(120), slug: slugSchema, parentId: uuidSchema.optional().nullable(), templateId: uuidSchema.optional().nullable() }),
  z.object({ action: z.literal("create_template"), name: z.string().trim().min(1).max(120), code: z.string().trim().regex(/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/), description: z.string().trim().max(500).optional().nullable() }),
  z.object({ action: z.literal("create_attribute"), name: z.string().trim().min(1).max(120), code: z.string().trim().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/), dataType: z.enum(["text", "integer", "decimal", "boolean", "date", "single_option", "multi_option", "color", "measurement", "json"]), scope: z.enum(["product", "variant", "both"]), unit: z.string().trim().max(40).optional().nullable(), isRequired: z.boolean(), isVariantAxis: z.boolean(), isFilterable: z.boolean(), options: z.array(z.object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(120) })).max(100) }),
  z.object({ action: z.literal("attach_attribute"), templateId: uuidSchema, attributeDefinitionId: uuidSchema, isRequired: z.boolean(), scope: z.enum(["product", "variant", "both"]), sortOrder: z.coerce.number().int().min(0).max(9999) }),
  z.object({ action: z.literal("create_product_line"), brandId: uuidSchema, templateId: uuidSchema, name: z.string().trim().min(1).max(120), slug: slugSchema }),
  z.object({ action: z.literal("assign_brand_family"), brandId: uuidSchema, templateId: uuidSchema }),
  z.object({ action: z.literal("create_attribute_option"), attributeDefinitionId: uuidSchema, value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("create_color_shade"), brandId: uuidSchema, productLineId: uuidSchema.optional().nullable(), name: z.string().trim().min(1).max(120), code: z.string().trim().min(1).max(80), colorFamilyOptionId: uuidSchema, referenceColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable() })
]);
