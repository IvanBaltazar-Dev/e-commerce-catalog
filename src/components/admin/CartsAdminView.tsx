"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import { CART_STATUS_LABELS, CHANNEL_LABELS, type AdminCartSummary } from "@/lib/admin/omnichannel";
import { formatSoles } from "@/lib/public/catalog";

function shortDate(value: string) {
  return new Date(value).toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

/** Carritos del negocio: activos, abandonados, convertidos y vencidos. */
export function CartsAdminView() {
  const handleApiError = useApiError();
  const [items, setItems] = useState<AdminCartSummary[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await adminApi.listAdminCarts(status || undefined));
    } catch (error) {
      handleApiError(error, "No se pudieron cargar los carritos.");
    } finally {
      setLoading(false);
    }
  }, [status, handleApiError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Carritos</div>
          <div className="field-hint">
            El valor mostrado se reevalúa contra el motor comercial al momento de leer.
          </div>
        </div>
        <div className="conv-filters">
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(CART_STATUS_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <button type="button" className="btn-soft" onClick={load} disabled={loading}>Actualizar</button>
        </div>
      </div>

      <section className="form-card order-history">
        {loading ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando carritos…</div>
        ) : items.length === 0 ? (
          <div className="order-empty">No hay carritos con ese estado.</div>
        ) : (
          <div className="order-history-list">
            {items.map((cart) => (
              <div key={cart.id} className="sale-reservation">
                <span>
                  <b>{cart.channelCode ? CHANNEL_LABELS[cart.channelCode] ?? cart.channelCode : "—"}</b>
                  <small>
                    {cart.itemCount} línea(s) · {cart.totalUnits} unidad(es)
                    {cart.campaignCode ? ` · ${cart.campaignCode}` : ""}
                  </small>
                </span>
                <span>
                  <small>Última actividad</small>
                  {shortDate(cart.lastActivityAt)}
                </span>
                <span className="order-history-total">{formatSoles(cart.subtotal)}</span>
                <span className="sale-reservation-actions">
                  <span className={`order-status order-status--${cart.status === "converted" ? "completed" : cart.status === "active" ? "confirmed" : "cancelled"}`}>
                    {CART_STATUS_LABELS[cart.status]}
                  </span>
                  {cart.conversationId ? (
                    <Link className="btn-soft" href={`/admin/conversaciones/${cart.conversationId}`}>Conversación</Link>
                  ) : null}
                  <Link className="btn-soft" href={`/seleccion/${cart.publicToken}`} target="_blank">Ver ↗</Link>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
