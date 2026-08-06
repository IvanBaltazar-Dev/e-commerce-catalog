import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { KardexEntry } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LedgerEntry = {
  id: number;
  movementType: string;
  quantity: number;
  balanceAfter: number;
  sourceType: string | null;
  sourceLabel: string | null;
  actorLabel: string | null;
  reason: string | null;
  occurredAt: string;
  cost: {
    unitCost: number | null;
    valueDelta: number | null;
    valueAfter: number | null;
    costBasis: KardexEntry["costBasis"];
  } | null;
};

/**
 * Kardex por variante y sede, servido por `inventory_ledger`.
 *
 * NO se lee la tabla directamente. `inventory_movements` lleva unit_cost,
 * value_delta y value_after, y su política concede lectura de fila completa al
 * personal de la sede —que necesita ver su propio stock—: consultarla desde
 * aquí publicaba el costo de cada asiento a cualquier vendedora, justo lo que
 * el modelo declara en cero filas para ella. La RLS no recorta columnas y un
 * GRANT por columna no distingue roles, así que el recorte vive en el objeto
 * DEFINER, que sí sabe quién pregunta.
 *
 * El orden es por `id` y no por `occurred_at`: dentro de un mismo RPC varios
 * asientos comparten instante, y leerlos por fecha mostraría saldos fuera de
 * secuencia.
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

    if (!branchId) {
      throw new HttpError(400, "branch_required", "Indica la sede: el kardex es por variante y sede.");
    }

    const { data, error } = await supabase.rpc("inventory_ledger", {
      p_variant_id: variantId,
      p_branch_id: branchId,
      p_from: null,
      p_to: null,
      p_limit: 300
    });

    if (error) throw new HttpError(400, "kardex_failed", error.message);

    const ledger = data as { entries: LedgerEntry[]; onHand: number; reserved: number } | null;

    const items: KardexEntry[] = (ledger?.entries ?? []).map((entry) => ({
      id: Number(entry.id),
      movementType: entry.movementType,
      quantity: entry.quantity,
      balanceAfter: entry.balanceAfter,
      // Nulos para la vendedora: el objeto DEFINER omite el bloque entero.
      unitCost: entry.cost?.unitCost == null ? null : Number(entry.cost.unitCost),
      valueDelta: entry.cost?.valueDelta == null ? null : Number(entry.cost.valueDelta),
      valueAfter: entry.cost?.valueAfter == null ? null : Number(entry.cost.valueAfter),
      costBasis: entry.cost?.costBasis ?? null,
      sourceType: entry.sourceType,
      sourceLabel: entry.sourceLabel,
      actorLabel: entry.actorLabel,
      reason: entry.reason,
      occurredAt: entry.occurredAt
    }));

    return ok({
      items,
      onHand: ledger?.onHand ?? 0,
      reserved: ledger?.reserved ?? 0
    });
  } catch (error) {
    return handleApiError(error);
  }
}
