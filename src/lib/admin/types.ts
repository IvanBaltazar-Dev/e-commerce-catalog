export type LampType = "No" | "Sí" | "UV/LED";
export type Availability = "available" | "sold_out" | "consult";
export type ColorChartStatus = "available" | "consult_advisor";
export type PdfExportStatus = "not_generated" | "generating" | "updated" | "outdated" | "error";

export type ApiTaxonomy = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type ApiGalleryImage = {
  id: string;
  path: string;
  alt_text: string | null;
  sort_order: number;
};

export type ApiProduct = {
  id: string;
  code: string;
  slug: string;
  name: string;
  presentation: string;
  product_type: string;
  requires_lamp: boolean;
  lamp_type: LampType | null;
  description: string | null;
  unit_price: number;
  wholesale_price: number;
  wholesale_min_quantity: number;
  availability: Availability;
  color_chart_status: ColorChartStatus;
  main_image_path: string | null;
  color_chart_image_path: string | null;
  color_chart_pdf_path: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  brand: { id: string; name: string; slug: string } | null;
  category: { id: string; name: string; slug: string } | null;
  gallery: ApiGalleryImage[];
};

export type ApiPdfExport = {
  id: string;
  status: PdfExportStatus;
  storage_path: string | null;
  generated_at: string | null;
  catalog_updated_at_snapshot: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  isStale: boolean;
};

export type ProductPayload = {
  code: string;
  brandId: string;
  categoryId: string;
  name: string;
  presentation: string;
  productType: string;
  requiresLamp: boolean;
  lampType: LampType;
  description: string | null;
  unitPrice: number;
  wholesalePrice: number;
  wholesaleMinQuantity: number;
  availability: Availability;
  colorChartStatus: ColorChartStatus;
  mainImagePath: string | null;
  colorChartImagePath: string | null;
  isActive: boolean;
  gallery: { path: string; sortOrder: number }[];
};
