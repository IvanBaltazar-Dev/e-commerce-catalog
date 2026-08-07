import type { Metadata } from "next";
import { AssistantView } from "@/components/admin/AssistantView";
import { requirePanelRole } from "@/lib/auth/panel";

export const metadata: Metadata = { title: "Asistente — Bellaroshé" };

export default async function AsistentePage() {
  // La vendedora también dicta pedidos: el asistente es de todo el personal.
  await requirePanelRole(["admin", "developer", "seller"]);
  return <AssistantView />;
}
