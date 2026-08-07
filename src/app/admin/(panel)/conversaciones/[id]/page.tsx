import type { Metadata } from "next";
import { ConversationDetailView } from "@/components/admin/ConversationDetailView";

export const metadata: Metadata = { title: "Conversación — Bellaroshé" };

export default async function ConversacionPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConversationDetailView conversationId={id} />;
}
