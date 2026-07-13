import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeView } from "@/components/public/HomeView";

export const metadata: Metadata = {
  title: "Catálogo Bellaroshé — Esmaltes de marca por mayor y menor",
  description:
    "Esmaltes Masglo, Cherimoya, Mystyle y más, por unidad o por mayor desde 3 unidades. Importaciones Bellaroshé, Lima, Perú."
};

export default function CatalogoPage() {
  return (
    <Suspense fallback={null}>
      <HomeView />
    </Suspense>
  );
}
