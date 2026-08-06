import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { createAdminOrderSchema, type AdminOrder, type AdminOrderLine } from "@/lib/admin/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  order_number: number;
  branch_id: string;
  // PostgREST devuelve un objeto para una relación a-uno, pero supabase-js la
  // infiere como arreglo. Se aceptan ambas formas y se normaliza al mapear.
  branch: { name: string } | { name: string }[] | null;
  status: AdminOrder["status"];
  customer_name: string;
  customer_phone: string | null;
  delivery_method: AdminOrder["deliveryMethod"];
  delivery_address: string | null;
  customer_note: string | null;
  total_units: number;
  subtotal: number | null;
  unresolved_lines: number;
  created_at: string;
  updated_at: string;
  lines: Array<{
    id: string;
    product_id: string | null;
    variant_id: string | null;
    sku: string;
    product_name: string;
    variant_name: string;
    brand_name: string;
    quantity: number;
    unit_price: number | null;
    subtotal: number | null;
    purchase_mode: AdminOrderLine["purchaseMode"];
    availability: AdminOrderLine["availability"];
  }> | null;
};

function branchName(branch: OrderRow["branch"]): string | undefined {
  if (!branch) return undefined;
  return Array.isArray(branch) ? branch[0]?.name : branch.name;
}

function mapOrder(row: OrderRow): AdminOrder {
  return {
    id: row.id,
    orderNumber: Number(row.order_number),
    branchId: row.branch_id,
    branchName: branchName(row.branch),
    status: row.status,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    deliveryMethod: row.delivery_method,
    deliveryAddress: row.delivery_address,
    customerNote: row.customer_note,
    totalUnits: row.total_units,
    subtotal: row.subtotal === null ? null : Number(row.subtotal),
    unresolvedLines: row.unresolved_lines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: (row.lines ?? []).map((line) => ({
      id: line.id,
      productId: line.product_id,
      variantId: line.variant_id,
      sku: line.sku,
      productName: line.product_name,
      variantName: line.variant_name,
      brandName: line.brand_name,
      quantity: line.quantity,
      unitPrice: line.unit_price === null ? null : Number(line.unit_price),
      subtotal: line.subtotal === null ? null : Number(line.subtotal),
      purchaseMode: line.purchase_mode,
      availability: line.availability
    }))
  };
}

export async function GET() {
  try {
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase
      .from("orders")
      .select("id, order_number, branch_id, branch:branches(name), status, customer_name, customer_phone, delivery_method, delivery_address, customer_note, total_units, subtotal, unresolved_lines, created_at, updated_at, lines:order_items(id, product_id, variant_id, sku, product_name, variant_name, brand_name, quantity, unit_price, subtotal, purchase_mode, availability)")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) throw new HttpError(400, "orders_list_failed", error.message);
    return ok({ items: (data as OrderRow[]).map(mapOrder) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, createAdminOrderSchema);
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase.rpc("create_admin_order", {
      p_customer_name: input.customerName,
      p_customer_phone: input.customerPhone || null,
      p_delivery_method: input.deliveryMethod,
      p_delivery_address: input.deliveryAddress || null,
      p_customer_note: input.customerNote || null,
      p_lines: input.lines,
      p_branch_id: input.branchId || null
    });

    if (error) throw new HttpError(400, "order_create_failed", error.message);
    return created(data as AdminOrder);
  } catch (error) {
    return handleApiError(error);
  }
}
