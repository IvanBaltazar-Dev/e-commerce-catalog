import type { Metadata } from "next";
import { QuickOrderView } from "@/components/admin/QuickOrderView";

export const metadata: Metadata = { title: "Registrar pedido — Bellaroshé" };

export default function PedidosPage() {
  return <QuickOrderView />;
}
