import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { registerGoodsReceiptSchema, type GoodsReceipt } from "@/lib/admin/purchasing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReceiptRow = {
  id: string;
  receipt_number: string;
  status: GoodsReceipt["status"];
  supplier_id: string;
  branch_id: string;
  purchase_order_id: string | null;
  currency: string;
  exchange_rate: number | null;
  received_at: string;
  goods_total_pen: number;
  supplier: { trade_name: string } | { trade_name: string }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);
    const supplierId = url.searchParams.get("supplier");
    const orderId = url.searchParams.get("order");

    let query = supabase
      .from("goods_receipts")
      .select("id, receipt_number, status, supplier_id, branch_id, purchase_order_id, currency, exchange_rate, received_at, goods_total_pen, supplier:suppliers(trade_name)")
      .order("received_at", { ascending: false })
      .limit(120);

    if (supplierId) query = query.eq("supplier_id", supplierId);
    if (orderId) query = query.eq("purchase_order_id", orderId);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "receipts_failed", error.message);

    return ok({
      items: (data as ReceiptRow[]).map((row) => ({
        id: row.id,
        receiptNumber: row.receipt_number,
        status: row.status,
        supplierId: row.supplier_id,
        supplierName: firstOf(row.supplier)?.trade_name ?? "",
        branchId: row.branch_id,
        purchaseOrderId: row.purchase_order_id,
        currency: row.currency,
        exchangeRate: row.exchange_rate === null ? null : Number(row.exchange_rate),
        receivedAt: row.received_at,
        goodsTotalPen: Number(row.goods_total_pen)
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * ES EL ÚNICO ORIGEN QUE AUMENTA EXISTENCIAS POR COMPRA. Todo ocurre dentro de
 * `register_goods_receipt`: entrada al kardex, recálculo del promedio ponderado,
 * obligación con el proveedor si es a crédito y estado de la orden.
 *
 * La bonificación del mismo artículo baja el costo efectivo; la de otro artículo
 * sin valor declarado entra al fondo sin valorar, nunca a costo cero.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, registerGoodsReceiptSchema);
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase.rpc("register_goods_receipt", {
      p_supplier_id: input.supplierId,
      p_branch_id: input.branchId,
      p_lines: input.lines,
      p_client_operation_id: input.clientOperationId,
      p_purchase_order_id: input.purchaseOrderId ?? null,
      p_currency: input.currency,
      p_exchange_rate: input.exchangeRate ?? null,
      p_supplier_document: input.supplierDocument ?? null,
      p_terms: input.terms,
      p_notes: input.notes ?? null
    });

    if (error) throw new HttpError(400, "receipt_failed", error.message);

    return created(data as GoodsReceipt);
  } catch (error) {
    return handleApiError(error);
  }
}
