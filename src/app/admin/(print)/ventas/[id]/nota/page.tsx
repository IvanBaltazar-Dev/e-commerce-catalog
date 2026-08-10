import type { Metadata } from "next";
import { SaleNoteView } from "@/components/admin/SaleNoteView";

export const metadata: Metadata = { title: "Nota de venta — Bellaroshé" };

export default async function NotaDeVentaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SaleNoteView saleId={id} />;
}
