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

/** Cómo nació la venta. No es su origen de captación: una venta de mostrador
 *  puede venir de Instagram si la clienta llegó por un anuncio y pagó en tienda. */
export const saleEntryModeSchema = z.enum([
  "store_quick", "conversation", "reservation", "public_cart"
]);

// `delivery` se partió en 0052: el reparto propio en Lima y el envío por agencia
// a provincia tienen costo, plazo y responsabilidad distintos.
export const fulfillmentMethodSchema = z.enum(["in_store", "pickup", "local_delivery", "shipping"]);

export const paymentMethodSchema = z.enum([
  "cash", "yape", "plin", "transfer", "card", "reservation_advance", "store_credit", "other"
]);

/**
 * Medios que no se registran sin su número de operación.
 *
 * Es el gemelo de `payment_requires_reference` en PostgreSQL (0065), que es la
 * que de verdad manda: la aplican por igual la restricción de `sale_payments` y
 * la de `reservation_payments`. Esta copia existe para poder decirlo ANTES —con
 * la clienta delante, fallar al confirmar es fallar tarde— y una prueba fija
 * que las dos listas coincidan.
 *
 * El efectivo no lleva porque no existe. `store_credit` y `other` quedan fuera a
 * propósito: exigir un código que no existe empuja a inventarlo, y un dato
 * inventado es peor que un dato ausente.
 */
export const PAYMENT_METHODS_REQUIRING_OPERATION_NUMBER = [
  "yape", "plin", "transfer", "card"
] as const satisfies readonly PaymentMethodName[];

type PaymentMethodName = z.infer<typeof paymentMethodSchema>;

export function requiresOperationNumber(method: PaymentMethodName): boolean {
  return (PAYMENT_METHODS_REQUIRING_OPERATION_NUMBER as readonly string[]).includes(method);
}

/**
 * Cómo se llama ese campo en pantalla. UN nombre, no dos: hasta 0065 el mismo
 * dato se pedía como «N.º de operación» con un medio y como «Referencia» con
 * otro, y en pago dividido se llamaba «Referencia» incluso cuando era
 * obligatorio — que es la peor de las tres, porque el nombre decía opcional y la
 * base lo rechazaba.
 */
export function paymentReferenceLabel(method: PaymentMethodName): string {
  return requiresOperationNumber(method) ? "N.º de operación" : "Referencia (opcional)";
}

// Las TRES respuestas a «¿qué documento lleva?». `sales_note` no es un
// comprobante fiscal: registra que la clienta no pidió ninguno, que es un dato
// distinto de no haberle preguntado.
export const taxDocumentKindSchema = z.enum(["sales_note", "sales_receipt", "invoice"]);

/**
 * CUÁNDO se cobra una venta, no si vale (0063). Una venta contra entrega está
 * tan confirmada como cualquier otra —se despachó—; lo que le falta es dinero.
 */
export const salePaymentTermsSchema = z.enum(["immediate", "on_delivery"]);

/**
 * Los roles OPERATIVOS de una venta (0060): los que hacen falta para cumplir la
 * entrega. La compradora no está aquí —es una identidad, no un contacto de esta
 * entrega— y el receptor fiscal tampoco: vive en `tax_document_requests` con su
 * propio ciclo.
 */
export const salePartyRoleSchema = z.enum(["recipient", "pickup_authorized"]);

export const salePartySchema = z.object({
  role: salePartyRoleSchema,
  /** El rol lo cumple la propia compradora. No se deduce comparando nombres:
   *  dos «Rosa Díaz» no son la misma persona. */
  isBuyer: z.boolean().default(false),
  personId: z.string().uuid().optional().nullable(),
  fullName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  documentNumber: z.string().trim().max(20).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable()
});

