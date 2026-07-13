import type { Metadata } from "next";
import { ProductListView } from "@/components/admin/ProductListView";

export const metadata: Metadata = {
  title: "Admin · Productos — Bellaroshé"
};

export default function ProductosPage() {
  return <ProductListView />;
}
