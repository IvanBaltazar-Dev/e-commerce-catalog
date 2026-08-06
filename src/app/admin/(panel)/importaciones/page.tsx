import type { Metadata } from "next";
import { CatalogImportView } from "@/components/admin/CatalogImportView";
import { requireCatalogImportPage } from "@/lib/auth/catalog-import";

export const metadata: Metadata = {
  title: "Importaciones · Bellaroshé"
};

export default async function CatalogImportPage() {
  await requireCatalogImportPage();
  return <CatalogImportView />;
}