export const registerSaleSchema = z.object({
  branchId: z.string().uuid(),
  // Identificador que hace idempotente la operación: un botón pulsado dos veces
  // devuelve la venta ya creada en lugar de duplicarla.
  clientOperationId: z.string().uuid(),
  // OBSOLETO (0052): mezclaba origen de captación, canal de atención y forma de
  // cierre en un solo valor, así que «llegó por Instagram y se atendió por
  // WhatsApp» era inexpresable. Se mantiene porque la columna sigue existiendo;
  // no lo mande código nuevo.
  sourceChannel: saleSourceChannelSchema.default("in_store"),
  sourceReference: z.string().trim().max(200).optional().nullable(),
  fulfillmentMethod: fulfillmentMethodSchema.default("in_store"),
  // Cómo nació la venta: lo ÚNICO que el cliente aporta sobre el origen. El
  // resto lo deduce PostgreSQL de la conversación o la reserva.
  entryMode: saleEntryModeSchema.default("store_quick"),
  conversationId: z.string().uuid().optional().nullable(),
  // Clienta identificada, si la hay. Null es lo normal en mostrador.
  personId: z.string().uuid().optional().nullable(),
  // Instantánea de la COMPRADORA tal como se escribió al vender: es lo que
  // imprime la nota. No son los datos de la entrega.
  customer: z.object({
    name: z.string().trim().max(120).optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
    document: z.string().trim().max(20).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable()
  }).optional().nullable(),
  // Quién recibe y quién está autorizado a recoger. Como mucho uno de cada:
  // dos destinatarios son dos entregas, y eso es otro modelo.
  parties: z.array(salePartySchema).max(2).optional().default([]),
  // Contra entrega: los pagos que se manden son el ADELANTO, no el total. Qué
  // métodos lo admiten y si exigen adelanto lo dice `fulfillment_requirements`,
  // y lo verifica PostgreSQL: aquí no se decide nada de eso.
  paymentTerms: salePaymentTermsSchema.default("immediate"),
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
  assertOperationNumbers(input.payments, ctx, ["payments"]);
});

/**
 * La misma regla en el borde de la API. No sustituye a la de PostgreSQL —esa es
 * la que manda y alcanza a cualquier camino—, pero convierte un error crudo de
 * restricción en un mensaje que dice qué falta y en cuál de los pagos.
 */
function assertOperationNumbers(
  payments: Array<{ method: PaymentMethodName; reference?: string | null }>,
  ctx: z.RefinementCtx,
  path: (string | number)[]
) {
  payments.forEach((payment, index) => {
    if (!requiresOperationNumber(payment.method)) return;
    if ((payment.reference ?? "").trim() !== "") return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, index, "reference"],
      message: `${PAYMENT_METHOD_LABELS[payment.method]} no se registra sin su N.º de operación.`
    });
  });
}

export const createReservationSchema = z.object({
  branchId: z.string().uuid(),
  clientOperationId: z.string().uuid(),
  // Una clienta que reserva es, por definición, una clienta que vuelve: perder
  // aquí el enlace parte su historial en dos nombres iguales.
  personId: z.string().uuid().optional().nullable(),
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
}).superRefine((input, ctx) => {
  // El adelanto es dinero que entra igual que un cobro, y desde 0065 la base lo
  // exige igual. Un Yape sin código en una reserva era el hueco por el que se
  // colaba justo lo que la regla vino a impedir.
  if (input.advance) assertOperationNumbers([input.advance], ctx, ["advance"]);
});

/**
 * DÓNDE está el pedido (0064). No es ni si la venta vale —`status`— ni si está
 * cobrada —el saldo—. Las tres son independientes: hay pedidos entregados sin
 * cobrar y pedidos cobrados sin entregar, y ninguno de los dos es un error.
 */
export const saleFulfillmentStatusSchema = z.enum([
  "pending", "ready", "dispatched", "delivered", "failed"
]);

export const markFulfillmentSchema = z.object({
  status: saleFulfillmentStatusSchema,
  note: z.string().trim().max(300).optional().nullable()
});

/** Cobrar el saldo de una venta contra entrega, cuando la clienta lo recibe. */
export const settleSaleBalanceSchema = z.object({
  // Hace idempotente el cobro: un botón pulsado dos veces devuelve lo ya
  // cobrado en lugar de cobrarlo otra vez.
  clientOperationId: z.string().uuid(),
  payments: z.array(z.object({
    method: paymentMethodSchema,
    amount: z.coerce.number().positive(),
    tenderedAmount: z.coerce.number().positive().optional().nullable(),
    reference: z.string().trim().max(120).optional().nullable(),
    evidencePath: z.string().trim().max(300).optional().nullable(),
    receivedAt: z.string().datetime().optional().nullable()
  })).min(1, "Indica con qué se cobra el saldo.").max(10)
}).superRefine((input, ctx) => {
  assertOperationNumbers(input.payments, ctx, ["payments"]);
});

