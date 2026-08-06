import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { registerExpenseSchema, type Expense, type ExpenseCategory } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExpenseRow = {
  id: string;
  branch_id: string;
  method: Expense["method"];
  amount: number;
  currency: string;
  incurred_at: string;
  description: string;
  payee_name: string | null;
  recurrence: string;
  voided_at: string | null;
  void_reason: string | null;
  category: { name: string; code: string; scope: string } | { name: string; code: string; scope: string }[] | null;
};

function firstOf<T>(value: T | T[] | null): T | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Los gastos son dinero de la empresa: administración únicamente. */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const includeVoided = url.searchParams.get("voided") === "true";

    const categories = await supabase
      .from("expense_categories")
      .select("id, code, name, scope")
      .eq("is_active", true)
      .order("sort_order");

    if (categories.error) throw new HttpError(400, "expense_categories_failed", categories.error.message);

    let query = supabase
      .from("expenses")
      .select("id, branch_id, method, amount, currency, incurred_at, description, payee_name, recurrence, voided_at, void_reason, category:expense_categories(name, code, scope)")
      .order("incurred_at", { ascending: false })
      .limit(200);

    if (from) query = query.gte("incurred_at", from);
    if (to) query = query.lte("incurred_at", to);
    if (!includeVoided) query = query.is("voided_at", null);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "expenses_list_failed", error.message);

    return ok({
      categories: (categories.data ?? []) as ExpenseCategory[],
      items: (data as ExpenseRow[]).map((row) => {
        const category = firstOf(row.category);
        return {
          id: row.id,
          branchId: row.branch_id,
          category: category?.name ?? "",
          categoryCode: category?.code ?? "",
          scope: category?.scope ?? "store",
          method: row.method,
          amount: Number(row.amount),
          currency: row.currency,
          incurredAt: row.incurred_at,
          description: row.description,
          payeeName: row.payee_name,
          recurrence: row.recurrence,
          voidedAt: row.voided_at,
          voidReason: row.void_reason
        };
      })
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, registerExpenseSchema);
    const { supabase } = await requireAdmin();

    // El gasto sale del cajón solo si se pagó en efectivo: el movimiento de caja
    // lo decide `register_expense`, no este código.
    const { data, error } = await supabase.rpc("register_expense", {
      p_branch_id: input.branchId,
      p_expense_category_id: input.expenseCategoryId,
      p_method: input.method,
      p_amount: input.amount,
      p_description: input.description,
      p_client_operation_id: input.clientOperationId,
      p_supplier_id: input.supplierId ?? null,
      p_payee_name: input.payeeName ?? null,
      p_incurred_at: input.incurredAt ?? null,
      p_document: input.document ?? null,
      p_evidence_path: input.evidencePath ?? null,
      p_recurrence: input.recurrence,
      p_allocations: input.allocations ?? null
    });

    if (error) throw new HttpError(400, "expense_register_failed", error.message);

    return created(data as Expense);
  } catch (error) {
    return handleApiError(error);
  }
}
