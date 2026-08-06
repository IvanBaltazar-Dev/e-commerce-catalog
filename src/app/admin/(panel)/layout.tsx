import { redirect } from "next/navigation";
import { ToastProvider } from "@/components/admin/ToastProvider";
import { Topbar } from "@/components/admin/Topbar";
import { panelRole } from "@/lib/auth/panel";
import { catalogImportsEnabled } from "@/lib/auth/catalog-import";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  // La vendedora entra al panel desde el Bloque 2: la caja es suya. Lo que
  // cambia por rol es qué pantallas ve, no si puede entrar.
  const role = await panelRole();

  if (!role) {
    redirect("/admin/login?error=forbidden");
  }

  return (
    <div className="panel-shell">
      <ToastProvider>
        <Topbar role={role} importsEnabled={catalogImportsEnabled()} />
        <main className="panel-main">{children}</main>
      </ToastProvider>
    </div>
  );
}
