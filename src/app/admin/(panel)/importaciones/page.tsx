import type { Metadata } from "next";
import { ImportacionesTabs } from "@/components/admin/ImportacionesTabs";
import { requireCatalogImportPage } from "@/lib/auth/catalog-import";

export const metadata: Metadata = {
  title: "Importaciones · Bellaroshé"
};

export default async function CatalogImportPage() {
  await requireCatalogImportPage();
  return <ImportacionesTabs />;
}
