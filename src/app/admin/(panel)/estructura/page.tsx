import { redirect } from "next/navigation";
import { requirePanelRole } from "@/lib/auth/panel";

export default async function EstructuraPage() {
  await requirePanelRole(["admin", "developer"]);
  redirect("/admin/productos/nuevo");
}
