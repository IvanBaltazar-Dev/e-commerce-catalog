import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { KardexEntry } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MovementRow = {
  id: number;
  movement_type: string;
  quantity: number;
  balance_after: number;
  unit_cost: number | null;
  value_delta: number | null;
  value_after: number | null;
  cost_basis: KardexEntry["costBasis"];
  source_type: string | null;
  source_label: string | null;
  actor_label: string | null;
  reason: string | null;
  occurred_at: string;
};

/**
 * Kardex por variante y sede. Se ordena por `id` y no por `occurred_at`: dentro
 * de un mismo RPC varios asientos comparten instante, y leerlos por fecha
 * mostraría saldos fuera de secuencia.
 *
 * Las columnas monetarias llegan nulas a la vendedora por la RLS de la tabla.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);
    const variantId = url.searchParams.get("variant");
    const branchId = url.searchParams.get("branch");

    if (!variantId) {
      throw new HttpError(400, "variant_required", "Indica la presentación a consultar.");
    }

    let query = supabase
      .from("inventory_movements")
      .select("id, movement_type, quantity, balance_after, unit_cost, value_delta, value_after, cost_basis, source_type, source_label, actor_label, reason, occurred_at")
      .eq("variant_id", variantId)
      .order("id", { ascending: false })
      .limit(300);

    if (branchId) query = query.eq("branch_id", branchId);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "kardex_failed", error.message);

    const items: KardexEntry[] = (data as MovementRow[]).map((row) => ({
      id: Number(row.id),
      movementType: row.movement_type,
      quantity: row.quantity,
      balanceAfter: row.balance_after,
      unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
      valueDelta: row.value_delta === null ? null : Number(row.value_delta),
      valueAfter: row.value_after === null ? null : Number(row.value_after),
      costBasis: row.cost_basis,
      sourceType: row.source_type,
      sourceLabel: row.source_label,
      actorLabel: row.actor_label,
      reason: row.reason,
      occurredAt: row.occurred_at
    }));

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}
