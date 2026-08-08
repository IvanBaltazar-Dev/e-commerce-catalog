"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch } from "@/lib/admin/api";
import {
  presetRange,
  type BusinessDashboard,
  type DashboardPreset
} from "@/lib/admin/analytics";
import { CHANNEL_LABELS } from "@/lib/admin/omnichannel";
import { formatSoles } from "@/lib/public/catalog";

/** Etiquetas del canal de ORIGEN de la venta (sale_source_channel), que no
 *  coincide 1:1 con los canales omnicanal: la tienda física no conversa. */
const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  in_store: "Tienda",
  web: "Web",
  phone: "Teléfono",
  other: "Otro"
};

const PRESETS: { id: DashboardPreset; label: string }[] = [
  { id: "hoy", label: "Hoy" },
  { id: "semana", label: "Semana" },
  { id: "quincena", label: "15 días" },
  { id: "mes", label: "Mes" },
  { id: "rango", label: "Rango" }
];

function money(currency: string, value: number) {
  if (currency === "PEN") return formatSoles(value);
  return `${currency} ${new Intl.NumberFormat("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)}`;
}

/**
 * El tablero comercial del Bloque 4. Cada número viene de business_dashboard
 * (0043): esta vista formatea y jamás recalcula. Cuando la base dice NULL
 * —costo desconocido— aquí se lee «no calculable», nunca un cero disfrazado.
 */
