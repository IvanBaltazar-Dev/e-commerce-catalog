import { redirect } from "next/navigation";
import { requirePanelRole } from "@/lib/auth/panel";

export default async function LegacyCatalogImportPage() {
  await requirePanelRole(["admin", "developer"]);
  redirect("/admin/catalogo/revisar");
}
