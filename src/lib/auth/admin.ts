import "server-only";

import { HttpError } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type BackofficeRole = "admin" | "developer" | "seller";

export type BackofficeProfile = {
  id: string;
  role: BackofficeRole;
  full_name: string | null;
  is_active: boolean;
};

async function requireBackofficeRole(allowedRoles: BackofficeRole[]) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new HttpError(401, "unauthenticated", "An authenticated admin session is required.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("id, role, full_name, is_active")
    .eq("id", user.id)
    // Un perfil desactivado conserva su rol e historial pero pierde el acceso.
    // La base aplica la misma regla en `is_admin()`; esto la adelanta a la ruta.
    .eq("is_active", true)
    .in("role", allowedRoles)
    .maybeSingle<BackofficeProfile>();

  if (profileError) {
    throw new HttpError(500, "admin_lookup_failed", profileError.message);
  }

  if (!profile) {
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
