import Link from "next/link";
import type { Atencion, OwnerHome } from "@/lib/admin/owner-home";

/**
 * Mismo formato que el catálogo, pero calculado aquí: aquel vive en un módulo
 * "use client" y esta pantalla se pinta en el servidor.
 */
function formatSoles(value: number | null) {
  if (value === null) return "Consultar";
  const rounded = Math.round(value * 100) / 100;
  return `S/ ${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)}`;
}

/**
 * Inicio de la propietaria (A1): centro de decisión, no menú de módulos.
 *
 * Cuatro bloques y ni uno más: cómo va → qué necesita atención → qué quiero
 * hacer → qué funcionó. Ningún número aparece dos veces: Meta de hoy no repite
 * la venta ni la ganancia porque ya son KPI arriba; su trabajo es explicar el
 * día, no volver a anunciarlo.
 */

const FORMATO_LARGO = new Intl.DateTimeFormat("es-PE", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
});
const FORMATO_CORTO = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit", month: "2-digit", timeZone: "UTC"
});

const fechaLarga = (iso: string) => FORMATO_LARGO.format(new Date(`${iso}T00:00:00Z`));
const fechaCorta = (iso: string) => FORMATO_CORTO.format(new Date(`${iso}T00:00:00Z`));

/**
 * La variación de dinero va en SOLES, nunca en puntos porcentuales: «▲ S/ 68»
 * se entiende de un vistazo y «▲ 12 pp» obliga a calcular sobre cuánto.
 */
function Variacion({ hoy, ayer }: { hoy: number; ayer: number }) {
  const delta = Math.round((hoy - ayer) * 100) / 100;
  if (delta === 0) return <small className="home-kpi-delta">igual que ayer</small>;
  return (
    <small className={delta > 0 ? "home-kpi-delta home-kpi-delta--up" : "home-kpi-delta home-kpi-delta--down"}>
      {delta > 0 ? "▲" : "▼"} {formatSoles(Math.abs(delta))} vs. ayer
    </small>
  );
}

const ACCESOS = [
  { href: "/admin/ventas", label: "Nueva venta" },
  { href: "/admin/inventario", label: "Existencias" },
  { href: "/admin/compras", label: "Compras" },
  { href: "/admin/productos", label: "Productos" },
  { href: "/admin/conversaciones", label: "Conversaciones" },
  { href: "/admin/analitica", label: "Analítica" }
];

const SEMAFORO: Record<Atencion["nivel"], { punto: string; etiqueta: string }> = {
  urgente: { punto: "home-dot home-dot--urgente", etiqueta: "Urgente" },
  importante: { punto: "home-dot home-dot--importante", etiqueta: "Importante" },
  atencion: { punto: "home-dot home-dot--atencion", etiqueta: "Atención" }
};

