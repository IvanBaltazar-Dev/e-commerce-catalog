import type { Metadata } from "next";
import { CatalogV2ProductForm } from "@/components/admin/CatalogV2ProductForm";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = {
  title: "Admin · Editar producto — Bellaroshé"
};

type EditarProductoPageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditarProductoPage({ params }: EditarProductoPageProps) {
  await requirePanelRole(["admin", "developer"]);
  const { id } = await params;

  return <CatalogV2ProductForm productId={id} />;
}
