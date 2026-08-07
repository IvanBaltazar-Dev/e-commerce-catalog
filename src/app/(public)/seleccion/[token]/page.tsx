import type { Metadata } from "next";
import { CartRecoveryView } from "@/components/public/CartRecoveryView";

export const metadata: Metadata = {
  title: "Recuperando tu selección — Bellaroshé"
};

/**
 * Recuperación por enlace compartido: la clienta que armó su carrito en la
 * laptop lo abre en el celular con el mismo token. La adopción revalida
 * precio, stock y mayorista en el servidor; nada local se da por bueno.
 */
export default async function SeleccionTokenPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <CartRecoveryView token={token} />;
}
