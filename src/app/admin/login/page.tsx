import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/admin/LoginForm";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Admin · Inicio de sesión — Bellaroshé"
};

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("admin_profiles")
      .select("id")
      .eq("id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (profile) {
      redirect("/admin/productos");
    }
  }

  return (
    <LoginForm
      initialError={
        params.error === "forbidden" ? "Tu usuario no tiene permisos de administrador." : ""
      }
    />
  );
}
