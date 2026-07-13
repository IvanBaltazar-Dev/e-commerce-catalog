import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bellaroshé — Administración",
  description: "Gestiona el catálogo, precios y PDF de Importaciones Bellaroshé."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
