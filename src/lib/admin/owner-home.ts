import "server-only";
import { requireAdmin } from "@/lib/auth/admin";
import { addDays, iso, semanasCerradas, todayInLima, type Rango } from "@/lib/admin/semanas";

/**
 * Datos del Inicio de la propietaria (A1).
 *
 * No calcula ni un importe: llama a `business_dashboard`, que es el mismo
 * origen que usa Analítica. Eso no es pereza, es la regla de «un dato, un solo
 * dueño»: si Inicio calculara su propia ganancia bruta, tarde o temprano las
 * dos pantallas dirían cifras distintas y nadie sabría cuál creer.
 *
 * Los rangos van SIEMPRE explícitos —nunca `interval '7 days'`— porque una
 * semana es de lunes a domingo, siete días completos, y no una ventana móvil.
 */

export type { Rango } from "@/lib/admin/semanas";

export type DashboardSlice = {
  ventas: { total: number; unidades: number; operaciones: number; ticketPromedio: number | null };
  margen: { margenBruto: number; razonNoCalculable: string | null; ventasSinCosto: number };
  reservas: { activas: number; vencidas: number; activasTotal: number };
  rankings: {
    categorias: Array<{ nombre: string; total?: number; ingreso?: number }>;
    canales: Record<string, number>;
  };
  comprasPendientes: unknown[];
  deudaProveedores: unknown[];
};

export type Atencion = {
  nivel: "urgente" | "importante" | "atencion";
  titulo: string;
  detalle: string;
  accion: string;
  href: string;
};

export type OwnerHome = {
  fechas: { hoy: string; ayer: string; pasada: Rango; anterior: Rango };
  hoy: DashboardSlice;
  ayer: DashboardSlice;
  semanaPasada: DashboardSlice;
  semanaAnterior: DashboardSlice;
  cobradoHoy: number;
  atencion: Atencion[];
};

export async function loadOwnerHome(): Promise<OwnerHome> {
  const { supabase } = await requireAdmin();

  const hoy = todayInLima();
  const ayer = addDays(hoy, -1);
  const { pasada, anterior } = semanasCerradas(hoy);

  const pedir = async (desde: string, hasta: string): Promise<DashboardSlice> => {
    const { data, error } = await supabase.rpc("business_dashboard", {
      p_from: desde, p_to: hasta, p_branch_id: null
    });
    if (error) throw new Error(error.message);
    return data as DashboardSlice;
  };

  const [slHoy, slAyer, slPasada, slAnterior] = await Promise.all([
    pedir(iso(hoy), iso(hoy)),
    pedir(iso(ayer), iso(ayer)),
    pedir(pasada.desde, pasada.hasta),
    pedir(anterior.desde, anterior.hasta)
  ]);

  // Cobrado ≠ venta del día: son dos cosas y la especificación pide no
  // mezclarlas. Una venta a crédito suma a la venta y no al cobro.
  const { data: pagos } = await supabase
    .from("sale_payments")
    .select("amount, received_at")
    .gte("received_at", `${iso(hoy)}T00:00:00`)
    .lte("received_at", `${iso(hoy)}T23:59:59`);
  const cobradoHoy = (pagos ?? []).reduce((sum: number, fila: { amount: number | null }) => sum + Number(fila.amount ?? 0), 0);

  // Existencias por agotarse. «Bajo mínimo» es jerga: la dueña dice «por agotarse».
  const { data: bajas } = await supabase
    .from("inventory_position")
    .select("variant_id, available_quantity")
    .lte("available_quantity", 5)
    .limit(200);

  const atencion: Atencion[] = [];

  if (slHoy.reservas?.vencidas > 0) {
    atencion.push({
      nivel: "urgente",
      titulo: `${slHoy.reservas.vencidas} reserva(s) vencida(s)`,
      detalle: "Comprometen existencias que nadie está reteniendo ya.",
      accion: "Revisar",
      href: "/admin/ventas"
    });
  }

  const porAgotarse = (bajas ?? []).length;
  if (porAgotarse > 0) {
    atencion.push({
      nivel: "importante",
      titulo: `${porAgotarse} presentación(es) por agotarse`,
      detalle: "Cinco unidades o menos disponibles.",
      accion: "Reponer",
      href: "/admin/inventario"
    });
  }

  if ((slHoy.comprasPendientes ?? []).length > 0) {
    atencion.push({
      nivel: "importante",
      titulo: `${slHoy.comprasPendientes.length} compra(s) por recibir`,
      detalle: "Mercadería pagada o pedida que aún no entró al inventario.",
      accion: "Revisar",
      href: "/admin/compras"
    });
  }

  if ((slHoy.deudaProveedores ?? []).length > 0) {
    atencion.push({
      nivel: "atencion",
      titulo: `${slHoy.deudaProveedores.length} proveedor(es) con saldo`,
      detalle: "Obligaciones pendientes de pago.",
      accion: "Revisar",
      href: "/admin/compras"
    });
  }

  if (slHoy.reservas?.activas > 0) {
    atencion.push({
      nivel: "atencion",
      titulo: `${slHoy.reservas.activas} reserva(s) por atender`,
      detalle: "Vigentes: comprometen existencias sin descontarlas.",
      accion: "Atender",
      href: "/admin/ventas"
    });
  }

  const orden = { urgente: 0, importante: 1, atencion: 2 } as const;
  atencion.sort((a, b) => orden[a.nivel] - orden[b.nivel]);

  return {
    fechas: { hoy: iso(hoy), ayer: iso(ayer), pasada, anterior },
    hoy: slHoy,
    ayer: slAyer,
    semanaPasada: slPasada,
    semanaAnterior: slAnterior,
    cobradoHoy,
    atencion
  };
}
