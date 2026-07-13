import type { Metadata } from "next";
import { ProductForm } from "@/components/admin/ProductForm";

export const metadata: Metadata = {
  title: "Admin · Nuevo producto — Bellaroshé"
};

export default function NuevoProductoPage() {
  return <ProductForm />;
}