export function OwnerHomeView({ data }: { data: OwnerHome }) {
  const { hoy, ayer, semanaPasada, semanaAnterior, fechas } = data;

  const gananciaCalculable = hoy.margen?.razonNoCalculable === null;
  const mejorCategoria = semanaPasada.rankings?.categorias?.[0];
  const canales = Object.entries(semanaPasada.rankings?.canales ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const mejorCanal = canales[0];

  const creceVenta = semanaPasada.ventas.total - semanaAnterior.ventas.total;

  return (
    <div className="form-page br-fade home-page">
      {/* ── 1. ¿Cómo va? ── */}
      <div className="form-head">
        <div>
          <div className="form-title">Hola, ¿cómo va hoy?</div>
          <div className="field-hint home-date">{fechaLarga(fechas.hoy)}</div>
        </div>
      </div>

      <div className="home-kpis">
        <div className="home-kpi">
          <span className="home-kpi-label">Venta hoy</span>
          <b>{formatSoles(hoy.ventas.total)}</b>
          <Variacion hoy={hoy.ventas.total} ayer={ayer.ventas.total} />
        </div>
        <div className="home-kpi">
          <span className="home-kpi-label">Ganancia bruta hoy</span>
          <b>{gananciaCalculable ? formatSoles(hoy.margen.margenBruto) : "—"}</b>
          {gananciaCalculable
            ? <Variacion hoy={hoy.margen.margenBruto} ayer={ayer.margen?.margenBruto ?? 0} />
            : <small className="home-kpi-delta">{hoy.margen?.razonNoCalculable}</small>}
        </div>
        <div className="home-kpi">
          <span className="home-kpi-label">Cobrado hoy</span>
          <b>{formatSoles(data.cobradoHoy)}</b>
          {/* Cobrado no es la venta ni el saldo de caja: son tres cosas. */}
          <small className="home-kpi-delta">lo que entró, no lo vendido</small>
        </div>
        <div className="home-kpi">
          <span className="home-kpi-label">Atención</span>
          <b>{data.atencion.length}</b>
          <small className="home-kpi-delta">
            {data.atencion.length === 0 ? "nada pendiente" : "asuntos por resolver"}
          </small>
        </div>
      </div>

      {/* ── 2. Dos paneles ── */}
      <div className="home-split">
        <section className="form-card">
          <div className="order-section-title">Cómo va el día</div>
          {hoy.ventas.operaciones === 0 ? (
            <div className="order-empty">Todavía no hay ventas hoy.</div>
          ) : (
            <dl className="home-facts">
              <div><dt>Operaciones</dt><dd>{hoy.ventas.operaciones}</dd></div>
              <div><dt>Unidades</dt><dd>{hoy.ventas.unidades}</dd></div>
              <div>
                <dt>Ticket promedio</dt>
                <dd>{hoy.ventas.ticketPromedio === null ? "—" : formatSoles(hoy.ventas.ticketPromedio)}</dd>
              </div>
            </dl>
          )}
          {/* Una meta diaria no se inventa: o la configura la dueña o no existe. */}
          <div className="home-goal">
            <span>Meta diaria</span>
            <small>Sin definir. Cuando exista, aquí saldrá cuánto falta y para cuánto.</small>
          </div>
        </section>

        <section className="form-card">
          <div className="order-section-title">Necesita tu atención</div>
          {data.atencion.length === 0 ? (
            <div className="order-empty">Nada pendiente. Buen momento.</div>
          ) : (
            <ul className="home-alerts">
              {data.atencion.map((item) => (
                <li key={`${item.nivel}-${item.titulo}`} className="home-alert">
                  <span className={SEMAFORO[item.nivel].punto} aria-label={SEMAFORO[item.nivel].etiqueta} />
                  <div className="home-alert-main">
                    <strong>{item.titulo}</strong>
                    <small>{item.detalle}</small>
                  </div>
                  {/* Cada aviso con su acción: enterarse sin poder resolver es peor que no enterarse. */}
                  <Link href={item.href} className="home-alert-action">{item.accion} →</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── 3. ¿Qué quieres hacer? ── */}
      <section className="form-card">
        <div className="order-section-title">¿Qué quieres hacer?</div>
        <div className="home-actions">
          {ACCESOS.map((acceso) => (
            <Link key={acceso.href} href={acceso.href} className="home-action">{acceso.label}</Link>
          ))}
        </div>
      </section>

      {/* ── 4. Lo que funcionó la semana pasada ── */}
      <section className="form-card">
        <div className="order-section-title">Lo que funcionó la semana pasada</div>
        <div className="field-hint">
          {fechaCorta(fechas.pasada.desde)}–{fechaCorta(fechas.pasada.hasta)} frente a{" "}
          {fechaCorta(fechas.anterior.desde)}–{fechaCorta(fechas.anterior.hasta)}. Semana cerrada, de lunes a domingo.
        </div>
        {semanaPasada.ventas.operaciones === 0 ? (
          <div className="order-empty">Esa semana no registró ventas.</div>
        ) : (
          <dl className="home-facts home-facts--wide">
            <div>
              <dt>Vendido</dt>
              <dd>
                {formatSoles(semanaPasada.ventas.total)}{" "}
                <small className={creceVenta >= 0 ? "home-kpi-delta home-kpi-delta--up" : "home-kpi-delta home-kpi-delta--down"}>
                  {creceVenta >= 0 ? "▲" : "▼"} {formatSoles(Math.abs(creceVenta))}
                </small>
              </dd>
            </div>
            <div><dt>Operaciones</dt><dd>{semanaPasada.ventas.operaciones}</dd></div>
            {mejorCategoria ? (
              <div><dt>Mejor categoría</dt><dd>{mejorCategoria.nombre}</dd></div>
            ) : null}
            {mejorCanal ? (
              <div><dt>Mejor canal</dt><dd>{mejorCanal[0]}</dd></div>
            ) : null}
          </dl>
        )}
      </section>
    </div>
  );
}
