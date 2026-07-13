import "server-only";

import { HttpError } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireAdmin() {
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
    .eq("role", "admin")
    .maybeSingle();

  if (profileError) {
    throw new HttpError(500, "admin_lookup_failed", profileError.message);
  }

  if (!profile) {
    throw new HttpError(403, "forbidden", "The current user is not an admin.");
  }

  return {
    supabase,
    user,
    profile
  };
}
