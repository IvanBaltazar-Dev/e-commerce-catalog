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
