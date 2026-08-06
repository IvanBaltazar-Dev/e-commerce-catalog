import { z } from "zod";
import type { AvailabilityStatus, PurchaseMode } from "@/lib/catalog/contracts";

export const adminOrderStatusSchema = z.enum(["registered", "confirmed", "completed", "cancelled"]);

export const createAdminOrderSchema = z.object({
  customerName: z.string().trim().min(1, "Ingresa el nombre del cliente.").max(120),
  customerPhone: z.string().trim().max(30).optional().nullable(),
  deliveryMethod: z.enum(["shipping", "pickup"]),
  deliveryAddress: z.string().trim().max(300).optional().nullable(),
  customerNote: z.string().trim().max(500).optional().nullable(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(999)
  })).min(1).max(50)
});

export const updateAdminOrderSchema = z.object({
  status: adminOrderStatusSchema
});

export type AdminOrderStatus = z.infer<typeof adminOrderStatusSchema>;
export type CreateAdminOrderInput = z.infer<typeof createAdminOrderSchema>;

export type AdminOrderLine = {
  id?: string;
  productId: string | null;
  variantId: string | null;
  sku: string;
  productName: string;
  variantName: string;
  brandName: string;
  quantity: number;
  unitPrice: number | null;
  subtotal: number | null;
  purchaseMode: PurchaseMode;
  availability: AvailabilityStatus;
};

export type AdminOrder = {
  id: string;
  orderNumber: number;
  status: AdminOrderStatus;
  customerName: string;
  customerPhone: string | null;
  deliveryMethod: "shipping" | "pickup";
  deliveryAddress: string | null;
  customerNote: string | null;
  totalUnits: number;
  subtotal: number | null;
  unresolvedLines: number;
  createdAt: string;
  updatedAt?: string;
  lines: AdminOrderLine[];
};
