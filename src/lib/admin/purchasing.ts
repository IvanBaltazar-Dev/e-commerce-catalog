import { z } from "zod";
import { paymentMethodSchema, type PaymentMethod } from "@/lib/admin/sales";

/**
 * Contratos del abastecimiento. Ningún costo, deuda ni promedio se calcula
 * aquí: todo sale de `issue_purchase_order`, `register_goods_receipt`,
 * `register_supplier_payment` y las vistas derivadas de 0030.
 */

export const purchaseTermsSchema = z.enum(["cash", "credit"]);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Usa un código de tres letras.");

// ---------------------------------------------------------------------------
// Orden de compra
// ---------------------------------------------------------------------------

export const issuePurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  currency: currencySchema.optional().nullable(),
  terms: purchaseTermsSchema.default("cash"),
  paymentTermsDays: z.coerce.number().int().min(0).optional().nullable(),
  expectedAt: z.string().date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    orderedUnits: z.coerce.number().int().positive(),
    /** Ausente: se toma el acuerdo de costo vigente del proveedor. */
    unitCost: z.coerce.number().min(0).optional().nullable(),
    discountAmount: z.coerce.number().min(0).optional().nullable(),
    notes: z.string().trim().max(200).optional().nullable()
  })).min(1).max(200)
});

export type PurchaseOrderLine = {
  id: string;
  variantId: string;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  supplierSku: string | null;
  purchaseUnitLabel: string | null;
  packUnits: number;
  orderedUnits: number;
  unitCost: number;
  discountAmount: number;
  subtotal: number;
  receivedUnits: number;
};

export type PurchaseOrder = {
  id: string;
  orderNumber: string;
  status: "draft" | "sent" | "partially_received" | "received" | "cancelled";
  supplierId: string;
  supplierName: string;
  branchId: string;
  terms: "cash" | "credit";
  currency: string;
  expectedAt: string | null;
  grossTotal: number;
  discountTotal: number;
  total: number;
  createdAt: string;
  lines: PurchaseOrderLine[];
};

// ---------------------------------------------------------------------------
// Recepción
// ---------------------------------------------------------------------------

export const bonusValuationSchema = z.enum(["same_variant", "unvalued", "declared"]);

export const registerGoodsReceiptSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional().nullable(),
  currency: currencySchema.default("PEN"),
  /** Obligatorio si la moneda no es PEN: sin él el costo en soles es indeterminado. */
  exchangeRate: z.coerce.number().positive().optional().nullable(),
  terms: purchaseTermsSchema.default("cash"),
  notes: z.string().trim().max(500).optional().nullable(),
  supplierDocument: z.object({
    kind: z.string().optional().nullable(),
    series: z.string().trim().max(10).optional().nullable(),
    number: z.string().trim().max(30),
    issuedAt: z.string().date().optional().nullable(),
    dueDate: z.string().date().optional().nullable(),
    total: z.coerce.number().positive()
  }).optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    purchaseOrderLineId: z.string().uuid().optional().nullable(),
    expectedUnits: z.coerce.number().int().min(0).optional().nullable(),
    receivedUnits: z.coerce.number().int().min(0).default(0),
    bonusUnits: z.coerce.number().int().min(0).default(0),
    bonusValuation: bonusValuationSchema.default("same_variant"),
    bonusDeclaredUnitCost: z.coerce.number().min(0).optional().nullable(),
    damagedUnits: z.coerce.number().int().min(0).default(0),
    unitCost: z.coerce.number().min(0).default(0),
    discountAmount: z.coerce.number().min(0).optional().nullable(),
    notes: z.string().trim().max(200).optional().nullable()
  })).min(1).max(200)
}).superRefine((input, ctx) => {
  if (input.currency !== "PEN" && !input.exchangeRate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exchangeRate"],
      message: "Una recepción en moneda extranjera exige su tipo de cambio."
    });
  }

  input.lines.forEach((line, index) => {
    if (line.receivedUnits + line.bonusUnits + line.damagedUnits === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines", index, "receivedUnits"],
        message: "Indica cuántas unidades llegaron."
      });
    }

    if (line.bonusValuation === "declared" && !line.bonusDeclaredUnitCost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines", index, "bonusDeclaredUnitCost"],
        message: "Declara el valor unitario de la bonificación."
      });
    }
  });
});

export type GoodsReceiptLine = {
  variantId: string;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  expectedUnits: number | null;
  receivedUnits: number;
  bonusUnits: number;
  bonusValuation: "same_variant" | "unvalued" | "declared";
  damagedUnits: number;
  /** Derivados de esperado contra recibido, no columnas. */
  missingUnits: number | null;
  surplusUnits: number | null;
  unitCost: number;
  unitCostPen: number;
};

export type GoodsReceipt = {
  id: string;
  receiptNumber: string;
  status: "draft" | "confirmed" | "cancelled";
  supplierId: string;
  supplierName: string;
  branchId: string;
  purchaseOrderId: string | null;
  currency: string;
  exchangeRate: number | null;
  receivedAt: string;
  goodsTotalPen: number;
  discrepancyNote: string | null;
  lines: GoodsReceiptLine[];
};

// ---------------------------------------------------------------------------
// Deuda y pagos
// ---------------------------------------------------------------------------

export const registerSupplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid(),
  method: paymentMethodSchema,
  amount: z.coerce.number().positive(),
  clientOperationId: z.string().uuid(),
  currency: currencySchema.default("PEN"),
  reference: z.string().trim().max(120).optional().nullable(),
  evidencePath: z.string().trim().max(300).optional().nullable(),
  paidAt: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
  /** Sin asignaciones el pago queda como anticipo a favor del negocio. */
  allocations: z.array(z.object({
    obligationId: z.string().uuid(),
    amount: z.coerce.number().positive()
  })).optional().nullable()
});

/** Saldo por proveedor y MONEDA. Nunca se suman soles con dólares. */
export type SupplierBalance = {
  supplierId: string;
  supplierName: string;
  currency: string;
  totalDue: number;
  totalPaid: number;
  balance: number;
  nextDueDate: string | null;
};

export type SupplierObligation = {
  id: string;
  supplierId: string;
  currency: string;
  amountDue: number;
  allocated: number;
  pending: number;
  dueDate: string | null;
  goodsReceiptId: string | null;
};

export type SupplierPayment = {
  id: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  paidAt: string;
  reference: string | null;
  allocated: number;
  unallocated: number;
  allocations: { obligationId: string; amount: number; dueDate: string | null }[];
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseOrder["status"], string> = {
  draft: "Borrador",
  sent: "Enviada",
  partially_received: "Recibida parcialmente",
  received: "Recibida",
  cancelled: "Anulada"
};

export const BONUS_VALUATION_LABELS: Record<GoodsReceiptLine["bonusValuation"], string> = {
  same_variant: "Del mismo artículo — baja el costo efectivo",
  unvalued: "De otro artículo, sin valor conocido",
  declared: "De otro artículo, con valor declarado"
};
