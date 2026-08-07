"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import {
  CHANNEL_LABELS,
  CONVERSATION_STATUS_LABELS,
  type ConversationSummary
} from "@/lib/admin/omnichannel";

function since(value: string) {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/**
 * Bandeja omnicanal. La RLS decide qué ve cada persona: la vendedora recibe
 * las conversaciones de sus sedes sin asignar o asignadas a ella. Los filtros
 * refinan; jamás amplían.
 */
export function ConversationsView() {
  const handleApiError = useApiError();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [assigned, setAssigned] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await adminApi.listConversations({
        status: status || undefined,
        channel: channel || undefined,
        assigned: assigned || undefined
      }));
    } catch (error) {
      handleApiError(error, "No se pudo cargar la bandeja.");
    } finally {
      setLoading(false);
    }
  }, [status, channel, assigned, handleApiError]);

  useEffect(() => {
    load();
    // La bandeja respira sola: cada 30 s sin que nadie pulse nada.
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Conversaciones</div>
          <div className="field-hint">Todos los canales en una bandeja. El estado comercial vive en su dominio.</div>
        </div>
        <div className="conv-filters">
          <select className="input" value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="">Todos los canales</option>
            {Object.entries(CHANNEL_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos los estados</option>
            {Object.entries(CONVERSATION_STATUS_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <select className="input" value={assigned} onChange={(event) => setAssigned(event.target.value)}>
            <option value="">Cualquier vendedora</option>
            <option value="me">Asignadas a mí</option>
            <option value="none">Sin asignar</option>
          </select>
          <button type="button" className="btn-soft" onClick={load} disabled={loading}>Actualizar</button>
        </div>
      </div>

      <section className="form-card order-history">
        {loading && items.length === 0 ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando bandeja…</div>
        ) : items.length === 0 ? (
          <div className="order-empty">No hay conversaciones con esos filtros.</div>
        ) : (
          <div className="order-history-list">
            {items.map((conversation) => (
              <Link key={conversation.id} href={`/admin/conversaciones/${conversation.id}`} className="conv-row">
                <span className={`conv-channel conv-channel--${conversation.channelCode}`}>
                  {CHANNEL_LABELS[conversation.channelCode] ?? conversation.channelCode}
                </span>
                <span className="conv-contact">
                  <b>{conversation.contactName ?? conversation.contactPhone ?? "Sin nombre"}</b>
                  <small>{since(conversation.lastActivityAt)}</small>
                </span>
                <span className="conv-assignee">
                  {conversation.assignedUserLabel ?? <em>Sin asignar</em>}
                </span>
                <span className="conv-badges">
                  {conversation.activeCartId ? <span className="conv-badge">🛒 carrito</span> : null}
                  {conversation.linkedReservationId ? <span className="conv-badge">reserva</span> : null}
                  {conversation.linkedSaleId ? <span className="conv-badge conv-badge--sale">venta</span> : null}
                </span>
                <span className={`order-status order-status--${conversation.status === "open" ? "confirmed" : conversation.status === "pending" ? "registered" : "completed"}`}>
                  {CONVERSATION_STATUS_LABELS[conversation.status]}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
