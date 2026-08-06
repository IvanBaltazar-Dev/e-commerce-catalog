import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { openCashSessionSchema, type CashSession } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionRow = {
  id: string;
  session_number: string;
  branch_id: string;
  status: CashSession["status"];
  opening_float: number;
  opened_at: string;
  opened_by_label: string | null;
  closed_at: string | null;
  closed_by_label: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
};

/** Historial de cajas de las sedes de quien consulta. La RLS hace el recorte. */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = supabase
      .from("cash_sessions")
      .select("id, session_number, branch_id, status, opening_float, opened_at, opened_by_label, closed_at, closed_by_label, counted_cash, expected_cash, difference")
      .order("opened_at", { ascending: false })
      .limit(60);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "cash_sessions_failed", error.message);

    return ok({
      items: (data as SessionRow[]).map((row) => ({
        id: row.id,
        sessionNumber: row.session_number,
        branchId: row.branch_id,
        status: row.status,
        openingFloat: Number(row.opening_float),
        openedAt: row.opened_at,
        openedByLabel: row.opened_by_label,
        closedAt: row.closed_at,
        closedByLabel: row.closed_by_label,
        countedCash: row.counted_cash === null ? null : Number(row.counted_cash),
        expectedCash: row.expected_cash === null ? null : Number(row.expected_cash),
        difference: row.difference === null ? null : Number(row.difference)
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, openCashSessionSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("open_cash_session", {
      p_branch_id: input.branchId,
      p_opening_float: input.openingFloat,
      p_note: input.note ?? null
    });

    if (error) throw new HttpError(400, "cash_open_failed", error.message);

    return created(data as CashSession);
  } catch (error) {
    return handleApiError(error);
  }
}
