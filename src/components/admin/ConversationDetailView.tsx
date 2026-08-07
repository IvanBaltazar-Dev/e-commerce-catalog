"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import {
  CART_STATUS_LABELS,
  CHANNEL_LABELS,
  CONVERSATION_STATUS_LABELS,
  type ConversationDetail
} from "@/lib/admin/omnichannel";
import { formatSoles } from "@/lib/public/catalog";

function messageTime(value: string) {
  return new Date(value).toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

/**
 * La conversación en tres columnas: quién es, qué se dijo, qué está comprando.
 * Diseñada para ser rápida para una vendedora: enviar es Enter, tomar es un
 * clic, y el contexto comercial vive al lado sin cambiar de pantalla.
 */
export function ConversationDetailView({ conversationId }: { conversationId: string }) {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await adminApi.getConversation(conversationId);
      setDetail(next);
    } catch (error) {
      handleApiError(error, "No se pudo abrir la conversación.");
    }
  }, [conversationId, handleApiError]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [detail?.messages.length]);

  async function act(action: Parameters<typeof adminApi.actOnConversation>[1], success: string) {
    if (busy) return;
    setBusy(true);
    try {
      setDetail(await adminApi.actOnConversation(conversationId, action));
      showToast(success);
    } catch (error) {
      handleApiError(error, "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    await act({ action: "send", body }, "Mensaje enviado ✓");
  }

  if (!detail) {
    return (
      <div className="form-page br-fade">
        <div className="order-loading"><span className="spinner spinner--pink" /> Abriendo conversación…</div>
      </div>
    );
  }

  const { conversation, contact, messages, cart, sale, reservation, events } = detail;

  return (
    <div className="form-page br-fade conv-detail-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">
            {contact.displayName ?? contact.phone ?? "Conversación"}
            <span className={`conv-channel conv-channel--${conversation.channelCode}`} style={{ marginLeft: 10 }}>
              {CHANNEL_LABELS[conversation.channelCode] ?? conversation.channelCode}
            </span>
          </div>
          <div className="field-hint">
            {CONVERSATION_STATUS_LABELS[conversation.status]} · {conversation.channelAccountName}
            {conversation.assignedUserLabel ? ` · Atiende ${conversation.assignedUserLabel}` : " · Sin asignar"}
          </div>
        </div>
        <div className="conv-actions">
          <Link href="/admin/conversaciones" className="btn-soft">← Bandeja</Link>
          {!conversation.assignedUserId ? (
            <button type="button" className="btn-save" disabled={busy}
              onClick={() => act({ action: "claim" }, "Conversación tomada ✓")}>
              Tomar
            </button>
          ) : null}
          {conversation.status === "open" || conversation.status === "pending" ? (
            <button type="button" className="btn-cancel" disabled={busy}
              onClick={() => {
                const reason = window.prompt("Motivo del cierre:", "Atendida");
                if (reason) void act({ action: "close", reason }, "Conversación cerrada ✓");
              }}>
              Cerrar
            </button>
          ) : null}
        </div>
      </div>

      <div className="conv-columns">
        {/* Columna 1: la clienta */}
        <section className="form-card conv-col">
          <div className="order-section-title">Clienta</div>
          <div className="conv-identity">
            <b>{contact.personName ?? contact.displayName ?? "Sin identificar"}</b>
            {contact.phone ? <span>📱 {contact.phone}</span> : null}
            {contact.username ? <span>@{contact.username}</span> : null}
            {contact.personId
              ? <small className="conv-linked">Vinculada a persona</small>
              : <small>Identidad de canal, aún sin vincular</small>}
          </div>

          <div className="order-section-title" style={{ marginTop: 16 }}>Actividad</div>
          <div className="conv-events">
            {events.slice(-8).map((event) => (
              <div key={event.id} className="conv-event">
                <span>{event.eventType}</span>
                <small>{event.sourceLabel ?? event.actorLabel ?? ""}</small>
              </div>
            ))}
          </div>
        </section>

        {/* Columna 2: la conversación */}
        <section className="form-card conv-col conv-col--thread">
          <div className="conv-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <div className="order-empty">Sin mensajes todavía.</div>
            ) : messages.map((message) => (
              <div key={message.id}
                className={message.direction === "outbound" ? "conv-bubble conv-bubble--out" : "conv-bubble"}>
                <p>{message.body ?? `[${message.messageType}]`}</p>
                <small>
                  {messageTime(message.receivedAt)}
                  {message.direction === "outbound"
                    ? ` · ${message.sentByLabel ?? "equipo"} · ${message.status}`
                    : ""}
                </small>
              </div>
            ))}
          </div>

          <div className="conv-composer">
            <textarea
              className="input textarea"
              value={draft}
              placeholder="Escribe la respuesta… (Enter envía)"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={busy || conversation.status === "closed" || conversation.status === "archived"}
            />
            <button type="button" className="btn-save" disabled={busy || !draft.trim()} onClick={send}>
              Enviar
            </button>
          </div>
        </section>

        {/* Columna 3: contexto de venta */}
        <section className="form-card conv-col">
          <div className="order-section-title">Contexto comercial</div>

          {cart ? (
            <div className="conv-context-block">
              <div className="conv-context-head">
                <b>Carrito {CART_STATUS_LABELS[cart.status]}</b>
                <span>{formatSoles(cart.subtotal)}</span>
              </div>
              {cart.lines.map((line, index) => (
                <div key={`${line.sku}-${index}`} className="conv-context-line">
                  <span>{line.quantity} × {line.productName} · {line.variantName}</span>
                  <b>{formatSoles(line.subtotal)}</b>
                </div>
              ))}
              <Link className="btn-soft conv-context-cta" href={`/seleccion/${cart.publicToken}`} target="_blank">
                Abrir selección ↗
              </Link>
            </div>
          ) : (
            <div className="order-empty">Sin carrito enlazado.</div>
          )}

          {reservation ? (
            <div className="conv-context-block">
              <div className="conv-context-head">
                <b>Reserva {reservation.reservationNumber}</b>
                <span>{formatSoles(reservation.total)}</span>
              </div>
              <small>{reservation.status}</small>
            </div>
          ) : null}

          {sale ? (
            <div className="conv-context-block conv-context-block--sale">
              <div className="conv-context-head">
                <b>Venta {sale.saleNumber}</b>
                <span>{formatSoles(sale.total)}</span>
              </div>
              <small>{sale.status === "confirmed" ? "Confirmada" : sale.status}</small>
            </div>
          ) : null}

          <div className="field-hint" style={{ marginTop: 12 }}>
            Para cobrar: la pantalla de <Link href="/admin/ventas">Ventas</Link> convierte
            el carrito con el motor del Bloque 2 — precio, stock y caja incluidos.
          </div>
        </section>
      </div>
    </div>
  );
}
