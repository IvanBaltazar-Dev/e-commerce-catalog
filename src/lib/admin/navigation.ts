// Arquitectura de información del panel. Vive aquí, no dentro de un componente,
// porque es información y no presentación: la misma lista alimenta el panel
// lateral, su cajón móvil y cualquier prueba que recorra las rutas. Cuando la
// navegación cambia de forma, esto no se toca.
//
// Ocho dominios en vez de trece entradas planas. Las URLs no se mueven: la caja
// sigue respondiendo en /admin/caja aunque se muestre dentro de Ventas, y
// marketing agrupa atribución, campañas y canales sobre sus rutas de siempre.
// Cambiar la arquitectura de información no obliga a cambiar la de rutas, y no
// hacerlo conserva enlaces guardados, pruebas y navegación existente.

export type PanelRole = "admin" | "developer" | "seller";

export type NavEntry = {
  href: string;
  label: string;
  soloAdmin?: boolean;
};

export type NavArea = {
  id: string;
  label: string;
  entradas: NavEntry[];
};

export const AREAS: NavArea[] = [
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

// Un área sin entradas visibles no se muestra: la vendedora no debe ver
// pantallas donde solo encontraría cero filas, ni un dominio que al abrirse
// esté vacío.
export function areasVisibles(role: PanelRole): NavArea[] {
  const esAdmin = role !== "seller";
  return AREAS
    .map((area) => ({
      ...area,
      entradas: area.entradas.filter((entrada) => !(entrada.soloAdmin && !esAdmin))
    }))
    .filter((area) => area.entradas.length > 0);
}

export function inicioSegunRol(role: PanelRole): string {
  return role === "seller" ? "/admin/ventas" : "/admin/inicio";
}

export function areaActiva(areas: NavArea[], pathname: string): NavArea | undefined {
  return areas.find((area) => area.entradas.some((entrada) => pathname.startsWith(entrada.href)));
}
