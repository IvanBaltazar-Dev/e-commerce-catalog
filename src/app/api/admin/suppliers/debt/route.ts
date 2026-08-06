import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import type { SupplierBalance, SupplierObligation } from "@/lib/admin/purchasing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BalanceRow = {
  supplier_id: string;
  supplier_name: string;
  currency: string;
  total_due: number;
  total_paid: number;
  balance: number;
  next_due_date: string | null;
};

type ObligationRow = {
  id: string;
  supplier_id: string;
  currency: string;
  amount_due: number;
  due_date: string | null;
  goods_receipt_id: string | null;
};

/**
 * Deuda por proveedor y MONEDA, derivada de obligaciones menos asignaciones.
 * Nunca se suman soles con dólares: son filas distintas, y la pantalla las
 * muestra separadas por eso, no por decoración.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);
    const supplierId = url.searchParams.get("supplier");

    let balancesQuery = supabase
      .from("supplier_balances")
      .select("supplier_id, supplier_name, currency, total_due, total_paid, balance, next_due_date")
      .order("balance", { ascending: false });

    let obligationsQuery = supabase
      .from("supplier_obligations")
      .select("id, supplier_id, currency, amount_due, due_date, goods_receipt_id")
      .is("voided_at", null)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200);

    if (supplierId) {
      balancesQuery = balancesQuery.eq("supplier_id", supplierId);
      obligationsQuery = obligationsQuery.eq("supplier_id", supplierId);
    }

    const [balances, obligations, unallocated] = await Promise.all([
      balancesQuery,
      obligationsQuery,
      supabase
        .from("supplier_unallocated_payments")
        .select("supplier_payment_id, supplier_id, currency, amount, allocated, unallocated, paid_at")
        .limit(100)
    ]);

    if (balances.error) throw new HttpError(400, "supplier_balances_failed", balances.error.message);
    if (obligations.error) throw new HttpError(400, "supplier_obligations_failed", obligations.error.message);
    if (unallocated.error) throw new HttpError(400, "supplier_advances_failed", unallocated.error.message);

    // Lo asignado por obligación se resuelve aquí para poder mostrar el pendiente
    // de cada documento sin pedirle a la base una vista más.
    const obligationIds = (obligations.data as ObligationRow[]).map((row) => row.id);
    const allocations = obligationIds.length
      ? await supabase
          .from("supplier_payment_allocations")
          .select("supplier_obligation_id, amount")
          .in("supplier_obligation_id", obligationIds)
      : { data: [], error: null };

    if (allocations.error) throw new HttpError(400, "supplier_allocations_failed", allocations.error.message);

    const allocatedByObligation = new Map<string, number>();
    for (const row of (allocations.data ?? []) as { supplier_obligation_id: string; amount: number }[]) {
      allocatedByObligation.set(
        row.supplier_obligation_id,
        (allocatedByObligation.get(row.supplier_obligation_id) ?? 0) + Number(row.amount)
      );
    }

    const balanceItems: SupplierBalance[] = (balances.data as BalanceRow[]).map((row) => ({
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      currency: row.currency,
      totalDue: Number(row.total_due),
      totalPaid: Number(row.total_paid),
      balance: Number(row.balance),
      nextDueDate: row.next_due_date
    }));

    const obligationItems: SupplierObligation[] = (obligations.data as ObligationRow[])
      .map((row) => {
        const allocated = allocatedByObligation.get(row.id) ?? 0;
        return {
          id: row.id,
          supplierId: row.supplier_id,
          currency: row.currency,
          amountDue: Number(row.amount_due),
          allocated,
          pending: Number(row.amount_due) - allocated,
          dueDate: row.due_date,
          goodsReceiptId: row.goods_receipt_id
        };
      })
      .filter((item) => item.pending > 0);

    return ok({
      balances: balanceItems,
      obligations: obligationItems,
      // Un pago sin asignar es un anticipo o crédito a favor del negocio.
      advances: (unallocated.data ?? []).map((row) => ({
        paymentId: row.supplier_payment_id,
        supplierId: row.supplier_id,
        currency: row.currency,
        amount: Number(row.amount),
        unallocated: Number(row.unallocated),
        paidAt: row.paid_at
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}
