/**
 * Contrato del tablero comercial (0043). El JSON llega en español porque la
 * base lo emite así: esta capa solo lo tipa, jamás lo recalcula.
 */

export type DashboardProductRow = {
  productoId: string;
  nombre: string;
  marca: string;
  unidades: number;
  ingreso: number;
};

export type DashboardToneRow = {
  varianteId: string;
  sku: string | null;
  producto: string;
  tono: string;
  unidades: number;
  ingreso: number;
};

export type DashboardMarginRow = {
  productoId: string;
  nombre: string;
  margen: number;
  ingresoValorizado: number;
  margenPorcentaje: number | null;
};

export type DashboardGroupRow = {
  categoriaId?: string;
  marcaId?: string;
  nombre: string;
  ingreso: number;
  margen: number | null;
};

export type DashboardChannelStats = {
  operaciones: number;
  ingreso: number;
  ticketPromedio: number | null;
};

export type DashboardCampaignRow = {
  campana: string;
  nombre: string;
  ventas: number;
  ingreso: number;
};

export type DashboardSellerRow = {
  vendedoraId: string | null;
  etiqueta: string;
  operaciones: number;
  ingreso: number;
};

export type DashboardSupplierRow = {
  proveedorId: string;
  nombre: string;
  recibidoPen: number;
  recepciones: number;
  variantesComparables: number;
  masBaratoEn: number;
};

export type BusinessDashboard = {
  rango: { desde: string; hasta: string; sedeId: string | null };
  ventas: {
    total: number;
    operaciones: number;
    unidades: number;
    ticketPromedio: number | null;
  };
  margen: {
    ingresos: number;
    ventasValorizadas: number;
    ventasSinCosto: number;
    margenBrutoValorizado: number;
    /** NULL cuando alguna venta del rango tiene costo desconocido (regla 16). */
    margenBruto: number | null;
    margenContribucion: number | null;
    gastosImputadosAVentas: number;
    gastosTotales: number;
    gastosRegistrados: number;
    utilidadNetaEstimada: number | null;
    razonNoCalculable: "ventas_sin_costo" | null;
  };
  devoluciones: { operaciones: number; total: number };
  anulaciones: { operaciones: number; total: number };
  reservas: {
    activas: number;
    activasTotal: number;
    vencidas: number;
    creadasEnRango: number;
    convertidasEnRango: number;
  };
  deudaProveedores: {
    moneda: string;
    total: number;
    vencida: number | null;
    obligaciones: number;
  }[];
  comprasPendientes: { moneda: string; ordenes: number; total: number }[];
  rankings: {
    productosPorUnidades: DashboardProductRow[];
    productosPorIngreso: DashboardProductRow[];
    tonosPorUnidades: DashboardToneRow[];
    productosPorMargen: DashboardMarginRow[];
    categorias: DashboardGroupRow[];
    marcas: DashboardGroupRow[];
    canales: Record<string, DashboardChannelStats>;
    campanas: DashboardCampaignRow[];
    vendedoras: DashboardSellerRow[];
    proveedores: DashboardSupplierRow[];
  };
};

/** Presets de fecha del plan: hoy, semana, 15 días, mes y rango libre. */
export type DashboardPreset = "hoy" | "semana" | "quincena" | "mes" | "rango";

export function presetRange(preset: Exclude<DashboardPreset, "rango">): { desde: string; hasta: string } {
  const today = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const back = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d;
  };
  switch (preset) {
    case "hoy":
      return { desde: iso(today), hasta: iso(today) };
    case "semana":
      return { desde: iso(back(6)), hasta: iso(today) };
    case "quincena":
      return { desde: iso(back(14)), hasta: iso(today) };
    case "mes":
      return { desde: iso(back(29)), hasta: iso(today) };
  }
}
