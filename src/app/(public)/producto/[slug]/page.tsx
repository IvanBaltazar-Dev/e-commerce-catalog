import type { Metadata } from "next";
import { ProductView } from "@/components/public/ProductView";

export const metadata: Metadata = {
  title: "Producto — Catálogo Bellaroshé"
};

type ProductoPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function ProductoPage({ params }: ProductoPageProps) {
  const { slug } = await params;

  return <ProductView slug={slug} />;
}
