"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

type Rol = "admin" | "developer" | "seller";

type Entrada = {
  href: string;
  label: string;
  /** Sin esto, la entrada es de todo el personal. */
  soloAdmin?: boolean;
};

type Area = { id: string; label: string; entradas: Entrada[] };

// Ocho dominios en vez de trece entradas planas. Las URLs no se mueven: la
// caja sigue respondiendo en /admin/caja aunque se muestre dentro de Ventas, y
// marketing agrupa atribución, campañas y canales sobre sus rutas de siempre.
// Cambiar la arquitectura de información no obliga a cambiar la de rutas, y no
// hacerlo conserva enlaces guardados, pruebas y navegación existente.
//
// Agrupar además destapa dos pantallas que existían y no eran alcanzables
// desde la barra: campañas y canales.
const AREAS: Area[] = [
  {
    id: "ventas",
    label: "Ventas",
    entradas: [
      { href: "/admin/ventas", label: "Nueva venta" },
      // La caja es de la vendedora: es su cajón y ella lo abre, arquea y cierra.
      { href: "/admin/caja", label: "Caja" }
    ]
  },
  {
    id: "inventario",
    label: "Inventario",
    entradas: [
      { href: "/admin/inventario", label: "Existencias" },
      // D2 empieza donde acaba D1: es el mismo circuito, no otra área.
      { href: "/admin/reposicion", label: "Reposición" }
    ]
  },
  {
    id: "clientes",
    label: "Clientes",
    entradas: [
      // La bandeja omnicanal atiende WhatsApp, Instagram y Facebook desde el
      // mismo hilo, con su alcance recortado por la RLS.
      { href: "/admin/conversaciones", label: "Conversaciones" },
      { href: "/admin/carritos", label: "Carritos", soloAdmin: true }
    ]
  },
  {
    id: "catalogo",
    label: "Catálogo",
    entradas: [
      { href: "/admin/productos", label: "Productos", soloAdmin: true },
      { href: "/admin/catalogo/revisar", label: "Revisar", soloAdmin: true },
      // Estructura NO va aquí: /admin/estructura es un stub que redirige al
      // alta de productos, no una pantalla. Ofrecerla sería prometer algo que
      // deja al usuario en otro sitio sin explicación.
      { href: "/admin/pdf", label: "Catálogo PDF", soloAdmin: true }
    ]
  },
  {
    id: "compras",
    label: "Compras",
    entradas: [
      { href: "/admin/compras", label: "Órdenes", soloAdmin: true },
      { href: "/admin/gastos", label: "Gastos", soloAdmin: true }
    ]
  },
  {
    id: "marketing",
    label: "Marketing",
    entradas: [
      { href: "/admin/atribucion", label: "Atribución", soloAdmin: true },
      { href: "/admin/campanas", label: "Campañas", soloAdmin: true },
      { href: "/admin/canales", label: "Canales", soloAdmin: true }
    ]
  },
  {
    id: "analitica",
    label: "Analítica",
    entradas: [{ href: "/admin/analitica", label: "Tablero", soloAdmin: true }]
  },
  {
    id: "asistente",
    label: "Asistente",
    // El asistente (dictado, foto, asesora) es de todo el personal: propone, y
    // lo propuesto se registra por Ventas como siempre.
    entradas: [{ href: "/admin/asistente", label: "Asistente" }]
  }
];

function areasVisibles(role: Rol): Area[] {
  const esAdmin = role !== "seller";
  return AREAS
    .map((area) => ({
      ...area,
      entradas: area.entradas.filter((e) => {
        if (e.soloAdmin && !esAdmin) return false;
        return true;
      })
    }))
    // Un área sin entradas visibles no se muestra: la vendedora no debe ver
    // pantallas donde solo encontraría cero filas.
    .filter((area) => area.entradas.length > 0);
}

export function Topbar({ role }: { role: Rol }) {
  const pathname = usePathname();
  const router = useRouter();

  const areas = areasVisibles(role);
  const activa = areas.find((area) => area.entradas.some((e) => pathname.startsWith(e.href)));

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <div className="topbar">
      <div className="topbar-inner">
        {/* El logo es la vuelta a casa, convención universal. No se añade un
            área «Inicio»: son ocho dominios y el Inicio no es uno de ellos. */}
        <Link href={role === "seller" ? "/admin/ventas" : "/admin/inicio"} aria-label="Ir al inicio">
          <Image
            src="/brand/logo-sm.png"
            alt="Bellaroshé"
            width={72}
            height={44}
            className="topbar-logo"
            priority
          />
        </Link>
        <div className="topbar-title">Administración</div>
        <nav className="topbar-nav">
          {areas.map((area) => (
            <Link
              key={area.id}
              href={area.entradas[0].href}
              className={area.id === activa?.id ? "nav-pill nav-pill--active" : "nav-pill"}
            >
              {area.label}
            </Link>
          ))}
        </nav>
        <Link href="/" className="topbar-link" target="_blank">
          Ver catálogo ↗
        </Link>
        <button type="button" className="btn-ghost" onClick={handleLogout}>
          Salir
        </button>
      </div>

      {/* El segundo nivel solo aparece cuando el área tiene dónde profundizar:
          un área de una sola pantalla no necesita una barra que lo repita. */}
      {activa && activa.entradas.length > 1 ? (
        <div className="nav-subbar">
          <div className="nav-subbar-inner">
            {activa.entradas.map((entrada) => (
              <Link
                key={entrada.href}
                href={entrada.href}
                className={pathname.startsWith(entrada.href) ? "nav-sub nav-sub--active" : "nav-sub"}
              >
                {entrada.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
