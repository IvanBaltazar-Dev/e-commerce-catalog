export type BulkListingRow = {
  /** Número de fila real en la hoja «Catálogo organizado» del Excel original. */
  row: number;
  categoria: string | null;
  familia: string | null;
  estado: string | null;
  codigo: string | null;
  marca: string | null;
  descripcion: string | null;
  categoriaOriginal: string | null;
  codigoProveedor: string | null;
  proveedor: string | null;
};

export type BulkAxisCode =
  | "tone"
  | "color"
  | "aroma"
  | "size_label"
  | "set_name"
  | "shape"
  | "lash_length"
  | "presentation";

export type BulkConfidence = "exact" | "high" | "review";

export type BulkAxisValue = {
  code: BulkAxisCode;
  /** Valor normalizado (slug/minúsculas) usado para variant_key y opciones. */
  value: string;
  /** Etiqueta humana con la grafía del Excel ya limpiada. */
  label: string;
  confidence: BulkConfidence;
};

export type BulkColorInfo = {
  shadeName: string;
  shadeCode: string;
  colorFamilyValue: string;
  /** #RRGGBB solo cuando el tono es una palabra de color conocida; jamás inventado. */
  referenceColor: string | null;
};

export type BulkMediaMatch = {
  storagePath: string;
  mechanism:
    | "package_direct"
    | "internal_code"
    | "supplier_code"
    | "brand_model"
    | "brand_exact_name"
    | "assisted";
  confidence: "exact" | "high" | "review";
  target: "product" | "variant";
  role: "main" | "swatch" | "gallery";
};

export type BulkMediaStatus = "exact" | "high" | "review" | "missing" | "color_fallback";

export type BulkProposedAction =
  | "create_product"
  | "create_variant"
  | "update_product"
  | "update_variant"
  | "skip"
  | "merge";

export type BulkNormalizedRecord = {
  source: {
    sheet: string;
    row: number;
    estado: string | null;
    categoriaOriginal: string | null;
  };
  classification: {
    familia: string | null;
    categoryPath: string | null;
    templateCode: string | null;
    confidence: BulkConfidence;
  };
  identity: {
    internalCode: string | null;
    supplierCode: string | null;
    supplierName: string | null;
    brandName: string | null;
    brandSlug: string | null;
    brandIsGeneric: boolean;
  };
  naming: {
    originalDescription: string | null;
    normalizedName: string;
    baseName: string;
    presentation: string | null;
  };
  grouping: {
    productKey: string;
    productCode: string;
    productName: string;
    productSlug: string;
    variantKey: string;
    variantName: string;
    axes: BulkAxisValue[];
    confidence: BulkConfidence;
  };
  attributes: Array<{ code: string; value: string; source: "description" | "family" }>;
  color: BulkColorInfo | null;
  supplier: { name: string; supplierSku: string | null } | null;
  media: {
    matches: BulkMediaMatch[];
    status: BulkMediaStatus;
    backfill: "color" | "pending" | null;
  };
  action: BulkProposedAction;
  review: string[];
};

export type BulkRowIssue = {
  row: number;
  severity: "info" | "warning" | "error" | "blocking";
  code: string;
  field: string | null;
  message: string;
};

export type BulkBatchCounts = {
  filasProcesadas: number;
  productosNuevos: number;
  productosReutilizados: number;
  variantesCreadas: number;
  duplicadosEvitados: number;
  imagenesExactas: number;
  imagenesAltaConfianza: number;
  imagenesEnRevision: number;
  imagenesFaltantes: number;
  variantesConColorRespaldo: number;
  filasRechazadas: number;
  issues: number;
  duracionMs: number;
};

export type BulkBatchPreview = {
  batchId: string;
  fileName: string;
  fileSha256: string;
  loteName: string;
  familias: string[];
  status: string;
  totalRows: number;
  productos: Array<{
    productCode: string;
    productName: string;
    brand: string;
    familia: string | null;
    action: BulkProposedAction;
    variantCount: number;
    reviewCount: number;
    mediaStatus: Record<BulkMediaStatus, number>;
  }>;
  porAccion: Record<BulkProposedAction, number>;
  porEstadoFila: Record<string, number>;
  excepciones: Array<{
    importRowId: string;
    row: number;
    productCode: string;
    variantKey: string;
    description: string | null;
    reasons: string[];
    issues: BulkRowIssue[];
  }>;
  issuesAbiertos: number;
  canCommit: boolean;
};

export type BulkCommitReport = {
  batchId: string;
  loteName: string;
  counts: BulkBatchCounts;
  productos: Array<{ id: string; code: string; name: string; created: boolean; variants: number }>;
  rechazadas: Array<{ row: number; reason: string }>;
};
