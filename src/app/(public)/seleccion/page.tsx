import type { Metadata } from "next";
import { SelectionView } from "@/components/public/SelectionView";

export const metadata: Metadata = {
  title: "Mi selección — Catálogo Bellaroshé"
};

export default function SeleccionPage() {
  return <SelectionView />;
}
