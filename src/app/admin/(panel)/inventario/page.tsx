import type { Metadata } from "next";
import { InventoryBoardView } from "@/components/admin/InventoryBoardView";
import { loadInventoryBoard } from "@/lib/admin/inventory-board-service";
import { requirePanelContext } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Existencias — Bellaroshé" };
export const dynamic = "force-dynamic";

export default async function InventarioPage() {
  const { supabase } = await requirePanelContext(["admin", "developer", "seller"]);
  const initialData = await loadInventoryBoard(supabase);
  return <InventoryBoardView soloReposicion={false} initialData={initialData} />;
}
