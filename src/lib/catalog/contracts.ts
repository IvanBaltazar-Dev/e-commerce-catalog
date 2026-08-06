export type AvailabilityStatus = "available" | "sold_out" | "consult";
export type PurchaseMode = "retail" | "wholesale" | "consult";

export type CatalogTaxonomyRef = {
  id: string;
  name: string;
  slug: string;
  path?: string | null;
};

export type CatalogFeaturedVariant = {
  id: string;
  sku: string;
  name: string;
  availability: AvailabilityStatus;
  price: number | null;
  image: string | null;
};

export type CatalogListItem = {
  productId: string;
  slug: string;
  name: string;
  brand: CatalogTaxonomyRef;
  category: CatalogTaxonomyRef;
  mainImage: string | null;
  startingPrice: number | null;
  priceRange: { min: number | null; max: number | null; currency: string };
  availabilitySummary: { available: number; soldOut: number; consult: number };
  hasMultipleVariants: boolean;
  featuredVariant: CatalogFeaturedVariant;
};

export type CatalogAvailableFilter = {
  code: string;
  name: string;
  dataType: string;
  options: { value: string; label: string }[];
};

export type CatalogListResponse = {
  items: CatalogListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  availableFilters: CatalogAvailableFilter[];
};

export type CatalogAttribute = {
  code: string;
  name: string;
  dataType: string;
  unit: string | null;
  value: unknown;
  optionValue?: string | null;
};

export type CatalogMedia = {
  id: string;
  role: string;
  path: string;
  mimeType: string;
  altText: string | null;
  isPrimary: boolean;
};

export type CatalogVariantPrice = {
  priceListCode: string;
  type: "retail" | "wholesale" | "special";
  amount: number;
  minimumQuantity: number;
  currency: string;
};

export type PurchasableVariant = {
  id: string;
  sku: string;
  name: string;
  variantKey: string;
  availability: AvailabilityStatus;
  isDefault: boolean;
  attributes: CatalogAttribute[];
  prices: CatalogVariantPrice[];
  media: CatalogMedia[];
};

export type WholesaleRule = {
  id: string;
  name: string;
  scopeType: "variant" | "product" | "brand" | "category";
  minimumQuantity: number;
  mixingPolicy: "same_variant" | "same_product" | "same_brand" | "same_category";
  priceListCode: string;
  priority: number;
};

export type CatalogProductDetail = {
  productId: string;
  code: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  brand: CatalogTaxonomyRef;
  category: CatalogTaxonomyRef;
  template: { id: string; code: string; name: string };
  attributes: CatalogAttribute[];
  media: CatalogMedia[];
  variants: PurchasableVariant[];
  wholesaleRules: WholesaleRule[];
  relations: Array<{
    id: string;
    type: string;
    compatibilityStatus: string;
    sourceProductId: string | null;
    sourceVariantId: string | null;
    targetProductId: string | null;
    targetVariantId: string | null;
    notes: string | null;
  }>;
};

export type CartLine = {
  productId: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  slug: string;
  imagePath: string | null;
  quantity: number;
  unitPrice: number | null;
  purchaseMode: PurchaseMode;
  availability: AvailabilityStatus;
};

export type EvaluatedCartLine = CartLine & {
  brandName: string;
  subtotal: number | null;
  productQuantity: number;
  wholesaleRule: {
    id: string;
    name: string;
    minimumQuantity: number;
    mixingPolicy: string;
  } | null;
};

export type CartEvaluation = {
  lines: EvaluatedCartLine[];
  totalUnits: number;
  subtotal: number | null;
  unresolvedLines: number;
};

export type WhatsAppOrder = CartEvaluation & {
  deliveryMethod?: "shipping" | "pickup";
  customerNote?: string | null;
};

export type PdfCatalogItem = CatalogListItem & {
  detail: CatalogProductDetail;
};
