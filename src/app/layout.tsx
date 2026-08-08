import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Manrope, autoalojada: única familia del sistema (panel, POS, catálogo público,
// ficha, login y nota de venta). Los cuatro pesos son los del pase de refinamiento
// aprobado — 400 cuerpo, 500 títulos y etiquetas, 600 UI y KPI, 700 una sola cifra
// protagonista por pantalla. Sin conexión a Google Fonts: next/font las empaqueta,
// versiona y precarga, y `swap` evita que el texto quede bloqueado.
//
// La reserva es 'Segoe UI' porque Manrope no trae ✓ ✗ → ←, y así esos glifos caen
// exactamente donde caían en los prototipos aprobados.
const manrope = localFont({
  src: [
    { path: "../fonts/manrope-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/manrope-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/manrope-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/manrope-700.woff2", weight: "700", style: "normal" }
  ],
  display: "swap",
  variable: "--font-sans",
  fallback: ["Segoe UI", "system-ui", "-apple-system", "sans-serif"]
});

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
    <html lang="es" className={manrope.variable}>
      <body>{children}</body>
    </html>
  );
}