export const releaseReservationSchema = z.object({
  reason: z.string().trim().min(1, "Indica el motivo de la liberación.").max(300),
  status: z.enum(["released", "cancelled"]).default("released")
});

export const requestTaxDocumentSchema = z.object({
  kind: taxDocumentKindSchema,
  // Los datos del receptor son SUYOS. La pantalla puede ofrecer copiar los de la
  // clienta —la mayoría de boletas van a su nombre— pero eso es un gesto de
  // quien vende, no un relleno automático: una factura a nombre de la empresa
  // donde trabaja lleva un RUC que no es de nadie que aparezca en la venta.
  receiver: z.object({
    taxId: z.string().trim().max(20).optional().nullable(),
    name: z.string().trim().max(200).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable()
  }).optional().nullable()
});

/**
 * Qué exige cada comprobante. NO se declara aquí: son las filas de
 * `tax_document_requirements`, que es la misma tabla que consulta la base para
 * rechazar una solicitud incompleta. Son reglas de un tercero —la SUNAT— y por
 * eso viven como dato: cuando cambie el umbral de la boleta, cambia una fila.
 */
export type TaxDocumentRequirement = {
  kind: TaxDocumentKind;
  /** «RUC» o «DNI». Pedir el nombre equivocado hace que se teclee lo que no es. */
  taxIdLabel: string;
  taxIdPattern: string;
  /** Importe desde el que el identificador es obligatorio. 0 = siempre;
   *  null = nunca. */
  taxIdRequiredFrom: number | null;
  requiresName: boolean;
  requiresAddress: boolean;
  hint: string | null;
  /** En qué orden se ofrecen. La nota va primero: es la respuesta normal. */
  sortOrder: number;
};

export const TAX_DOCUMENT_LABELS: Record<TaxDocumentKind, string> = {
  sales_note: "Nota de venta",
  sales_receipt: "Boleta",
  invoice: "Factura"
};

/**
 * Qué le falta a una solicitud de comprobante, o null si está completa. Gemelo
 * en pantalla de `tax_document_problem`: mismos mensajes, y depende del IMPORTE
 * porque una de las reglas lo hace —la misma boleta es válida sin DNI por S/ 300
 * e inválida sin él por S/ 800—.
 */
export function taxDocumentProblem(input: {
  requirement: TaxDocumentRequirement | null | undefined;
  total: number;
  receiver: { taxId?: string | null; name?: string | null; address?: string | null };
}): string | null {
  const { requirement, total, receiver } = input;
  if (!requirement) return "Ese comprobante no se emite aquí: la nota de venta cubre el resto.";

  const taxId = (receiver.taxId ?? "").trim();
  const name = (receiver.name ?? "").trim();
  const address = (receiver.address ?? "").trim();

  const exigido = requirement.taxIdRequiredFrom !== null && total >= requirement.taxIdRequiredFrom;
  if (exigido && taxId === "") return `Falta el ${requirement.taxIdLabel} de quien recibe el comprobante.`;
  // Si lo dan, tiene que ser válido: un RUC de nueve dígitos no lo rechaza la
  // pantalla, lo rechaza la SUNAT tres días después.
  if (taxId !== "" && !new RegExp(requirement.taxIdPattern).test(taxId)) {
    return `El ${requirement.taxIdLabel} no tiene el formato correcto.`;
  }
  if (requirement.requiresName && name === "") return "Falta el nombre o la razón social a la que va el comprobante.";
  if (requirement.requiresAddress && address === "") return "Falta la dirección fiscal.";
  return null;
}

export type SaleSourceChannel = z.infer<typeof saleSourceChannelSchema>;
export type FulfillmentMethod = z.infer<typeof fulfillmentMethodSchema>;
export type SalePartyRole = z.infer<typeof salePartyRoleSchema>;
export type SalePartyInput = z.infer<typeof salePartySchema>;
export type SalePaymentTerms = z.infer<typeof salePaymentTermsSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type TaxDocumentKind = z.infer<typeof taxDocumentKindSchema>;
export type RegisterSaleInput = z.infer<typeof registerSaleSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type SettleSaleBalanceInput = z.infer<typeof settleSaleBalanceSchema>;
export type SaleFulfillmentStatus = z.infer<typeof saleFulfillmentStatusSchema>;
export type MarkFulfillmentInput = z.infer<typeof markFulfillmentSchema>;

