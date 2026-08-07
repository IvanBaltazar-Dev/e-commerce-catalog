import { z } from "zod";

/**
 * Contratos del panel omnicanal (Bloque 3). Ningún importe se calcula aquí:
 * los valores de carrito salen de evaluate_cart_v2 vía public_cart_detail y el
 * dinero de métricas sale de sales (Bloque 2).
 */

export type ConversationStatus = "open" | "pending" | "closed" | "archived";
export type MessageDirection = "inbound" | "outbound";
export type MessageDeliveryStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type CartStatus = "active" | "abandoned" | "converted" | "expired" | "cancelled";

export type ConversationSummary = {
  id: string;
  channelCode: string;
  channelAccountName: string;
  branchId: string;
  status: ConversationStatus;
  contactName: string | null;
  contactPhone: string | null;
  assignedUserId: string | null;
  assignedUserLabel: string | null;
  lastActivityAt: string;
  openedAt: string;
  /** Contexto comercial resumido para la bandeja. */
  activeCartId: string | null;
  linkedSaleId: string | null;
  linkedReservationId: string | null;
};

export type ConversationMessage = {
  id: string;
  direction: MessageDirection;
  messageType: string;
  body: string | null;
  status: MessageDeliveryStatus;
  sentByLabel: string | null;
  receivedAt: string;
};

export type ConversationEvent = {
  id: number;
  eventType: string;
  sourceLabel: string | null;
  actorLabel: string | null;
  occurredAt: string;
};

export type ConversationDetail = {
  conversation: ConversationSummary;
  contact: {
    id: string;
    displayName: string | null;
    phone: string | null;
    username: string | null;
    personId: string | null;
    personName: string | null;
  };
  messages: ConversationMessage[];
  events: ConversationEvent[];
  cart: {
    id: string;
    publicToken: string;
    status: CartStatus;
    totalUnits: number;
    subtotal: number | null;
    lines: { sku: string | null; productName: string | null; variantName: string | null; quantity: number; subtotal: number | null }[];
  } | null;
  sale: { id: string; saleNumber: string; total: number; status: string } | null;
  reservation: { id: string; reservationNumber: string; total: number; status: string } | null;
};

export const conversationActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    body: z.string().trim().min(1, "Escribe el mensaje.").max(4000)
  }),
  z.object({
    action: z.literal("close"),
    reason: z.string().trim().min(1, "Indica el motivo.").max(300)
  }),
  z.object({ action: z.literal("claim") }),
  z.object({
    action: z.literal("assign"),
    userId: z.string().uuid().nullable(),
    reason: z.string().trim().min(1, "Indica el motivo.").max(300)
  })
]);

export type ConversationAction = z.infer<typeof conversationActionSchema>;

export type AdminCartSummary = {
  id: string;
  publicToken: string;
  status: CartStatus;
  channelCode: string | null;
  branchId: string;
  assignedUserLabel: string | null;
  conversationId: string | null;
  convertedSaleId: string | null;
  itemCount: number;
  totalUnits: number;
  /** Valor ACTUAL reevaluado por la base; nulo si alguna línea no resuelve. */
  subtotal: number | null;
  campaignCode: string | null;
  lastActivityAt: string;
  createdAt: string;
};

export type ChannelInfo = {
  id: string;
  code: string;
  name: string;
  channelType: string;
  isActive: boolean;
  supportsMessages: boolean;
  supportsCart: boolean;
  accounts: {
    id: string;
    displayName: string;
    externalAccountId: string | null;
    branchId: string | null;
    isActive: boolean;
  }[];
};

export const createChannelAccountSchema = z.object({
  channelId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(120),
  externalAccountId: z.string().trim().min(1).max(120),
  branchId: z.string().uuid().optional().nullable()
});

export type CampaignInfo = {
  id: string;
  name: string;
  code: string;
  sourceCode: string | null;
  channelCode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
};

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().regex(/^[a-z0-9-]{2,60}$/, "Solo minúsculas, números y guiones."),
  sourceCode: z.string().trim().max(30).optional().nullable(),
  channelCode: z.string().trim().max(30).optional().nullable(),
  startsAt: z.string().date().optional().nullable(),
  endsAt: z.string().date().optional().nullable()
});

export type OmnichannelMetrics = {
  from: string;
  to: string;
  conversationsByChannel: Record<string, number>;
  carts: { created: number; active: number; abandoned: number; converted: number; expired: number };
  salesByChannel: Record<string, { count: number; revenue: number; averageTicket: number | null }>;
  salesByCampaign: Record<string, { count: number; revenue: number }>;
  salesBySeller: Record<string, { count: number; revenue: number }>;
  cartToSaleConversion: number | null;
  conversationToSaleConversion: number | null;
  avgMinutesToFirstReply: number | null;
  avgHoursToSale: number | null;
};

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Abierta",
  pending: "Pendiente",
  closed: "Cerrada",
  archived: "Archivada"
};

export const CART_STATUS_LABELS: Record<CartStatus, string> = {
  active: "Activo",
  abandoned: "Abandonado",
  converted: "Convertido",
  expired: "Vencido",
  cancelled: "Cancelado"
};

export const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  store: "Tienda",
  manual: "Manual"
};
