import type { Metadata } from "next";
import { CatalogReviewView } from "@/components/admin/CatalogReviewView";
import { getCatalogReviewBootstrap } from "@/lib/admin/catalog-review-service";
import { requirePanelContext } from "@/lib/auth/panel";

export const metadata: Metadata = {
  title: "Revisar catálogo · Bellaroshé",
};

export default async function CatalogReviewPage() {
  const { supabase } = await requirePanelContext(["admin", "developer"]);
  const initial = await getCatalogReviewBootstrap(supabase);
  return <CatalogReviewView initial={initial} />;
}
