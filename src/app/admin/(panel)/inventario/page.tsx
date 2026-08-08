import type { Metadata } from "next";
import { InventoryBoardView } from "@/components/admin/InventoryBoardView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Existencias — Bellaroshé" };
export const dynamic = "force-dynamic";

export default async function InventarioPage() {
  await requirePanelRole(["admin", "developer", "seller"]);
  return <InventoryBoardView soloReposicion={false} />;
}
