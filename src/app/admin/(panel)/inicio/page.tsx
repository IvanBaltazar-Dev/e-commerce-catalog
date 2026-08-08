import type { Metadata } from "next";
import { OwnerHomeView } from "@/components/admin/OwnerHomeView";
import { redirect } from "next/navigation";
import { loadOwnerHome } from "@/lib/admin/owner-home";
import { panelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Inicio — Bellaroshé" };
export const dynamic = "force-dynamic";

export default async function InicioPage() {
  // El Inicio es de la propietaria. Si entra una vendedora —por un enlace
  // guardado, por ejemplo— se la lleva a donde sí trabaja, no se le muestra un
  // error: no ha hecho nada malo.
  const role = await panelRole();
  if (role === "seller") redirect("/admin/ventas");

  const data = await loadOwnerHome();
  return <OwnerHomeView data={data} />;
}
