import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sedes en las que quien consulta puede operar. Se resuelven con el mismo
 * predicado que usa la RLS (`staff_branch_ids`), así que la lista que ve la
 * pantalla y la que acepta `register_sale` no pueden divergir: administración
 * alcanza todas las sedes activas y la vendedora solo las asignadas.
 */
export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const { data: allowed, error: allowedError } = await supabase.rpc("staff_branch_ids");
    if (allowedError) throw new HttpError(400, "branches_scope_failed", allowedError.message);

    const ids = (allowed as string[] | null) ?? [];
    if (ids.length === 0) return ok({ items: [] });

    const { data, error } = await supabase
      .from("branches")
      .select("id, code, name, district, is_default, sort_order")
      .in("id", ids)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw new HttpError(400, "branches_list_failed", error.message);

    return ok({
      items: (data ?? []).map((row) => ({
        id: row.id as string,
        code: row.code as string,
        name: row.name as string,
        district: (row.district as string | null) ?? null,
        isDefault: Boolean(row.is_default)
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}
