"use client";

import { publicEnv } from "@/lib/env/public";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { ApiPdfExport, ApiProduct, ApiTaxonomy, ProductPayload } from "@/lib/admin/types";
import type { AdminV2Bootstrap, AdminV2Product, AdminV2ProductInput } from "@/lib/admin/catalog-v2";
import type {
  CreateReservationInput,
  FulfillmentRequirement,
  MarkFulfillmentInput,
  PendingOperations,
  RegisterSaleInput,
  Reservation,
  Sale,
  SettleSaleBalanceInput,
  TaxDocumentKind,
  TaxDocumentRequirement
} from "@/lib/admin/sales";
import type {
  CashMovement,
  CashSession,
  Expense,
  ExpenseCategory,
  InventoryPosition,
  KardexEntry
} from "@/lib/admin/operations";
import type { adjustInventorySchema, registerExpenseSchema } from "@/lib/admin/operations";
import type {
  AdminCartSummary,
  CampaignInfo,
  ChannelInfo,
  ConversationAction,
  ConversationDetail,
  ConversationSummary,
  OmnichannelMetrics,
  createCampaignSchema,
  createChannelAccountSchema
} from "@/lib/admin/omnichannel";
import type { BusinessDashboard } from "@/lib/admin/analytics";
import type { OrderProposal } from "@/lib/ai/matching";
import type { AiProviderInfo, ContentProposalRow } from "@/lib/ai/contracts";
import type { VisionResult } from "@/lib/ai/vision";
import type {
  GoodsReceipt,
  PurchaseOrder,
  SupplierBalance,
  SupplierObligation,
  SupplierPayment,
  issuePurchaseOrderSchema,
  registerGoodsReceiptSchema,
  registerSupplierPaymentSchema
} from "@/lib/admin/purchasing";
import type { PosSearchResult, PosToneSheet } from "@/lib/admin/pos";
import type { z } from "zod";

type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
type RegisterExpenseInput = z.infer<typeof registerExpenseSchema>;
type IssuePurchaseOrderInput = z.infer<typeof issuePurchaseOrderSchema>;
type RegisterGoodsReceiptInput = z.infer<typeof registerGoodsReceiptSchema>;
type RegisterSupplierPaymentInput = z.infer<typeof registerSupplierPaymentSchema>;

import type {
  CatalogImportCommitResult,
  CatalogImportProductLineApproval,
  CatalogImportPreview,
  CatalogMediaPackageCommitResult,
  CatalogMediaPackagePreview
} from "@/lib/admin/catalog-import-types";

/** Fila de listado: la venta completa, sin líneas ni pagos. */
export type SaleSummary = Omit<Sale, "lines" | "payments" | "taxDocument"> & { branchName?: string };
export type ReservationSummary = Omit<Reservation, "lines" | "payments" | "advanceTotal" | "balance"> & {
  createdAt: string;
};

/** Proveedor habilitado para comprar. */
export type SupplierOption = {
  id: string;
  code: string;
  name: string;
  status: string;
  defaultCurrency: string;
  paymentTermsDays: number;
};

/** Fila de listado: la orden sin sus líneas. */
export type PurchaseOrderSummary = Omit<PurchaseOrder, "lines"> & { supplierName: string };
export type GoodsReceiptSummary = Omit<GoodsReceipt, "lines"> & { supplierName?: string };

export type SupplierDebt = {
  balances: SupplierBalance[];
  obligations: SupplierObligation[];
  advances: {
    paymentId: string;
    supplierId: string;
    currency: string;
    amount: number;
    unallocated: number;
    paidAt: string;
  }[];
};

/** Sede en la que la persona puede operar, resuelta con el predicado de la RLS. */
export type OperableBranch = {
  id: string;
  code: string;
  name: string;
  district: string | null;
  isDefault: boolean;
};

/** Una clienta encontrada desde el mostrador. Lo mínimo para reconocerla. */
export type PersonMatch = {
  id: string;
  fullName: string;
  phone: string | null;
  document: string | null;
};

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const bodyIsFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body && !bodyIsFormData ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });

  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    // Sin cuerpo JSON (p. ej. 204).
  }

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new AdminApiError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? `La solicitud falló (${response.status}).`
    );
  }

  return (body as { data: T }).data;
}

