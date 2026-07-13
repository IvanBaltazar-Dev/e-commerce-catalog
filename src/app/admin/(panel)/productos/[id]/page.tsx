import type { Metadata } from "next";
import { ProductForm } from "@/components/admin/ProductForm";

export const metadata: Metadata = {
  title: "Admin · Editar producto — Bellaroshé"
};

type EditarProductoPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditarProductoPage({ params }: EditarProductoPageProps) {
  const { id } = await params;

  return <ProductForm productId={id} />;
}
