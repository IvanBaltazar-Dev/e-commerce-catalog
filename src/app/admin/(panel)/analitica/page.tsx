import type { Metadata } from "next";
import { AnalyticsView } from "@/components/admin/AnalyticsView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Analítica — Bellaroshé" };

export default async function AnaliticaPage() {
  await requirePanelRole(["admin", "developer"]);
  return <AnalyticsView />;
}
