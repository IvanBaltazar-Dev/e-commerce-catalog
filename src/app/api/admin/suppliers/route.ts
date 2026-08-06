import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proveedores habilitados para comprar. Administrativo: la RLS de `suppliers`
 * ya devuelve cero filas a una vendedora, y la ruta lo adelanta con requireAdmin
 * para que el error sea 403 y no una lista vacía sin explicación.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);
    const onlyActive = url.searchParams.get("all") !== "1";

    let query = supabase
      .from("suppliers")
      .select("id, code, trade_name, legal_name, status, default_currency, payment_terms_days")
      .order("trade_name", { ascending: true })
      .limit(200);

    if (onlyActive) query = query.eq("status", "active");

    const { data, error } = await query;
    if (error) throw new HttpError(400, "suppliers_list_failed", error.message);

    return ok({
      items: (data ?? []).map((row) => ({
        id: row.id as string,
        code: row.code as string,
        name: (row.trade_name as string) || (row.legal_name as string),
        status: row.status as string,
        defaultCurrency: row.default_currency as string,
        paymentTermsDays: Number(row.payment_terms_days ?? 0)
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}
