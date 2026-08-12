import "server-only";
import { redirect } from "next/navigation";
import {
  getBackofficeContext,
  type BackofficeProfile,
  type BackofficeRole,
} from "@/lib/auth/backoffice-context";

export type PanelRole = BackofficeRole;

export type PanelContext = {
  role: PanelRole;
  profile: BackofficeProfile;
  supabase: Awaited<ReturnType<typeof getBackofficeContext>>["supabase"];
};

/**
 * Rol de quien entra al panel. Desde el Bloque 2 la vendedora también entra:
 * registra ventas desde el primer día, así que el recorte no es «quién entra»
 * sino «qué ve», y lo decide cada pantalla con `requirePanelRole`.
 */
export async function panelRole(): Promise<PanelRole | null> {
  const { profile, authError, profileError } = await getBackofficeContext();
  if (authError || profileError || !profile || profile.is_active === false) return null;

  const role = profile.role;
  return role === "admin" || role === "developer" || role === "seller" ? role : null;
}

/**
 * Corta el acceso a una pantalla que no corresponde al rol. La vendedora que
 * escribe /admin/productos a mano acaba en la suya, no en un error.
 */
export async function requirePanelRole(allowed: PanelRole[]): Promise<PanelRole> {
  return (await requirePanelContext(allowed)).role;
}

/** Autoriza y entrega el mismo cliente ya resuelto para cargar la página. */
export async function requirePanelContext(allowed: PanelRole[]): Promise<PanelContext> {
  const context = await getBackofficeContext();
  const role = context.profile?.role ?? null;

  if (
    context.authError
    || context.profileError
    || !context.profile
    || context.profile.is_active === false
    || !role
  ) redirect("/admin/login");
  if (!allowed.includes(role)) redirect("/admin/ventas");

  return {
    role,
    profile: context.profile,
    supabase: context.supabase,
  };
}
