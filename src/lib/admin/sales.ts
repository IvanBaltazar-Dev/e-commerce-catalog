import { z } from "zod";
import type { AvailabilityStatus, PurchaseMode } from "@/lib/catalog/contracts";

/**
 * Contratos de la venta. Sustituyen a `lib/admin/orders.ts`: `orders` se retiró
 * en 0029 porque tenía cero filas, nunca llegó a producción y dejaba dos
 * conceptos de venta conviviendo.
 *
 * Ningún importe se calcula aquí. Precio, modalidad mayorista, descuento
 * prorrateado, costo y totales los resuelve `register_sale` en PostgreSQL.
 */

export const saleSourceChannelSchema = z.enum([
  "in_store", "web", "whatsapp", "facebook", "instagram", "tiktok", "phone", "other"
]);

export const fulfillmentMethodSchema = z.enum(["in_store", "pickup", "delivery"]);

export const paymentMethodSchema = z.enum([
  "cash", "yape", "plin", "transfer", "card", "reservation_advance", "store_credit", "other"
]);

export const taxDocumentKindSchema = z.enum(["invoice", "sales_receipt"]);

export const registerSaleSchema = z.object({
  branchId: z.string().uuid(),
  // Identificador que hace idempotente la operación: un botón pulsado dos veces
  // devuelve la venta ya creada en lugar de duplicarla.
  clientOperationId: z.string().uuid(),
  sourceChannel: saleSourceChannelSchema.default("in_store"),
  sourceReference: z.string().trim().max(200).optional().nullable(),
  fulfillmentMethod: fulfillmentMethodSchema.default("in_store"),
  customer: z.object({
    name: z.string().trim().max(120).optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
    document: z.string().trim().max(20).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable()
  }).optional().nullable(),
  // Descuento sobre el total. PostgreSQL lo prorratea entre las líneas de forma
  // determinista: las líneas son la única fuente de verdad del descuento.
  discountTotal: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(500).optional().nullable(),
  reservationId: z.string().uuid().optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(999)
  })).min(1).max(50),
  payments: z.array(z.object({
    method: paymentMethodSchema,
    amount: z.coerce.number().positive(),
    // Efectivo entregado por el cliente. El vuelto es la diferencia y no se
    // guarda como pago negativo.
    tenderedAmount: z.coerce.number().positive().optional().nullable(),
    reference: z.string().trim().max(120).optional().nullable(),
    evidencePath: z.string().trim().max(300).optional().nullable(),
    receivedAt: z.string().datetime().optional().nullable()
  })).max(10)
}).superRefine((input, ctx) => {
  // Una venta que nace de una reserva puede quedar cubierta por completo con el
  // adelanto ya recibido: ahí la lista de pagos nuevos es legítimamente vacía.
  if (!input.reservationId && input.payments.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payments"],
      message: "Registra al menos un pago: la venta se confirma completamente pagada."
    });
  }
});

export const createReservationSchema = z.object({
  branchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  customer: z.object({
    name: z.string().trim().min(1, "Una reserva exige el nombre del cliente.").max(120),
    phone: z.string().trim().max(30).optional().nullable(),
    document: z.string().trim().max(20).optional().nullable()
  }),
  expiresAt: z.string().datetime(),
  notes: z.string().trim().max(500).optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(999)
  })).min(1).max(50),
  advance: z.object({
    method: paymentMethodSchema,
    amount: z.coerce.number().positive(),
    tenderedAmount: z.coerce.number().positive().optional().nullable(),
    reference: z.string().trim().max(120).optional().nullable(),
    evidencePath: z.string().trim().max(300).optional().nullable(),
    receivedAt: z.string().datetime().optional().nullable()
  }).optional().nullable()
});

export const releaseReservationSchema = z.object({
  reason: z.string().trim().min(1, "Indica el motivo de la liberación.").max(300),
  status: z.enum(["released", "cancelled"]).default("released")
});

export const requestTaxDocumentSchema = z.object({
  kind: taxDocumentKindSchema,
  receiver: z.object({
    taxId: z.string().trim().max(20).optional().nullable(),
    name: z.string().trim().max(200).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable()
  }).optional().nullable()
});

export type SaleSourceChannel = z.infer<typeof saleSourceChannelSchema>;
export type FulfillmentMethod = z.infer<typeof fulfillmentMethodSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type TaxDocumentKind = z.infer<typeof taxDocumentKindSchema>;
export type RegisterSaleInput = z.infer<typeof registerSaleSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

/** Base del costo de una línea. `unknown` significa margen NO calculable, nunca cero. */
export type CostBasis = "weighted_average" | "unknown" | "mixed";

export type SaleLineCost = {
  unitCost: number | null;
  totalCost: number | null;
  costBasis: CostBasis;
  valuedUnits: number;
  unvaluedUnits: number;
};

export type SaleLine = {
  id: string;
  variantId: string;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  subtotal: number;
  purchaseMode: PurchaseMode;
  /** Nulo para la vendedora: la RLS de `sale_line_costs` no le devuelve filas. */
  cost: SaleLineCost | null;
};

export type SalePayment = {
  id: string;
  method: PaymentMethod;
  amount: number;
  tenderedAmount: number | null;
  change: number | null;
  reference: string | null;
  receivedAt: string;
  appliedAt: string;
  fromReservation: boolean;
};

export type Sale = {
  id: string;
  saleNumber: string;
  branchId: string;
  status: "confirmed" | "cancelled";
  sourceChannel: SaleSourceChannel;
  fulfillmentMethod: FulfillmentMethod;
  customerName: string | null;
  customerPhone: string | null;
  grossSubtotal: number;
  discountTotal: number;
  total: number;
  currency: string;
  reservationId: string | null;
  sellerLabel: string | null;
  issuedAt: string;
  lines: SaleLine[];
  payments: SalePayment[];
  taxDocument: { kind: TaxDocumentKind; status: string; requestedAt: string } | null;
};

export type ReservationLine = {
  variantId: string;
  sku: string | null;
  productName: string | null;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
};

export type Reservation = {
  id: string;
  reservationNumber: string;
  branchId: string;
  status: "active" | "expired" | "released" | "converted" | "cancelled";
  customerName: string;
  customerPhone: string | null;
  expiresAt: string;
  total: number;
  advanceTotal: number;
  balance: number;
  lines: ReservationLine[];
  payments: { id: string; method: PaymentMethod; amount: number; receivedAt: string }[];
};

export type SaleVariantOption = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  productName: string;
  brandName: string;
  availability: AvailabilityStatus;
  unitPrice: number | null;
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  yape: "Yape",
  plin: "Plin",
  transfer: "Transferencia",
  card: "Tarjeta",
  reservation_advance: "Adelanto de reserva",
  store_credit: "Saldo a favor",
  other: "Otro medio"
};

export const SOURCE_CHANNEL_LABELS: Record<SaleSourceChannel, string> = {
  in_store: "Tienda",
  web: "Web",
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  phone: "Teléfono",
  other: "Otro canal"
};

export const FULFILLMENT_LABELS: Record<FulfillmentMethod, string> = {
  in_store: "Entrega en tienda",
  pickup: "Recojo",
  delivery: "Delivery"
};
