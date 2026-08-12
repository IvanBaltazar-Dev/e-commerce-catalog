import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type BackofficeRole = "admin" | "developer" | "seller";

export type BackofficeProfile = {
  id: string;
  role: BackofficeRole;
  full_name: string | null;
  is_active: boolean;
};

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type BackofficeContext = {
  supabase: SupabaseServerClient;
  user: User | null;
  profile: BackofficeProfile | null;
  authError: string | null;
  profileError: string | null;
};

/**
 * Identidad administrativa resuelta una sola vez por render/petición.
 *
 * El layout y la página suelen preguntar por el mismo usuario. Sin `cache`,
 * cada uno hacía su propia llamada a GoTrue y otra a `admin_profiles`. React
 * descarta esta caché al terminar la petición: no comparte sesiones entre
 * personas ni sustituye las políticas RLS de PostgreSQL.
 */
export const getBackofficeContext = cache(async (): Promise<BackofficeContext> => {
  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const user = authData.user ?? null;

  if (authError || !user) {
    return {
      supabase,
      user: null,
      profile: null,
      authError: authError?.message ?? "missing_user",
      profileError: null,
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("id, role, full_name, is_active")
    .eq("id", user.id)
    .maybeSingle<BackofficeProfile>();

  return {
    supabase,
    user,
    profile: profile ?? null,
    authError: null,
    profileError: profileError?.message ?? null,
  };
});
