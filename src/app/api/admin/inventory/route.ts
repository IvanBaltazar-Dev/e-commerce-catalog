import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { adjustInventorySchema, type InventoryPosition } from "@/lib/admin/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PositionRow = {
  variant_id: string;
  branch_id: string;
  on_hand: number;
  reserved: number;
  available_quantity: number;
  unvalued_quantity: number;
  average_unit_cost: number | null;
  total_value: number | null;
};

/**
 * Existencias por sede. La RLS recorta a las sedes de quien consulta y deja en
 * nulo el bloque de valor para la vendedora: `inventory_position` es
 * `security_invoker`, así que el recorte lo hace la base y no este código.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);
    const branchId = url.searchParams.get("branch");
    const search = url.searchParams.get("search");
    const onlyLow = url.searchParams.get("low") === "true";

    let query = supabase
      .from("inventory_position")
      .select("variant_id, branch_id, on_hand, reserved, available_quantity, unvalued_quantity, average_unit_cost, total_value")
      .order("available_quantity", { ascending: true })
      .limit(500);

    if (branchId) query = query.eq("branch_id", branchId);
    if (onlyLow) query = query.lte("available_quantity", 5);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "inventory_list_failed", error.message);

    const rows = (data ?? []) as PositionRow[];
    const variantIds = [...new Set(rows.map((row) => row.variant_id))];
    const branchIds = [...new Set(rows.map((row) => row.branch_id))];

    const [variants, branches] = await Promise.all([
      supabase.from("product_variants").select("id, sku, name, product:products(name)").in("id", variantIds),
      supabase.from("branches").select("id, name").in("id", branchIds)
    ]);

    if (variants.error) throw new HttpError(400, "inventory_variants_failed", variants.error.message);
    if (branches.error) throw new HttpError(400, "inventory_branches_failed", branches.error.message);

    const variantById = new Map(
      (variants.data ?? []).map((v) => {
        const product = v.product as unknown as { name: string } | { name: string }[] | null;
        const productName = Array.isArray(product) ? product[0]?.name : product?.name;
        return [v.id, { sku: v.sku as string | null, name: v.name as string, productName: productName ?? "" }];
      })
    );
    const branchById = new Map((branches.data ?? []).map((b) => [b.id, b.name as string]));

    const items: InventoryPosition[] = rows
      .map((row) => {
        const variant = variantById.get(row.variant_id);
        return {
          variantId: row.variant_id,
          branchId: row.branch_id,
          branchName: branchById.get(row.branch_id) ?? "",
          sku: variant?.sku ?? null,
          productName: variant?.productName ?? "",
          variantName: variant?.name ?? "",
          onHand: row.on_hand,
          reserved: row.reserved,
          available: row.available_quantity,
          unvaluedQuantity: row.unvalued_quantity,
          averageUnitCost: row.average_unit_cost === null ? null : Number(row.average_unit_cost),
          totalValue: row.total_value === null ? null : Number(row.total_value)
        };
      })
      .filter((item) => {
        if (!search) return true;
        const needle = search.toLowerCase();
        return (
          (item.sku ?? "").toLowerCase().includes(needle) ||
          item.productName.toLowerCase().includes(needle) ||
          item.variantName.toLowerCase().includes(needle)
        );
      });

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Ajuste con motivo obligatorio. Solo administración; la base lo reimpone. */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, adjustInventorySchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("adjust_inventory", {
      p_variant_id: input.variantId,
      p_branch_id: input.branchId,
      p_quantity: input.quantity,
      p_reason: input.reason,
      p_unit_cost: input.unitCost ?? null
    });

    if (error) throw new HttpError(400, "inventory_adjust_failed", error.message);

    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}
