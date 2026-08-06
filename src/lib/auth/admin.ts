import "server-only";

import { HttpError } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type BackofficeRole = "admin" | "developer";

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
    .select("id, role, full_name")
    .eq("id", user.id)
    .in("role", allowedRoles)
    .maybeSingle();

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

export function requireAdmin() {
  return requireBackofficeRole(["admin", "developer"]);
}

export function requireDeveloper() {
  return requireBackofficeRole(["developer"]);
}
