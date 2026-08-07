import type { Metadata } from "next";
import { CartsAdminView } from "@/components/admin/CartsAdminView";

export const metadata: Metadata = { title: "Carritos — Bellaroshé" };

export default function CarritosPage() {
  return <CartsAdminView />;
}
