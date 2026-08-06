import type { Metadata } from "next";
import { SalesView } from "@/components/admin/SalesView";

export const metadata: Metadata = { title: "Registrar venta — Bellaroshé" };

export default function VentasPage() {
  return <SalesView />;
}
