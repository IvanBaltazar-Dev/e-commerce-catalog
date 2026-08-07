import type { Metadata } from "next";
import { ConversationsView } from "@/components/admin/ConversationsView";

export const metadata: Metadata = { title: "Conversaciones — Bellaroshé" };

export default function ConversacionesPage() {
  return <ConversationsView />;
}