/**
 * Una fila de la hoja de pendientes. Las dos banderas son INDEPENDIENTES —una
 * fila puede necesitar las dos cosas— y las decide PostgreSQL: la pantalla no
 * vuelve a restar pagos contra el total para averiguar si falta cobrar.
 */
export type PendingSale = {
  kind: "sale";
  id: string;
  number: string;
  happenedAt: string;
  branchId: string;
  customerName: string | null;
  customerPhone: string | null;
  fulfillmentMethod: FulfillmentMethod;
  fulfillmentStatus: SaleFulfillmentStatus;
  paymentTerms: SalePaymentTerms;
  total: number;
  paidTotal: number;
  balance: number;
  needsDelivery: boolean;
  needsPayment: boolean;
};

export type PendingReservation = {
  kind: "reservation";
  id: string;
  number: string;
  happenedAt: string;
  branchId: string;
  customerName: string | null;
  customerPhone: string | null;
  total: number;
  paidTotal: number;
  balance: number;
  expiresAt: string;
};

export type PendingOperations = {
  sales: PendingSale[];
  reservations: PendingReservation[];
};

/** Qué se dice de un pedido según dónde está. */
export const FULFILLMENT_STATUS_LABELS: Record<SaleFulfillmentStatus, string> = {
  pending: "Por preparar",
  ready: "Preparado",
  dispatched: "En camino",
  delivered: "Entregado",
  failed: "No se pudo entregar"
};

/** El siguiente paso de la entrega, o null si ya no hay ninguno. */
export function nextFulfillmentStep(
  status: SaleFulfillmentStatus,
  method: FulfillmentMethod
): { status: SaleFulfillmentStatus; label: string } | null {
  if (status === "delivered") return null;
  // Desde un intento fallido se REINTENTA hacia adelante: se vuelve a preparar
  // y a salir. No se «limpia» el fallo, se supera — y así queda registrado que
  // hubo un intento previo.
  if (status === "failed") {
    return method === "pickup"
      ? { status: "ready", label: "Volver a intentar" }
      : { status: "dispatched", label: "Volver a intentar" };
  }
  // En recojo no hay despacho: la clienta viene y se lo lleva. Ofrecer «marcar
  // en camino» para un recojo sería inventarle un paso que no ocurre.
  if (method === "pickup") {
    return status === "ready"
      ? { status: "delivered", label: "Entregado" }
      : { status: "ready", label: "Listo para recojo" };
  }
  if (status === "pending") return { status: "ready", label: "Preparado" };
  if (status === "ready") return { status: "dispatched", label: "Marcar en camino" };
  return { status: "delivered", label: "Entregado" };
}

/**
 * Si tiene sentido ofrecer «no se pudo entregar». Solo cuando el pedido ya salió
 * o está listo: marcar como fallida una entrega que nadie ha intentado todavía
 * no describe nada.
 */
export function canFailDelivery(status: SaleFulfillmentStatus): boolean {
  return status === "ready" || status === "dispatched";
}

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

/**
 * Un rol tal como lo devuelve `sale_detail`, con los datos ya RESUELTOS: si el
 * rol lo cumple la compradora y no se repitió nada, aquí llegan sus datos sin
 * que nadie los haya copiado a la entrega.
 */
export type SaleParty = {
  role: SalePartyRole;
  isBuyer: boolean;
  personId: string | null;
  fullName: string | null;
  phone: string | null;
  documentNumber: string | null;
  address: string | null;
  notes: string | null;
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
  /** Instantánea del documento de la COMPRADORA. No es el del comprobante ni el
   *  de quien recibe: son tres personas distintas que pueden coincidir. */
  customerDocument?: string | null;
  deliveryAddress?: string | null;
  parties?: SaleParty[];
  paymentTerms?: SalePaymentTerms;
  /** Derivados de los pagos: no hay columna «saldo» que pueda desfasarse. */
  paidTotal?: number;
  balance?: number;
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
  personId?: string | null;
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
  local_delivery: "Delivery",
  shipping: "Envío a provincia"
};

