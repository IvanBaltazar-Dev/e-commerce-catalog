import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { issuePurchaseOrderSchema, type PurchaseOrder } from "@/lib/admin/purchasing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  order_number: string;
  status: PurchaseOrder["status"];
  branch_id: string;
  supplier_id: string;
  terms: PurchaseOrder["terms"];
  currency: string;
  expected_at: string | null;
  gross_total: number;
  discount_total: number;
  total: number;
  created_at: string;
  supplier: { trade_name: string } | { trade_name: string }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** El abastecimiento es dominio administrativo: la vendedora obtiene cero filas. */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const supplierId = url.searchParams.get("supplier");

    let query = supabase
      .from("purchase_orders")
      .select("id, order_number, status, branch_id, supplier_id, terms, currency, expected_at, gross_total, discount_total, total, created_at, supplier:suppliers(trade_name)")
      .order("created_at", { ascending: false })
      .limit(120);

    if (status) query = query.eq("status", status);
    if (supplierId) query = query.eq("supplier_id", supplierId);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "purchase_orders_failed", error.message);

    return ok({
      items: (data as OrderRow[]).map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        status: row.status,
        branchId: row.branch_id,
        supplierId: row.supplier_id,
        supplierName: firstOf(row.supplier)?.trade_name ?? "",
        terms: row.terms,
        currency: row.currency,
        expectedAt: row.expected_at,
        grossTotal: Number(row.gross_total),
        discountTotal: Number(row.discount_total),
        total: Number(row.total),
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Emite la orden congelando el costo. Si la línea no declara importe, la base
 * lo toma del acuerdo vigente y lo fija: reresolverlo después haría que el
 * histórico de la compra cambiara al registrarse un acuerdo nuevo.
 *
 * La orden NO incrementa inventario. Solo la recepción confirmada lo hace.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, issuePurchaseOrderSchema);
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase.rpc("issue_purchase_order", {
      p_supplier_id: input.supplierId,
      p_branch_id: input.branchId,
      p_lines: input.lines,
      p_client_operation_id: input.clientOperationId,
      p_currency: input.currency ?? null,
      p_terms: input.terms,
      p_payment_terms_days: input.paymentTermsDays ?? null,
      p_expected_at: input.expectedAt ?? null,
      p_notes: input.notes ?? null
    });

    if (error) throw new HttpError(400, "purchase_order_failed", error.message);

    return created(data as PurchaseOrder);
  } catch (error) {
    return handleApiError(error);
  }
}
