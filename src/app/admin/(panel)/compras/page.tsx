import type { Metadata } from "next";
import { PurchasingView } from "@/components/admin/PurchasingView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Abastecimiento — Bellaroshé" };

export default async function ComprasPage() {
  // Las compras son dominio administrativo: la vendedora obtiene cero filas y
  // la barra no le ofrece esta sección.
  await requirePanelRole(["admin", "developer"]);
  return <PurchasingView />;
}
