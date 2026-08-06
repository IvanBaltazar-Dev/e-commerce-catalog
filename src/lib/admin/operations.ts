import { z } from "zod";
import { paymentMethodSchema, type PaymentMethod } from "@/lib/admin/sales";

/**
 * Contratos de la operación diaria: inventario, caja, gastos, traslados y carga
 * inicial. Ningún importe ni disponibilidad se calcula aquí — todo sale de los
 * contratos SQL de 0028 a 0032.
 */

// ---------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------

export type InventoryPosition = {
  variantId: string;
  branchId: string;
  branchName: string;
  sku: string | null;
  productName: string;
  variantName: string;
  onHand: number;
  reserved: number;
  available: number;
  /** Unidades sin costo conocido. No son unidades a costo cero. */
  unvaluedQuantity: number;
  /** Nulo para la vendedora: la RLS de `inventory_valuation` no le devuelve filas. */
  averageUnitCost: number | null;
  totalValue: number | null;
};

export type KardexEntry = {
  id: number;
  movementType: string;
  quantity: number;
  balanceAfter: number;
  unitCost: number | null;
  valueDelta: number | null;
  valueAfter: number | null;
  costBasis: "weighted_average" | "unknown" | "mixed" | null;
  sourceType: string | null;
  sourceLabel: string | null;
  actorLabel: string | null;
  reason: string | null;
  occurredAt: string;
};

export const adjustInventorySchema = z.object({
  variantId: z.string().uuid(),
  branchId: z.string().uuid(),
  quantity: z.coerce.number().int().refine((value) => value !== 0, "El ajuste no puede ser de cero unidades."),
  reason: z.string().trim().min(1, "Un ajuste de inventario exige un motivo.").max(300),
  unitCost: z.coerce.number().min(0).optional().nullable()
});

// ---------------------------------------------------------------------------
// Caja
// ---------------------------------------------------------------------------

export const openCashSessionSchema = z.object({
  branchId: z.string().uuid(),
  openingFloat: z.coerce.number().min(0).default(0),
  note: z.string().trim().max(300).optional().nullable()
});

export const closeCashSessionSchema = z.object({
  countedCash: z.coerce.number().min(0),
  note: z.string().trim().max(300).optional().nullable()
});

export type CashMethodTotal = { method: PaymentMethod; total: number; movements: number };

export type CashSession = {
  id: string;
  sessionNumber: string;
  branchId: string;
  status: "open" | "closed";
  openingFloat: number;
  openedAt: string;
  openedByLabel: string | null;
  closedAt: string | null;
  closedByLabel: string | null;
  countedCash: number | null;
  /** Lo que el sistema esperaba, congelado al cerrar. */
  expectedCash: number | null;
  difference: number | null;
  /** Efectivo esperado ahora mismo, para la caja todavía abierta. */
  expectedCashNow: number;
  byMethod: CashMethodTotal[];
  byKind: { kind: string; total: number }[];
};

export type CashMovement = {
  id: number;
  kind: string;
  method: PaymentMethod;
  amount: number;
  sourceLabel: string | null;
  actorLabel: string | null;
  note: string | null;
  occurredAt: string;
};

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

export const registerExpenseSchema = z.object({
  branchId: z.string().uuid(),
  expenseCategoryId: z.string().uuid(),
  method: paymentMethodSchema,
  amount: z.coerce.number().positive(),
  description: z.string().trim().min(1, "Describe el gasto.").max(300),
  clientOperationId: z.string().uuid(),
  supplierId: z.string().uuid().optional().nullable(),
  payeeName: z.string().trim().max(160).optional().nullable(),
  incurredAt: z.string().date().optional().nullable(),
  document: z.object({
    kind: z.string().optional().nullable(),
    series: z.string().trim().max(10).optional().nullable(),
    number: z.string().trim().max(30).optional().nullable()
  }).optional().nullable(),
  evidencePath: z.string().trim().max(300).optional().nullable(),
  recurrence: z.enum(["one_off", "recurring"]).default("one_off"),
  allocations: z.array(z.object({
    purchaseOrderId: z.string().uuid().optional().nullable(),
    goodsReceiptId: z.string().uuid().optional().nullable(),
    saleId: z.string().uuid().optional().nullable(),
    amount: z.coerce.number().positive()
  })).optional().nullable()
});

export const voidExpenseSchema = z.object({
  reason: z.string().trim().min(1, "Anular un gasto exige un motivo.").max(300)
});