/**
 * Qué exige cada método de entrega. NO se declara aquí: son las filas de
 * `fulfillment_requirements`, la misma tabla que lee el disparador que impide
 * cerrar una venta incompleta. Si la dueña cambia una fila, cambian a la vez lo
 * que la pantalla pide y lo que la base admite — no hay dos sitios que puedan
 * discrepar.
 */
export type FulfillmentRequirement = {
  method: FulfillmentMethod;
  requiresRecipient: boolean;
  requiresPhone: boolean;
  requiresAddress: boolean;
  requiresDocument: boolean;
  /** Si admite cobrar el saldo al entregar. En mostrador y recojo, no. */
  allowsOnDelivery: boolean;
  requiresAdvance: boolean;
  /**
   * Porcentaje mínimo a adelantar. `null` significa «no se fija cuánto», que NO
   * es cero: con `requiresAdvance` y `null` basta cualquier importe mayor que
   * cero. Cero significaría que se admite no adelantar nada.
   */
  minAdvancePercent: number | null;
  hint: string | null;
};

/** Recojo acredita a QUIEN RETIRA; los demás métodos, a quien recibe. */
export function roleForMethod(method: FulfillmentMethod): SalePartyRole {
  return method === "pickup" ? "pickup_authorized" : "recipient";
}

export type FulfillmentGap = "recipient" | "phone" | "address" | "document";

/** Se nombra lo que falta, nunca dónde falta. Quien cobra necesita saber qué
 *  preguntarle a la clienta. */
export const FULFILLMENT_GAP_LABELS: Record<FulfillmentGap, string> = {
  recipient: "a quién se le entrega",
  phone: "un teléfono de contacto",
  address: "la dirección",
  document: "el documento del destinatario"
};

function limpio(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Qué le falta a la venta para poder entregarse. Es el gemelo en pantalla de
 * `sale_fulfillment_gaps`: mismos huecos, mismo orden y la misma caída a los
 * datos de la compradora cuando el rol lo cumple ella.
 *
 * Existe para PEDIRLO ANTES. La base lo impide después, y esa es la que manda:
 * ninguna pantalla futura, script ni asistente puede saltársela.
 */
export function fulfillmentGaps(input: {
  requirement: FulfillmentRequirement | null | undefined;
  party: Partial<SalePartyInput> | null | undefined;
  /** La compradora tal como se escribió en la venta. */
  buyer: { name?: string | null; phone?: string | null; document?: string | null; address?: string | null };
}): FulfillmentGap[] {
  const { requirement, party, buyer } = input;
  if (!requirement) return [];

  const desdeCompradora = party?.isBuyer === true;
  const nombre = limpio(party?.fullName) ?? (desdeCompradora ? limpio(buyer.name) : null);
  const telefono = limpio(party?.phone) ?? (desdeCompradora ? limpio(buyer.phone) : null);
  const documento = limpio(party?.documentNumber) ?? (desdeCompradora ? limpio(buyer.document) : null);
  // La dirección es de la ENTREGA, nunca de la ficha de nadie: una persona puede
  // pedir a su casa hoy y a su trabajo mañana.
  const direccion = limpio(party?.address) ?? limpio(buyer.address);

  const gaps: FulfillmentGap[] = [];
  if (requirement.requiresRecipient && !nombre) gaps.push("recipient");
  if (requirement.requiresPhone && !telefono) gaps.push("phone");
  if (requirement.requiresDocument && !documento) gaps.push("document");
  if (requirement.requiresAddress && !direccion) gaps.push("address");
  return gaps;
}

/** «Para entregar esta venta falta A, B y C.» — la misma frase que devuelve la
 *  base, para que quien vende no lea dos redacciones distintas del mismo aviso. */
export function fulfillmentGapMessage(gaps: FulfillmentGap[]): string | null {
  if (gaps.length === 0) return null;
  const partes = gaps.map((gap) => FULFILLMENT_GAP_LABELS[gap]);
  const texto = partes.length === 1
    ? partes[0]
    : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
  return `Para entregar esta venta falta ${texto}.`;
}
