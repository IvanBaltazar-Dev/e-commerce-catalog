import type { Metadata } from "next";
import { PdfView } from "@/components/admin/PdfView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = {
  title: "Admin · Catálogo PDF — Bellaroshé"
};

export default async function PdfPage() {
  await requirePanelRole(["admin", "developer"]);
  return <PdfView />;
}
