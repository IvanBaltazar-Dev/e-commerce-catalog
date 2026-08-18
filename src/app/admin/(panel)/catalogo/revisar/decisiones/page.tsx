import type { Metadata } from "next";
import { CatalogRelationDecisionReviewView } from "@/components/admin/CatalogRelationDecisionReviewView";
import { getCatalogRelationDecisionQueue } from "@/lib/admin/catalog-relation-decision-service";
import { requirePanelContext } from "@/lib/auth/panel";

export const metadata: Metadata = {
  title: "Decisiones de relaciones · Bellaroshé",
};

export default async function CatalogRelationDecisionPage() {
  const { supabase } = await requirePanelContext(["admin", "developer"]);
  const initial = await getCatalogRelationDecisionQueue(supabase, { limit: 100 });
  return <CatalogRelationDecisionReviewView initial={initial} />;
}
