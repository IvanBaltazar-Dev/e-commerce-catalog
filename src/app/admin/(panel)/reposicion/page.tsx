import type { Metadata } from "next";
import { InventoryBoardView } from "@/components/admin/InventoryBoardView";
import { loadInventoryBoard } from "@/lib/admin/inventory-board-service";
import { requirePanelContext } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Reposición — Bellaroshé" };
export const dynamic = "force-dynamic";

export default async function ReposicionPage() {
  // La reposición es el mismo circuito que las existencias, y la vendedora
  // opera el inventario de sus sedes: no se le cierra la puerta.
  const { supabase } = await requirePanelContext(["admin", "developer", "seller"]);
  const initialData = await loadInventoryBoard(supabase, { onlyReposition: true });
  return <InventoryBoardView soloReposicion initialData={initialData} />;
}
