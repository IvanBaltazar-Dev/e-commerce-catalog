import type { Metadata } from "next";
import { CatalogV2ProductForm } from "@/components/admin/CatalogV2ProductForm";

export const metadata: Metadata = {
  title: "Admin · Editar producto — Bellaroshé"
};

type EditarProductoPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditarProductoPage({ params }: EditarProductoPageProps) {
  const { id } = await params;

  return <CatalogV2ProductForm productId={id} />;
}
