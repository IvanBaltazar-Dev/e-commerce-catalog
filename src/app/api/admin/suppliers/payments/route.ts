import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { registerSupplierPaymentSchema, type SupplierPayment } from "@/lib/admin/purchasing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PaymentRow = {
  id: string;
  supplier_id: string;
  branch_id: string;
  method: SupplierPayment["method"];
  amount: number;
  currency: string;
  paid_at: string;
  reference: string | null;
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

    let query = supabase
      .from("supplier_payments")
      .select("id, supplier_id, branch_id, method, amount, currency, paid_at, reference, supplier:suppliers(trade_name)")
      .order("paid_at", { ascending: false })
      .limit(120);

    if (supplierId) query = query.eq("supplier_id", supplierId);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "supplier_payments_failed", error.message);

    return ok({
      items: (data as PaymentRow[]).map((row) => ({
        id: row.id,
        supplierId: row.supplier_id,
        supplierName: firstOf(row.supplier)?.trade_name ?? "",
        branchId: row.branch_id,
        method: row.method,
        amount: Number(row.amount),
        currency: row.currency,
        paidAt: row.paid_at,
        reference: row.reference
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * El pago NO altera el costo histórico ya incorporado al inventario: solo
 * cancela obligaciones. Sin asignaciones queda como anticipo a favor.
 *
 * La base impide asignar más de lo desembolsado, más de lo exigible, y
 * compensar monedas distintas sin conversión explícita.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, registerSupplierPaymentSchema);
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase.rpc("register_supplier_payment", {
      p_supplier_id: input.supplierId,
      p_branch_id: input.branchId,
      p_method: input.method,
      p_amount: input.amount,
      p_client_operation_id: input.clientOperationId,
      p_currency: input.currency,
      p_allocations: input.allocations ?? [],
      p_reference: input.reference ?? null,
      p_evidence_path: input.evidencePath ?? null,
      p_paid_at: input.paidAt ?? null,
      p_notes: input.notes ?? null
    });

    if (error) throw new HttpError(400, "supplier_payment_failed", error.message);

    return created(data as SupplierPayment);
  } catch (error) {
    return handleApiError(error);
  }
}
