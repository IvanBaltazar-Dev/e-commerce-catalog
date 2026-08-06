import type { Metadata } from "next";
import { CatalogV2ProductForm } from "@/components/admin/CatalogV2ProductForm";

export const metadata: Metadata = {
  title: "Admin · Nuevo producto — Bellaroshé"
};

type NuevoProductoPageProps = {
  searchParams: Promise<{ tipo?: string; usoAdhesivo?: string; contexto?: string }>;
};

export default async function NuevoProductoPage({ searchParams }: NuevoProductoPageProps) {
  const params = await searchParams;
  return (
    <CatalogV2ProductForm
      initialTypeKey={params.tipo}
      initialAttributeOptions={params.usoAdhesivo ? { adhesive_application: params.usoAdhesivo } : undefined}
      creationContext={params.contexto === "pestanas-sin-adhesivo" ? "strip-lash-adhesive" : undefined}
    />
  );
}
