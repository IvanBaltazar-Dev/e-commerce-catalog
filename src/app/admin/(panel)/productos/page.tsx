import type { Metadata } from "next";
import { ProductListView } from "@/components/admin/ProductListView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = {
  title: "Admin · Productos — Bellaroshé"
};

export default async function ProductosPage() {
  await requirePanelRole(["admin", "developer"]);
  return <ProductListView />;
}
