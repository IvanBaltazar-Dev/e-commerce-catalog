"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const NAV_ITEMS = [
  { href: "/admin/productos", label: "Productos" },
  { href: "/admin/pdf", label: "Catálogo PDF" }
];

export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <Image
          src="/logo.png"
          alt="Bellaroshé"
          width={72}
          height={44}
          className="topbar-logo"
          priority
        />
        <div className="topbar-title">Administración</div>
        <nav className="topbar-nav">
          {NAV_ITEMS.map((item) => {
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
