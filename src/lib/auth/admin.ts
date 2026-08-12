import "server-only";

import { HttpError } from "@/lib/api/http";
import {
  getBackofficeContext,
  type BackofficeRole,
} from "@/lib/auth/backoffice-context";

export type { BackofficeProfile, BackofficeRole } from "@/lib/auth/backoffice-context";

async function requireBackofficeRole(allowedRoles: BackofficeRole[]) {
  const context = await getBackofficeContext();
  const { supabase, user, profile } = context;

  if (context.authError || !user) {
    throw new HttpError(401, "unauthenticated", "An authenticated admin session is required.");
  }

  if (context.profileError) {
    throw new HttpError(500, "admin_lookup_failed", context.profileError);
  }

  // Un perfil desactivado conserva su rol e historial pero pierde el acceso.
  // La base aplica la misma regla en `is_admin()`; esto la adelanta a la ruta.
  if (!profile || profile.is_active === false || !allowedRoles.includes(profile.role)) {
    throw new HttpError(403, "forbidden", "El usuario actual no tiene el rol requerido.");
  }

  return {
    supabase,
    user,
    profile
  };
}

/** Control total del negocio: propietaria y perfil técnico. */
export function requireAdmin() {
  return requireBackofficeRole(["admin", "developer"]);
}

/** Rutas exclusivas del perfil técnico, como el cargador de catálogo. */
export function requireDeveloper() {
  return requireBackofficeRole(["developer"]);
}

/**
 * Cualquier persona del equipo con perfil activo, incluidas las vendedoras.
 * Úsalo en operación diaria; el alcance por sede lo resuelve la base con
 * `staff_branch_ids()` y las políticas RLS.
 */
export function requireStaff() {
  return requireBackofficeRole(["admin", "developer", "seller"]);
}
