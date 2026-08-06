import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { closeCashSessionSchema, type CashMovement, type CashSession } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MovementRow = {
  id: number;
  kind: string;
  method: CashMovement["method"];
  amount: number;
  source_label: string | null;
  actor_label: string | null;
  note: string | null;
  occurred_at: string;
};

/** Detalle de la caja con su resumen por medio de pago y sus movimientos. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireStaff();

    const [detail, movements] = await Promise.all([
      supabase.rpc("cash_session_detail", { p_id: id }),
      supabase
        .from("cash_movements")
        .select("id, kind, method, amount, source_label, actor_label, note, occurred_at")
        .eq("cash_session_id", id)
        .order("id", { ascending: false })
        .limit(500)
    ]);

    if (detail.error) throw new HttpError(400, "cash_detail_failed", detail.error.message);
    if (!detail.data) throw new HttpError(404, "cash_not_found", "La caja no existe o no pertenece a tus sedes.");
    if (movements.error) throw new HttpError(400, "cash_movements_failed", movements.error.message);

    return ok({
      session: detail.data as CashSession,
      movements: (movements.data as MovementRow[]).map((row) => ({
        id: Number(row.id),
        kind: row.kind,
        method: row.method,
        amount: Number(row.amount),
        sourceLabel: row.source_label,
        actorLabel: row.actor_label,
        note: row.note,
        occurredAt: row.occurred_at
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Cierre con arqueo. La diferencia la calcula PostgreSQL contra el efectivo
 * esperado y la congela: el arqueo es una foto, no una consulta que cambie si
 * después se registra algo con fecha anterior.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, closeCashSessionSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("close_cash_session", {
      p_cash_session_id: id,
      p_counted_cash: input.countedCash,
      p_note: input.note ?? null
    });

    if (error) throw new HttpError(400, "cash_close_failed", error.message);

    return ok(data as CashSession);
  } catch (error) {
    return handleApiError(error);
  }
}
