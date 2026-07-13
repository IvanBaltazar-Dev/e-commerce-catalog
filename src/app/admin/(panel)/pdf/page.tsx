import type { Metadata } from "next";
import { PdfView } from "@/components/admin/PdfView";

export const metadata: Metadata = {
  title: "Admin · Catálogo PDF — Bellaroshé"
};

export default function PdfPage() {
  return <PdfView />;
}
