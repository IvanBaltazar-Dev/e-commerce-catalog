import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PanelRole = "admin" | "developer" | "seller";

/**
 * Rol de quien entra al panel. Desde el Bloque 2 la vendedora también entra:
 * registra ventas desde el primer día, así que el recorte no es «quién entra»
 * sino «qué ve», y lo decide cada pantalla con `requirePanelRole`.
 */
export async function panelRole(): Promise<PanelRole | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("admin_profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || data.is_active === false) return null;

  const role = data.role as PanelRole;
  return role === "admin" || role === "developer" || role === "seller" ? role : null;
}

/**
 * Corta el acceso a una pantalla que no corresponde al rol. La vendedora que
 * escribe /admin/productos a mano acaba en la suya, no en un error.
 */
export async function requirePanelRole(allowed: PanelRole[]): Promise<PanelRole> {
  const role = await panelRole();

  if (!role) redirect("/admin/login");
  if (!allowed.includes(role)) redirect("/admin/ventas");

  return role;
}
