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

export type PhotoState = "con_foto" | "solo_respaldo" | "sin_foto";

// Las fotos del catálogo cuelgan de las variantes, no del producto: un esmalte
// con 159 tonos tiene 159 imágenes y ningún `main_image_path`. Esto resume, por
// producto, lo que le llega por cualquiera de los dos caminos.
export type ApiProductMediaState = {
  estado_foto: PhotoState;
  fotos_total: number;
  fotos_envase: number;
  fotos_construidas: number;
  portada_path: string | null;
};

export type ApiPhotoCoverage = {
  con_foto: number;
  solo_respaldo: number;
  sin_foto: number;
};

export type ApiPublicationSplit = {
  publicado: number;
  borrador: number;
  oculto: number;
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
  editorial_status: "draft" | "in_review" | "published" | "hidden" | "incomplete";
  sort_order: number;
  created_at: string;
  updated_at: string;
  brand: { id: string; name: string; slug: string } | null;
  category: { id: string; name: string; slug: string } | null;
  gallery: ApiGalleryImage[];
  media_state?: ApiProductMediaState;
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
