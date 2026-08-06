import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bellaroshé — Administración",
  description: "Gestiona el catálogo, precios y PDF de Importaciones Bellaroshé.",
  icons: {
    icon: [
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-512.png", sizes: "512x512", type: "image/png" }
    ],
    shortcut: [{ url: "/brand/favicon-32.png", type: "image/png" }],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
