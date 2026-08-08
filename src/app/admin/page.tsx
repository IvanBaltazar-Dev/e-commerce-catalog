import { redirect } from "next/navigation";
import { panelRole } from "@/lib/auth/panel";

/**
 * No hay pantalla inicial universal: cada rol entra por donde trabaja.
 *
 * La propietaria entra a su Inicio, que es un centro de decisión. La vendedora
 * entra a Nueva venta, con el buscador enfocado — entra a vender, y hacerla
 * pasar por un tablero antes es tiempo que la clienta espera de pie.
 *
 * Antes esta ruta llevaba a /admin/productos/nuevo: la dueña aterrizaba en un
 * formulario de alta de productos.
 */
export default async function AdminIndexPage() {
  const role = await panelRole();
  if (!role) redirect("/admin/login?error=forbidden");
  redirect(role === "seller" ? "/admin/ventas" : "/admin/inicio");
}