export const adminApi = {
  listProducts: () =>
    request<{ items: ApiProduct[] }>("/api/admin/products?limit=100").then((r) => r.items),
  // Lista paginada de verdad: con el catálogo real (1,000+ productos) la vista
  // pide páginas al servidor en vez de recortar una sola respuesta.
  listProductsPage: (params: {
    page: number;
    pageSize: number;
    q?: string;
    estado?: "publicado" | "borrador" | "oculto";
    brandId?: string;
  }) => {
    const search = new URLSearchParams();
    search.set("limit", String(params.pageSize));
    search.set("offset", String((params.page - 1) * params.pageSize));
    if (params.q) search.set("q", params.q);
    if (params.estado) search.set("estado", params.estado);
    if (params.brandId) search.set("brandId", params.brandId);
    return request<{ items: ApiProduct[]; total: number }>(`/api/admin/products?${search.toString()}`);
  },
  getProduct: (id: string) => request<ApiProduct>(`/api/admin/products/${id}`),
  createProduct: (payload: ProductPayload) =>
    request<ApiProduct>("/api/admin/products", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateProduct: (id: string, payload: Partial<ProductPayload>) =>
    request<ApiProduct>(`/api/admin/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  listBrands: () => request<{ items: ApiTaxonomy[] }>("/api/admin/brands").then((r) => r.items),
  createBrand: (name: string) =>
    request<ApiTaxonomy>("/api/admin/brands", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  listCategories: () =>
    request<{ items: ApiTaxonomy[] }>("/api/admin/categories").then((r) => r.items),
  createCategory: (name: string) =>
    request<ApiTaxonomy>("/api/admin/categories", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  pdfStatus: () =>
    request<{ catalogUpdatedAt: string | null; items: ApiPdfExport[] }>("/api/admin/pdf"),
  pdfGenerate: () => request<ApiPdfExport>("/api/admin/pdf/generate", { method: "POST" }),
  pdfDownloadUrl: (id: string) =>
    request<{ downloadUrl: string; expiresInSeconds: number }>(`/api/admin/pdf/${id}/download`),
  createUploadUrl: (kind: "product-image" | "color-chart", fileName: string, contentType: string) =>
    request<{ bucket: string; path: string; signedUrl: string; token: string }>(
      "/api/admin/assets/upload-url",
      {
        method: "POST",
        body: JSON.stringify({ kind, fileName, contentType })
      }
    ),
  catalogV2Bootstrap: () => request<AdminV2Bootstrap>("/api/admin/catalog-v2/bootstrap"),
  getCatalogV2Product: (id: string) =>
    request<AdminV2Product>(`/api/admin/catalog-v2/products/${id}`),
  createCatalogV2Product: (payload: AdminV2ProductInput) =>
    request<AdminV2Product>("/api/admin/catalog-v2/products", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateCatalogV2Product: (id: string, payload: AdminV2ProductInput) =>
    request<AdminV2Product>(`/api/admin/catalog-v2/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  searchCatalogV2Relations: (query: string, excludeId?: string, context?: {
    purpose?: "strip_lash_adhesive";
    brandId?: string;
    scope?: "same_type" | "compatible" | "all";
    sourceTemplateCode?: string;
    accessoryDomain?: string;
    adhesiveApplication?: string;
    adhesiveBrandScope?: string;
  }) => {
    const parameters = new URLSearchParams({ q: query });
    if (excludeId) parameters.set("exclude", excludeId);
    if (context?.purpose) parameters.set("purpose", context.purpose);
    if (context?.brandId) parameters.set("brand", context.brandId);
    if (context?.scope) parameters.set("scope", context.scope);
    if (context?.sourceTemplateCode) parameters.set("source_template", context.sourceTemplateCode);
    if (context?.accessoryDomain) parameters.set("accessory_domain", context.accessoryDomain);
    if (context?.adhesiveApplication) parameters.set("adhesive_application", context.adhesiveApplication);
    if (context?.adhesiveBrandScope) parameters.set("adhesive_brand_scope", context.adhesiveBrandScope);
    return request<AdminV2Bootstrap["relationCandidates"]>(`/api/admin/catalog-v2/relations?${parameters.toString()}`);
  },
  mutateCatalogV2Structure: (payload: Record<string, unknown>) =>
    request<unknown>("/api/admin/catalog-v2/structure", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createCatalogV2ProductLine: (brandId: string, templateId: string, name: string, slug: string) =>
    request<{ id: string; brand_id: string; name: string; slug: string }>("/api/admin/catalog-v2/structure", {
      method: "POST",
      body: JSON.stringify({ action: "create_product_line", brandId, templateId, name, slug })
    }),
  assignCatalogV2BrandFamily: (brandId: string, templateId: string) =>
    request<{ brand_id: string; template_id: string }>("/api/admin/catalog-v2/structure", {
      method: "POST",
      body: JSON.stringify({ action: "assign_brand_family", brandId, templateId })
    }),
  createCatalogV2AttributeOption: (attributeDefinitionId: string, value: string, label: string) =>
    request<{ id: string; attribute_definition_id: string; value: string; label: string }>("/api/admin/catalog-v2/structure", {
      method: "POST",
      body: JSON.stringify({ action: "create_attribute_option", attributeDefinitionId, value, label })
    }),
  createCatalogV2ColorShade: (payload: { brandId: string; productLineId?: string | null; name: string; code: string; colorFamilyOptionId: string; referenceColor?: string | null }) =>
    request<{ id: string; brand_id: string; product_line_id: string | null; name: string; code: string; tone_option_id: string; color_family_option_id: string; reference_color: string | null }>("/api/admin/catalog-v2/structure", {
      method: "POST",
      body: JSON.stringify({ action: "create_color_shade", ...payload })
    }),
  previewCatalogImport: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<CatalogImportPreview>("/api/admin/importaciones/preview", { method: "POST", body });
  },
  commitCatalogImport: (file: File, expectedSha256: string, productLineApprovals: CatalogImportProductLineApproval[] = []) => {
    const body = new FormData();
    body.set("file", file);
    body.set("expectedSha256", expectedSha256);
    body.set("confirmation", productLineApprovals.length ? "AUTORIZAR E IMPORTAR" : "IMPORTAR");
    body.set("productLineApprovals", JSON.stringify(productLineApprovals));
    return request<CatalogImportCommitResult>("/api/admin/importaciones/commit", { method: "POST", body });
  },
  previewBulkImport: (file: File, lote: { name: string; familias?: string[]; fromRow?: number; toRow?: number }) => {
    const body = new FormData();
    body.set("file", file);
    body.set("lote", JSON.stringify(lote));
    return request<import("@/lib/admin/catalog-bulk-import/types").BulkBatchPreview>("/api/admin/importaciones/bulk/preview", { method: "POST", body });
  },
  approveBulkImport: (payload: { batchId: string; includeReview?: boolean; rowNumbers?: number[]; skipRowNumbers?: number[] }) =>
    request<{ approved: number; skipped: number; blockedByIssues: number; preview: import("@/lib/admin/catalog-bulk-import/types").BulkBatchPreview }>("/api/admin/importaciones/bulk/approve", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  commitBulkImport: (payload: { batchId: string; confirmation: string }) =>
    request<import("@/lib/admin/catalog-bulk-import/types").BulkCommitReport>("/api/admin/importaciones/bulk/commit", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listBulkImportBatches: () =>
    request<{ batches: Array<{ id: string; source_name: string; original_file_name: string | null; status: string; total_rows: number; processed_rows: number; error_rows: number; en_revision: number; issues_abiertos: number; committed_at: string | null; created_at: string; summary: Record<string, unknown> }> }>("/api/admin/importaciones/bulk/report").then((result) => result.batches),
  // Reabre las excepciones de un lote pasado sin volver a subir el Excel.
  getBulkImportPreview: (batchId: string) =>
    request<import("@/lib/admin/catalog-bulk-import/types").BulkBatchPreview>(`/api/admin/importaciones/bulk/report?batchId=${encodeURIComponent(batchId)}&view=preview`),
  syncBulkImportMedia: (batchId: string) =>
    request<{ variantesConImagen: number; productosConImagen: number; sinCambio: number }>("/api/admin/importaciones/bulk/media-sync", {
      method: "POST",
      body: JSON.stringify({ batchId })
    }),
  previewCatalogMediaPackage: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<CatalogMediaPackagePreview>("/api/admin/importaciones/media/preview", { method: "POST", body });
  },
  commitCatalogMediaPackage: (file: File, expectedSha256: string) => {
    const body = new FormData();
    body.set("file", file);
    body.set("expectedSha256", expectedSha256);
    body.set("confirmation", "SUBIR MEDIOS");
    return request<CatalogMediaPackageCommitResult>("/api/admin/importaciones/media/commit", { method: "POST", body });
  },
  listOperableBranches: () =>
    request<{ items: OperableBranch[] }>("/api/admin/branches").then((result) => result.items),
  listBranches: () =>
    request<{ items: OperableBranch[] }>("/api/admin/branches").then((result) => result.items),

  // --- Operación diaria: inventario, caja y gastos -------------------------
  listInventory: (filters: { branchId?: string; search?: string; onlyLow?: boolean } = {}) => {
    const parameters = new URLSearchParams();
    if (filters.branchId) parameters.set("branch", filters.branchId);
    if (filters.search) parameters.set("search", filters.search);
    if (filters.onlyLow) parameters.set("low", "true");
    return request<{ items: InventoryPosition[] }>(
      `/api/admin/inventory?${parameters.toString()}`
    ).then((result) => result.items);
  },
  // El kardex es por variante Y sede: la sede es obligatoria porque el saldo lo
  // es, y `inventory_ledger` revalida el permiso sobre esa sede.
  getKardex: (variantId: string, branchId: string) => {
    const parameters = new URLSearchParams({ variant: variantId, branch: branchId });
    return request<{ items: KardexEntry[] }>(
      `/api/admin/inventory/kardex?${parameters.toString()}`
    ).then((result) => result.items);
  },
  adjustInventory: (payload: AdjustInventoryInput) =>
    request<unknown>("/api/admin/inventory", { method: "POST", body: JSON.stringify(payload) }),

  listCashSessions: (status?: string) =>
    request<{ items: CashSession[] }>(
      status ? `/api/admin/cash?status=${status}` : "/api/admin/cash"
    ).then((result) => result.items),
  getCashSession: (id: string) =>
    request<{ session: CashSession; movements: CashMovement[] }>(`/api/admin/cash/${id}`),
  openCashSession: (payload: { branchId: string; openingFloat: number; note?: string | null }) =>
    request<CashSession>("/api/admin/cash", { method: "POST", body: JSON.stringify(payload) }),
  closeCashSession: (id: string, payload: { countedCash: number; note?: string | null }) =>
    request<CashSession>(`/api/admin/cash/${id}`, { method: "POST", body: JSON.stringify(payload) }),

  listExpenses: (filters: { from?: string; to?: string; includeVoided?: boolean } = {}) => {
    const parameters = new URLSearchParams();
    if (filters.from) parameters.set("from", filters.from);
    if (filters.to) parameters.set("to", filters.to);
    if (filters.includeVoided) parameters.set("voided", "true");
    return request<{ categories: ExpenseCategory[]; items: Expense[] }>(
      `/api/admin/expenses?${parameters.toString()}`
    );
  },
  registerExpense: (payload: RegisterExpenseInput) =>
    request<Expense>("/api/admin/expenses", { method: "POST", body: JSON.stringify(payload) }),
  voidExpense: (id: string, reason: string) =>
    request<Expense>(`/api/admin/expenses/${id}`, {
      method: "POST",
      body: JSON.stringify({ reason })
    }),
  listSales: () =>
    request<{ items: SaleSummary[] }>("/api/admin/sales").then((result) => result.items),
  getSale: (id: string) => request<Sale>(`/api/admin/sales/${id}`),

  // --- POS: las tres velocidades de la venta -------------------------------
  // 1 y 2 («sé qué quiere» / «lo tengo en la mano») las resuelve la búsqueda,
  // que devuelve la variante directa y, agrupados, los productos con muchos
  // tonos. 3 («la clienta quiere elegir») abre la hoja de tonos.
  searchPos: (branchId: string, query: string) => {
    const parameters = new URLSearchParams({ branch: branchId, q: query });
    return request<PosSearchResult>(`/api/admin/sales/search?${parameters.toString()}`);
  },
  getToneSheet: (branchId: string, productId: string) => {
    const parameters = new URLSearchParams({ branch: branchId, product: productId });
    return request<PosToneSheet>(`/api/admin/sales/tones?${parameters.toString()}`);
  },
  registerSale: (payload: RegisterSaleInput) =>
    request<Sale>("/api/admin/sales", { method: "POST", body: JSON.stringify(payload) }),
  // Qué pedir en cada método de entrega. Sale de la base, no de una constante:
  // es la misma regla que después impide cerrar una venta incompleta.
  listFulfillmentRequirements: () =>
    request<{ items: FulfillmentRequirement[] }>("/api/admin/sales/entrega").then((result) => result.items),
  // Lo que queda por hacer: reservas vivas, pedidos por entregar y ventas por
  // cobrar. El saldo llega resuelto de PostgreSQL; aquí no se resta nada.
  listPendingOperations: () => request<PendingOperations>("/api/admin/pendientes"),
  settleSaleBalance: (id: string, payload: SettleSaleBalanceInput) =>
    request<Sale>(`/api/admin/sales/${id}/saldo`, { method: "POST", body: JSON.stringify(payload) }),
  markSaleFulfillment: (id: string, payload: MarkFulfillmentInput) =>
    request<Sale>(`/api/admin/sales/${id}/entrega`, { method: "POST", body: JSON.stringify(payload) }),
  // Qué exige cada comprobante. Sale de la base, no de una constante: son
  // reglas de la SUNAT y cambian sin avisarnos.
  listTaxDocumentRequirements: () =>
    request<{ items: TaxDocumentRequirement[] }>("/api/admin/sales/comprobante").then((r) => r.items),
  requestTaxDocument: (id: string, payload: { kind: TaxDocumentKind; receiver?: unknown }) =>
    request<Sale>(`/api/admin/sales/${id}`, { method: "POST", body: JSON.stringify(payload) }),
  // Asociar clienta es opcional: esto solo se llama si la vendedora abre la
  // ventana, nunca al cargar la pantalla de venta.
  searchPersons: (q: string) =>
    request<PersonMatch[]>(`/api/admin/personas?q=${encodeURIComponent(q)}`),
  createPerson: (payload: { fullName: string; phone?: string | null; document?: string | null }) =>
    request<PersonMatch>("/api/admin/personas", { method: "POST", body: JSON.stringify(payload) }),
  listReservations: (status?: string) =>
    request<{ items: ReservationSummary[] }>(
      status ? `/api/admin/reservations?status=${status}` : "/api/admin/reservations"
    ).then((result) => result.items),
  getReservation: (id: string) => request<Reservation>(`/api/admin/reservations/${id}`),
  createReservation: (payload: CreateReservationInput) =>
    request<Reservation>("/api/admin/reservations", { method: "POST", body: JSON.stringify(payload) }),
  releaseReservation: (id: string, reason: string, status: "released" | "cancelled" = "released") =>
    request<Reservation>(`/api/admin/reservations/${id}`, {
      method: "POST",
      body: JSON.stringify({ reason, status })
    }),

  // --- Abastecimiento ------------------------------------------------------
  listSuppliers: () =>
    request<{ items: SupplierOption[] }>("/api/admin/suppliers").then((result) => result.items),
  listPurchaseOrders: (status?: string) =>
    request<{ items: PurchaseOrderSummary[] }>(
      status ? `/api/admin/purchase-orders?status=${status}` : "/api/admin/purchase-orders"
    ).then((result) => result.items),
  getPurchaseOrder: (id: string) => request<PurchaseOrder>(`/api/admin/purchase-orders/${id}`),
  issuePurchaseOrder: (payload: IssuePurchaseOrderInput) =>
    request<PurchaseOrder>("/api/admin/purchase-orders", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listReceipts: (supplierId?: string) =>
    request<{ items: GoodsReceiptSummary[] }>(
      supplierId ? `/api/admin/receipts?supplier=${supplierId}` : "/api/admin/receipts"
    ).then((result) => result.items),
  registerGoodsReceipt: (payload: RegisterGoodsReceiptInput) =>
    request<GoodsReceipt>("/api/admin/receipts", { method: "POST", body: JSON.stringify(payload) }),
  supplierDebt: (supplierId?: string) =>
    request<SupplierDebt>(
      supplierId ? `/api/admin/suppliers/debt?supplier=${supplierId}` : "/api/admin/suppliers/debt"
    ),
  registerSupplierPayment: (payload: RegisterSupplierPaymentInput) =>
    request<SupplierPayment>("/api/admin/suppliers/payments", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  // --- Omnicanal (Bloque 3) ------------------------------------------------
  listConversations: (filters?: { status?: string; channel?: string; assigned?: string }) => {
    const parameters = new URLSearchParams();
    if (filters?.status) parameters.set("status", filters.status);
    if (filters?.channel) parameters.set("channel", filters.channel);
    if (filters?.assigned) parameters.set("assigned", filters.assigned);
    const suffix = parameters.size ? `?${parameters.toString()}` : "";
    return request<{ items: ConversationSummary[] }>(`/api/admin/conversations${suffix}`)
      .then((result) => result.items);
  },
  getConversation: (id: string) => request<ConversationDetail>(`/api/admin/conversations/${id}`),
  actOnConversation: (id: string, action: ConversationAction) =>
    request<ConversationDetail>(`/api/admin/conversations/${id}`, {
      method: "POST",
      body: JSON.stringify(action)
    }),
  listAdminCarts: (status?: string) =>
    request<{ items: AdminCartSummary[] }>(
      status ? `/api/admin/carts?status=${status}` : "/api/admin/carts"
    ).then((result) => result.items),
  listChannels: () =>
    request<{ items: ChannelInfo[] }>("/api/admin/channels").then((result) => result.items),
  createChannelAccount: (payload: z.infer<typeof createChannelAccountSchema>) =>
    request<{ id: string }>("/api/admin/channels", { method: "POST", body: JSON.stringify(payload) }),
  listCampaigns: () =>
    request<{ items: CampaignInfo[] }>("/api/admin/campaigns").then((result) => result.items),
  createCampaign: (payload: z.infer<typeof createCampaignSchema>) =>
    request<{ id: string; code: string }>("/api/admin/campaigns", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getAttribution: () =>
    request<{
      metrics: OmnichannelMetrics;
      chains: {
        id: string; firstTouchAt: string; lastTouchAt: string;
        firstSource: string | null; lastSource: string | null; campaign: string | null;
        hasConversation: boolean; hasCart: boolean; hasSale: boolean;
      }[];
    }>("/api/admin/attribution"),
  getDashboard: (params: { desde?: string; hasta?: string; sede?: string }) => {
    const query = new URLSearchParams();
    if (params.desde) query.set("desde", params.desde);
    if (params.hasta) query.set("hasta", params.hasta);
    if (params.sede) query.set("sede", params.sede);
    const suffix = query.toString();
    return request<{ dashboard: BusinessDashboard }>(
      suffix ? `/api/admin/analytics?${suffix}` : "/api/admin/analytics"
    ).then((result) => result.dashboard);
  },
  interpretOrderAssist: (payload: { texto: string; sedeId?: string | null }) =>
    request<{ interactionId: string; propuesta: OrderProposal; proveedor: AiProviderInfo }>(
      "/api/admin/assistant/interpret",
      { method: "POST", body: JSON.stringify(payload) }
    ),
  photoAssist: (payload: { imagenBase64: string; mediaType: string; etapa: "single" | "small_group" }) =>
    request<{ interactionId: string; resultado: VisionResult }>(
      "/api/admin/assistant/photo",
      { method: "POST", body: JSON.stringify(payload) }
    ),
  adviseAssist: (payload: { pregunta: string; conversacionId?: string | null; contexto?: string | null }) =>
    request<{
      interactionId: string;
      respuesta: string;
      recomendaciones: { variantId: string; sku: string | null; nombre: string; razon: string }[];
      proveedor: AiProviderInfo;
    }>("/api/admin/assistant/advise", { method: "POST", body: JSON.stringify(payload) }),
  resolveAssist: (payload: {
    interactionId: string;
    estado: "confirmed" | "discarded";
    saleId?: string | null;
    reservationId?: string | null;
    nota?: string | null;
  }) =>
    request<{ id: string; status: string }>("/api/admin/assistant/resolve", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listTrendProposals: () =>
    request<{ items: ContentProposalRow[] }>("/api/admin/assistant/trends").then((result) => result.items),
  generateTrendProposal: () =>
    request<{ proposalId: string; titulo: string; proveedor: { estado: string; detalle: string | null } }>(
      "/api/admin/assistant/trends",
      { method: "POST" }
    ),
  actOnTrendProposal: (payload: { proposalId: string; accion: "approved" | "rejected" | "published"; nota?: string | null }) =>
    request<{ id: string; status: string }>("/api/admin/assistant/trends", {
      method: "PATCH",
      body: JSON.stringify(payload)
    })
};

export async function uploadCatalogImage(kind: "product-image" | "color-chart", file: File) {
  const target = await adminApi.createUploadUrl(kind, file.name, file.type);
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.storage
    .from(target.bucket)
    .uploadToSignedUrl(target.path, target.token, file, { contentType: file.type });

  if (error) {
    throw new AdminApiError(400, "upload_failed", error.message);
  }

  return target.path;
}

export function publicAssetUrl(path: string) {
  return `${publicEnv.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/catalog-assets/${path}`;
}

export function formatPrice(value: number) {
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `S/ ${fixed}`;
}

export function formatDateTime(iso: string | null) {
  if (!iso) {
    return "—";
  }

  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
