"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const SALES_ITEM = { href: "/admin/ventas", label: "Ventas" };
// La caja es de la vendedora: es su cajón y ella lo abre, lo arquea y lo cierra.
const CASH_ITEM = { href: "/admin/caja", label: "Caja" };
// La bandeja omnicanal también es suya: atiende WhatsApp, Instagram y Facebook
// desde el mismo hilo, con su alcance recortado por la RLS.
const CONVERSATIONS_ITEM = { href: "/admin/conversaciones", label: "Conversaciones" };
// El asistente (dictado, foto, asesora) es de todo el personal: propone, y lo
// propuesto se registra por Ventas como siempre.
const ASSISTANT_ITEM = { href: "/admin/asistente", label: "Asistente" };

const NAV_ITEMS = [
  SALES_ITEM,
  CONVERSATIONS_ITEM,
  ASSISTANT_ITEM,
  CASH_ITEM,
  { href: "/admin/inventario", label: "Inventario" },
  { href: "/admin/carritos", label: "Carritos" },
  { href: "/admin/compras", label: "Compras" },
  { href: "/admin/gastos", label: "Gastos" },
  { href: "/admin/productos", label: "Productos" },
  { href: "/admin/analitica", label: "Analítica" },
  { href: "/admin/atribucion", label: "Marketing" },
  { href: "/admin/pdf", label: "Catálogo PDF" }
];

export function Topbar({
  role,
  importsEnabled
}: {
  role: "admin" | "developer" | "seller";
  importsEnabled: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // La vendedora opera venta, caja e inventario de sus sedes. El catálogo, los
  // gastos y el PDF no son suyos: la RLS ya se lo impide, y la barra no le
  // ofrece pantallas donde solo encontraría cero filas.
  const navItems = role === "seller"
    ? [SALES_ITEM, CONVERSATIONS_ITEM, ASSISTANT_ITEM, CASH_ITEM, { href: "/admin/inventario", label: "Inventario" }]
    : role === "developer" && importsEnabled
      ? [...NAV_ITEMS, { href: "/admin/importaciones", label: "Importaciones" }]
      : NAV_ITEMS;

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <Image
          src="/brand/logo-sm.png"
          alt="Bellaroshé"
          width={72}
          height={44}
          className="topbar-logo"
          priority
        />
        <div className="topbar-title">Administración</div>
        <nav className="topbar-nav">
          {navItems.map((item) => {
            const active = pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-pill nav-pill--active" : "nav-pill"}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <Link href="/" className="topbar-link" target="_blank">
          Ver catálogo ↗
        </Link>
        <button type="button" className="btn-ghost" onClick={handleLogout}>
          Salir
        </button>
      </div>
    </div>
  );
}
