"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const SALES_ITEM = { href: "/admin/ventas", label: "Ventas" };

const NAV_ITEMS = [
  SALES_ITEM,
  { href: "/admin/productos", label: "Productos" },
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
  // La vendedora solo tiene caja: el catálogo y el PDF no son suyos.
  const navItems = role === "seller"
    ? [SALES_ITEM]
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
