import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { voidExpenseSchema, type Expense } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase.rpc("expense_detail", { p_id: id });

    if (error) throw new HttpError(400, "expense_detail_failed", error.message);
    if (!data) throw new HttpError(404, "expense_not_found", "El gasto no existe.");

    return ok(data as Expense);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Anulación sin borrado físico: el gasto original se conserva marcado, y el
 * importe vuelve al cajón como movimiento compensatorio.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, voidExpenseSchema);
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase.rpc("void_expense", {
      p_expense_id: id,
      p_reason: input.reason
    });

    if (error) throw new HttpError(400, "expense_void_failed", error.message);

    return ok(data as Expense);
  } catch (error) {
    return handleApiError(error);
  }
}
