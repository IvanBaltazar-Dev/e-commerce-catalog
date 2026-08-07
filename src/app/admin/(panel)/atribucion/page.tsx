import type { Metadata } from "next";
import { MarketingView } from "@/components/admin/MarketingView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Atribución — Bellaroshé" };

export default async function AtribucionPage() {
  await requirePanelRole(["admin", "developer"]);
  return <MarketingView initialTab="atribucion" />;
}
