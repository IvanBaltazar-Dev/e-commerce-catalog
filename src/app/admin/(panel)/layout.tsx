import { redirect } from "next/navigation";
import { ToastProvider } from "@/components/admin/ToastProvider";
import { Topbar } from "@/components/admin/Topbar";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { catalogImportsEnabled } from "@/lib/auth/catalog-import";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }

  const { data: profile } = await supabase
    .from("admin_profiles")
    .select("id, role")
    .eq("id", user.id)
    .in("role", ["admin", "developer"])
    .maybeSingle();

  if (!profile) {
    redirect("/admin/login?error=forbidden");
  }

  return (
    <div className="panel-shell">
      <ToastProvider>
        <Topbar role={profile.role as "admin" | "developer"} importsEnabled={catalogImportsEnabled()} />
        <main className="panel-main">{children}</main>
      </ToastProvider>
    </div>
  );
}
