import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/http";
import type {
  InventoryBoardData,
  InventoryBoardFilters,
} from "@/lib/admin/inventory-board-contract";

/** Una sola lectura para SSR inicial y para los filtros posteriores de la API. */
export async function loadInventoryBoard(
  supabase: SupabaseClient,
  filters: InventoryBoardFilters = {},
): Promise<InventoryBoardData> {
  const { data, error } = await supabase.rpc("inventory_board", {
    p_branch_id: filters.branchId ?? null,
    p_query: filters.query ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_only_reposition: filters.onlyReposition ?? false,
    p_limit: filters.limit ?? 200,
  });

  if (error) throw new HttpError(500, "inventory_board_failed", error.message);

  const payload = (data ?? {}) as Partial<InventoryBoardData>;
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Number(payload.total ?? 0),
    rango: payload.rango ?? null,
  };
}
