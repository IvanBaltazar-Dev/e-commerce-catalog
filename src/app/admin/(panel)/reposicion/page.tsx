import type { Metadata } from "next";
import { InventoryBoardView } from "@/components/admin/InventoryBoardView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Reposición — Bellaroshé" };
export const dynamic = "force-dynamic";

export default async function ReposicionPage() {
  // La reposición es el mismo circuito que las existencias, y la vendedora
  // opera el inventario de sus sedes: no se le cierra la puerta.
  await requirePanelRole(["admin", "developer", "seller"]);
  return <InventoryBoardView soloReposicion />;
}