export type ExpenseCategory = {
  id: string;
  code: string;
  name: string;
  scope: "store" | "administrative" | "purchasing";
};

export type Expense = {
  id: string;
  branchId: string;
  category: string;
  categoryCode: string;
  scope: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  incurredAt: string;
  description: string;
  supplierId: string | null;
  payeeName: string | null;
  recurrence: string;
  evidencePath: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  allocations: {
    purchaseOrderId: string | null;
    goodsReceiptId: string | null;
    saleId: string | null;
    amount: number;
  }[];
};

// ---------------------------------------------------------------------------
// Traslados
// ---------------------------------------------------------------------------

export const registerTransferSchema = z.object({
  originBranchId: z.string().uuid(),
  destinationBranchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  reason: z.string().trim().max(300).optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    units: z.coerce.number().int().positive()
  })).min(1).max(200)
}).refine((input) => input.originBranchId !== input.destinationBranchId, {
  path: ["destinationBranchId"],
  message: "El origen y el destino deben ser sedes distintas."
});

export type Transfer = {
  id: string;
  transferNumber: string;
  status: string;
  originBranchId: string;
  destinationBranchId: string;
  requestedAt: string;
  receivedAt: string | null;
  reason: string | null;
  discrepancyNote: string | null;
  lines: {
    variantId: string;
    sku: string | null;
    productName: string | null;
    variantName: string | null;
    requestedUnits: number;
    dispatchedUnits: number | null;
    receivedUnits: number | null;
    differenceUnits: number;
    costBasis: string | null;
  }[];
};

// ---------------------------------------------------------------------------
// Carga inicial
// ---------------------------------------------------------------------------

export const initialLoadRowSchema = z.object({
  sku: z.string().trim().min(1),
  branchCode: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(0),
  /** Ausente significa costo DESCONOCIDO, nunca cero. */
  unitCost: z.coerce.number().min(0).optional().nullable()
});

export const initialLoadSchema = z.object({
  branchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  countedAt: z.string().date().optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
  mode: z.enum(["preview", "commit"]).default("preview"),
  rows: z.array(initialLoadRowSchema).min(1).max(5000)
});

export const revertInitialLoadSchema = z.object({
  reason: z.string().trim().min(1, "Revertir una carga exige un motivo.").max(300)
});

export type InitialLoadPreview = {
  mode: string;
  accepted: number;
  rejected: number;
  committed: boolean;
  issues: { sku: string; issue: string }[];
  rows: { variantId: string; branchId: string; sku: string; quantity: number; unitCost: number | null }[];
};

export type InitialLoadBatch = {
  id: string;
  batchNumber: string;
  branchId: string;
  status: "committed" | "reverted";
  countedAt: string;
  rowCount: number;
  totalUnits: number;
  valuedUnits: number;
  unvaluedUnits: number;
  createdAt: string;
  createdByLabel: string | null;
  revertedAt: string | null;
  revertReason: string | null;
  rows: { variantId: string; sku: string; quantity: number; unitCost: number | null }[];
};

// ---------------------------------------------------------------------------
// Reportes
// ---------------------------------------------------------------------------

export type SaleMargin = {
  saleId: string;
  saleNumber: string;
  branchId: string;
  issuedAt: string;
  revenue: number;
  cost: number | null;
  /** Nulo cuando alguna línea tiene costo desconocido. No es cero. */
  margin: number | null;
  hasUnknownCost: boolean;
  hasMixedCost: boolean;
};

export type LowStockAlert = {
  variantId: string;
  branchId: string;
  branchName: string;
  sku: string | null;
  productName: string;
  variantName: string;
  onHand: number;
  reserved: number;
  available: number;
};

export const CASH_MOVEMENT_LABELS: Record<string, string> = {
  opening_float: "Fondo de apertura",
  sale: "Venta",
  reservation_advance: "Adelanto de reserva",
  refund: "Reembolso",
  supplier_payment: "Pago a proveedor",
  expense: "Gasto",
  withdrawal: "Retiro",
  manual_income: "Ingreso manual"
};

export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  initial_load: "Carga inicial",
  sale: "Venta",
  sale_cancelled: "Anulación de venta",
  return_restock: "Devolución",
  receipt: "Recepción",
  adjustment: "Ajuste",
  transfer_in: "Traslado recibido",
  transfer_out: "Traslado enviado"
};

export const EXPENSE_SCOPE_LABELS: Record<string, string> = {
  store: "Tienda",
  administrative: "Administrativo",
  purchasing: "Compras"
};