export function AnalyticsView() {
  const handleApiError = useApiError();

  const [preset, setPreset] = useState<DashboardPreset>("mes");
  const [desde, setDesde] = useState(() => presetRange("mes").desde);
  const [hasta, setHasta] = useState(() => presetRange("mes").hasta);
  const [sede, setSede] = useState<string>("");
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [dashboard, setDashboard] = useState<BusinessDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range: { desde: string; hasta: string }, branchId: string) => {
    setLoading(true);
    try {
      const data = await adminApi.getDashboard({
        desde: range.desde,
        hasta: range.hasta,
        sede: branchId || undefined
      });
      setDashboard(data);
    } catch (error) {
      handleApiError(error, "No se pudo cargar el tablero.");
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    adminApi.listOperableBranches().then(setBranches).catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    load({ desde, hasta }, sede);
    // Recarga al cambiar el rango efectivo o la sede; el preset solo mueve fechas.
  }, [desde, hasta, sede, load]);

  function applyPreset(next: DashboardPreset) {
    setPreset(next);
    if (next !== "rango") {
      const range = presetRange(next);
      setDesde(range.desde);
      setHasta(range.hasta);
    }
  }

  const margen = dashboard?.margen;
  const sinGastos = (margen?.gastosRegistrados ?? 0) === 0;

  const canales = useMemo(
    () => Object.entries(dashboard?.rankings.canales ?? {}).sort((a, b) => b[1].ingreso - a[1].ingreso),
    [dashboard]
  );

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Analítica comercial</div>
          <div className="field-hint">
            Cada cifra nace de ventas, costos y gastos reales. Lo no calculable se dice, no se inventa.
          </div>
        </div>
        <div className="order-delivery order-tabs" style={{ margin: 0, gridTemplateColumns: "repeat(5, 1fr)" }}>
          {PRESETS.map((option) => (
            <button key={option.id} type="button"
              className={preset === option.id ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"}
              onClick={() => applyPreset(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <section className="form-card">
        <div className="order-customer-fields" style={{ gridTemplateColumns: "1fr 1fr 1.4fr" }}>
          <label><span>Desde</span>
            <input className="input" type="date" value={desde} max={hasta}
              onChange={(event) => { setPreset("rango"); setDesde(event.target.value); }} />
          </label>
          <label><span>Hasta</span>
            <input className="input" type="date" value={hasta} min={desde}
              onChange={(event) => { setPreset("rango"); setHasta(event.target.value); }} />
          </label>
          <label><span>Sede</span>
            <select className="input" value={sede} onChange={(event) => setSede(event.target.value)}>
              <option value="">Todas las sedes</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {loading ? (
        <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
      ) : null}

      {!loading && dashboard ? (
        <>
          <section className="form-card">
            <div className="order-section-title">Resultado del periodo</div>
            <div className="metric-grid">
              <div className="metric-tile">
                <small>Total vendido</small>
                <b>{formatSoles(dashboard.ventas.total)}</b>
                <span>{dashboard.ventas.operaciones} operación(es)</span>
              </div>
              <div className="metric-tile">
                <small>Unidades</small>
                <b>{dashboard.ventas.unidades}</b>
                <span>ticket {dashboard.ventas.ticketPromedio == null ? "—" : formatSoles(dashboard.ventas.ticketPromedio)}</span>
              </div>
              <div className="metric-tile">
                <small>Margen bruto</small>
                <b>{margen?.margenBruto == null ? "No calculable" : formatSoles(margen.margenBruto)}</b>
                <span>
                  {margen?.margenBruto == null
                    ? `${margen?.ventasSinCosto ?? 0} venta(s) sin costo conocido · valorizado ${formatSoles(margen?.margenBrutoValorizado ?? 0)}`
                    : `${margen.ventasValorizadas} venta(s) valorizadas`}
                </span>
              </div>
              <div className="metric-tile">
                <small>Margen de contribución</small>
                <b>{margen?.margenContribucion == null ? "—" : formatSoles(margen.margenContribucion)}</b>
                <span>gastos imputados {formatSoles(margen?.gastosImputadosAVentas ?? 0)}</span>
              </div>
              <div className="metric-tile">
                <small>Gastos del periodo</small>
                <b>{formatSoles(margen?.gastosTotales ?? 0)}</b>
                <span>{margen?.gastosRegistrados ?? 0} registrado(s)</span>
              </div>
              <div className="metric-tile">
                <small>Utilidad neta estimada</small>
                <b>{margen?.utilidadNetaEstimada == null ? "No calculable" : formatSoles(margen.utilidadNetaEstimada)}</b>
                <span>
                  {margen?.utilidadNetaEstimada == null
                    ? "hay ventas con costo desconocido"
                    : sinGastos
                      ? "sin gastos registrados en el periodo"
                      : "margen bruto − todos los gastos registrados"}
                </span>
              </div>
            </div>
          </section>

          <section className="form-card">
            <div className="order-section-title">Salidas y compromisos</div>
            <div className="metric-grid">
              <div className="metric-tile">
                <small>Devoluciones</small>
                <b>{formatSoles(dashboard.devoluciones.total)}</b>
                <span>{dashboard.devoluciones.operaciones} operación(es)</span>
              </div>
              <div className="metric-tile">
                <small>Anulaciones</small>
                <b>{formatSoles(dashboard.anulaciones.total)}</b>
                <span>{dashboard.anulaciones.operaciones} operación(es)</span>
              </div>
              <div className="metric-tile">
                <small>Reservas activas</small>
                <b>{formatSoles(dashboard.reservas.activasTotal)}</b>
                <span>{dashboard.reservas.activas} activa(s) · {dashboard.reservas.convertidasEnRango} convertida(s) en el rango</span>
              </div>
              {dashboard.deudaProveedores.length === 0 ? (
                <div className="metric-tile">
                  <small>Deuda con proveedores</small>
                  <b>{formatSoles(0)}</b>
                  <span>sin obligaciones pendientes</span>
                </div>
              ) : dashboard.deudaProveedores.map((debt) => (
                <div key={debt.moneda} className="metric-tile">
                  <small>Deuda proveedores · {debt.moneda}</small>
                  <b>{money(debt.moneda, debt.total)}</b>
                  <span>vencida {money(debt.moneda, debt.vencida ?? 0)} · {debt.obligaciones} obligación(es)</span>
                </div>
              ))}
              {dashboard.comprasPendientes.length === 0 ? (
                <div className="metric-tile">
                  <small>Compras pendientes</small>
                  <b>0</b>
                  <span>nada por recibir</span>
                </div>
              ) : dashboard.comprasPendientes.map((purchase) => (
                <div key={purchase.moneda} className="metric-tile">
                  <small>Compras pendientes · {purchase.moneda}</small>
                  <b>{money(purchase.moneda, purchase.total)}</b>
                  <span>{purchase.ordenes} orden(es) por recibir</span>
                </div>
              ))}
            </div>
          </section>

          <section className="form-card">
            <div className="order-section-title">Lo que más se vende</div>
            <div className="rank-grid">
              <div className="rank-card">
                <div className="rank-title">Productos por unidades</div>
                {dashboard.rankings.productosPorUnidades.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.productosPorUnidades.map((row, index) => (
                      <tr key={row.productoId}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.nombre}<small>{row.marca}</small></td>
                        <td className="rank-num">{row.unidades} u.</td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Mayor facturación</div>
                {dashboard.rankings.productosPorIngreso.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.productosPorIngreso.map((row, index) => (
                      <tr key={row.productoId}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.nombre}<small>{row.marca}</small></td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Tonos más vendidos</div>
                {dashboard.rankings.tonosPorUnidades.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.tonosPorUnidades.map((row, index) => (
                      <tr key={row.varianteId}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.tono}<small>{row.producto}</small></td>
                        <td className="rank-num">{row.unidades} u.</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Mayor margen (costo conocido)</div>
                {dashboard.rankings.productosPorMargen.length === 0 ? (
                  <div className="order-empty">Sin líneas valorizadas.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.productosPorMargen.map((row, index) => (
                      <tr key={row.productoId}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.nombre}</td>
                        <td className="rank-num">{formatSoles(row.margen)}</td>
                        <td className="rank-num">{row.margenPorcentaje == null ? "—" : `${row.margenPorcentaje}%`}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Categorías</div>
                {dashboard.rankings.categorias.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.categorias.map((row, index) => (
                      <tr key={row.categoriaId ?? row.nombre}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.nombre}</td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                        <td className="rank-num">{row.margen == null ? "—" : formatSoles(row.margen)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Marcas</div>
                {dashboard.rankings.marcas.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.marcas.map((row, index) => (
                      <tr key={row.marcaId ?? row.nombre}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.nombre}</td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                        <td className="rank-num">{row.margen == null ? "—" : formatSoles(row.margen)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          </section>

          <section className="form-card">
            <div className="order-section-title">Quién y por dónde</div>
            <div className="rank-grid">
              <div className="rank-card">
                <div className="rank-title">Canales</div>
                {canales.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {canales.map(([channel, stats]) => (
                      <tr key={channel}>
                        <td>{SOURCE_CHANNEL_LABELS[channel] ?? CHANNEL_LABELS[channel] ?? channel}</td>
                        <td className="rank-num">{stats.operaciones} op.</td>
                        <td className="rank-num">{formatSoles(stats.ingreso)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Campañas (primer toque)</div>
                {dashboard.rankings.campanas.length === 0 ? (
                  <div className="order-empty">Sin ventas atribuidas a campañas.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.campanas.map((row) => (
                      <tr key={row.campana}>
                        <td>{row.nombre}<small>{row.campana}</small></td>
                        <td className="rank-num">{row.ventas} venta(s)</td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Vendedoras</div>
                {dashboard.rankings.vendedoras.length === 0 ? (
                  <div className="order-empty">Sin ventas en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.vendedoras.map((row, index) => (
                      <tr key={row.vendedoraId ?? row.etiqueta}>
                        <td className="rank-pos">{index + 1}</td>
                        <td>{row.etiqueta}</td>
                        <td className="rank-num">{row.operaciones} op.</td>
                        <td className="rank-num">{formatSoles(row.ingreso)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>

              <div className="rank-card">
                <div className="rank-title">Proveedores</div>
                {dashboard.rankings.proveedores.length === 0 ? (
                  <div className="order-empty">Sin recepciones en el rango.</div>
                ) : (
                  <table className="rank-table"><tbody>
                    {dashboard.rankings.proveedores.map((row) => (
                      <tr key={row.proveedorId}>
                        <td>
                          {row.nombre}
                          <small>
                            {row.variantesComparables > 0
                              ? `más barato en ${row.masBaratoEn} de ${row.variantesComparables} comparable(s)`
                              : "sin variantes comparables"}
                          </small>
                        </td>
                        <td className="rank-num">{formatSoles(row.recibidoPen)}</td>
                        <td className="rank-num">{row.recepciones} recep.</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
