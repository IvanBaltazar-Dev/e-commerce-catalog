"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AdminApiError, adminApi } from "@/lib/admin/api";
import type {
  CatalogRelationDecision,
  CatalogRelationDecisionAction,
  CatalogRelationDecisionDetail,
  CatalogRelationDecisionPreview,
  CatalogRelationDecisionQueue,
} from "@/lib/admin/catalog-relation-decisions";

type Notice = { tone: "success" | "warning" | "error"; title: string; detail: string };

function Icon({ name }: { name: "arrow" | "back" | "check" | "clock" | "group" | "shield" | "spark" | "warning" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    back: <><path d="M19 12H5" /><path d="m10 17-5-5 5-5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    group: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-4 2-6 5-6s5 2 5 6" /><path d="M14 15c3-1 6 1 6 5" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z" /><path d="m9 12 2 2 4-5" /></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" /></>,
    warning: <><path d="M12 3 2.8 20h18.4z" /><path d="M12 9v5M12 17h.01" /></>,
  };
  return <svg className="rd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{paths[name]}</svg>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-PE").format(value);
}

function countLabel(value: number, singular: string, plural: string) {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-PE", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function familyLabel(family: CatalogRelationDecision["familyCode"]) {
  if (family === "CLASS_RULE_PROMOTION") return "Regla compartida";
  if (family === "ENDPOINT_SCOPE_RECLASSIFICATION") return "Alcance del grupo";
  return "Asociaciones incorrectas";
}

function historyLabel(code: string | null, eventType: string) {
  const labels: Record<string, string> = {
    ACCEPT_CLASS_RULE: "Regla compartida aceptada",
    REJECT_CLASS_RULE: "Regla compartida descartada",
    ACCEPT_MEMBERSHIP_SCOPE: "Nivel de la relación corregido",
    ADJUST_ENDPOINT_PROFILE: "Corrección solicitada",
    ACCEPT_FALSE_PAIR_RETIREMENT: "Asociaciones incorrectas retiradas",
    KEEP_DEFERRED: "Guardado para después",
    RESUME: "Caso reanudado",
    work_registered: "Caso creado",
    decision_taken: "Decisión confirmada",
    deferred: "Guardado para después",
    resumed: "Caso reanudado",
  };
  return labels[code ?? ""] ?? labels[eventType] ?? "Actividad registrada";
}

function NoticeBlock({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={`rd-notice rd-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <Icon name={notice.tone === "success" ? "check" : notice.tone === "warning" ? "warning" : "shield"} />
      <div><strong>{notice.title}</strong><p>{notice.detail}</p></div>
      <button type="button" onClick={onClose} aria-label="Cerrar mensaje">×</button>
    </div>
  );
}

function Impact({ preview }: { preview: CatalogRelationDecisionPreview }) {
  const impact = preview.impact;
  const values = [
    ["Asociaciones que se resolverán", Number(impact.candidateRowsChanged ?? 0)],
    ["Productos cuyo grupo se confirmará", Number(impact.classMembershipsConfirmed ?? impact.classMembershipRowsConfirmed ?? 0)],
    ["Reglas compartidas", Number(impact.classRulesCreated ?? 0)],
  ].filter(([, value]) => Number(value) > 0) as Array<[string, number]>;
  return (
    <div className="rd-preview-impact">
      {values.map(([label, value]) => <div key={label}><strong>{formatNumber(value)}</strong><span>{label}</span></div>)}
      <p><Icon name="shield" /> No cambia precio, stock ni publicación. No crea hechos canónicos.</p>
    </div>
  );
}

export function CatalogRelationDecisionReviewView({ initial }: { initial: CatalogRelationDecisionQueue }) {
  const [queue, setQueue] = useState(initial);
  const [current, setCurrent] = useState<CatalogRelationDecision | null>(null);
  const [detail, setDetail] = useState<CatalogRelationDecisionDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [selectedAction, setSelectedAction] = useState<CatalogRelationDecisionAction | null>(null);
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState<CatalogRelationDecisionPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [applyKey, setApplyKey] = useState<string | null>(null);
  const [deferKey, setDeferKey] = useState<string | null>(null);
  const [resumeKey, setResumeKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showDefer, setShowDefer] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [deferReason, setDeferReason] = useState("");
  const [deferMinutes, setDeferMinutes] = useState(1440);

  const activeActions = useMemo(
    () => current?.actions.filter((action) => action.code !== "KEEP_DEFERRED") ?? [],
    [current],
  );

  function resetDecision() {
    setSelectedAction(null);
    setComment("");
    setPreview(null);
    setPreviewKey(null);
    setApplyKey(null);
    setDeferKey(null);
    setResumeKey(null);
    setShowDefer(false);
    setConfirmBack(false);
    setDeferReason("");
    setDetail(null);
  }

  function openDecision(decision: CatalogRelationDecision) {
    resetDecision();
    setCurrent(decision);
    setNotice(null);
  }

  function leaveDecision() {
    setCurrent(null);
    resetDecision();
  }

  function requestLeaveDecision() {
    if (comment.trim() || deferReason.trim()) {
      setConfirmBack(true);
      return;
    }
    leaveDecision();
  }

  async function refresh(openFirst = false) {
    const next = await adminApi.getCatalogRelationDecisions("pending", 100, 0);
    setQueue(next);
    const nextCurrent = current
      ? next.decisions.find((decision) => decision.decisionId === current.decisionId) ?? null
      : null;
    setCurrent(openFirst ? next.decisions.find((decision) => !decision.isDeferred) ?? null : nextCurrent);
    resetDecision();
    return next;
  }

  function showError(error: unknown) {
    const stale = error instanceof AdminApiError && error.code === "catalog_relation_decision_stale";
    setNotice({
      tone: stale ? "warning" : "error",
      title: stale ? "El caso cambió mientras lo revisabas" : "No pudimos completar la operación",
      detail: stale
        ? "No aplicamos una pantalla antigua. Cargamos la versión vigente para que puedas revisarla de nuevo."
        : error instanceof Error ? error.message : "Ocurrió un error inesperado.",
    });
    if (stale) void refresh();
  }

  async function loadDetail() {
    if (!current || detail || detailBusy) return;
    setDetailBusy(true);
    try {
      setDetail(await adminApi.getCatalogRelationDecisionDetail(current.decisionId, 25, 0));
    } catch (error) {
      showError(error);
    } finally {
      setDetailBusy(false);
    }
  }

  async function prepareDecision() {
    if (!current || !selectedAction || busy) return;
    if (selectedAction.requiresComment && !comment.trim()) {
      setNotice({ tone: "warning", title: "Cuéntanos qué debería cambiar", detail: "Una nota breve permite corregir la propuesta sin perder el contexto." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const idempotencyKey = previewKey ?? crypto.randomUUID();
      setPreviewKey(idempotencyKey);
      const prepared = await adminApi.previewCatalogRelationDecision({
        decisionId: current.decisionId,
        actionCode: selectedAction.code,
        comment: comment.trim() || null,
        expectedWorkVersion: current.workVersion,
        idempotencyKey,
      });
      setPreview(prepared);
      setApplyKey((key) => key ?? crypto.randomUUID());
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function applyDecision() {
    if (!preview || !applyKey || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await adminApi.applyCatalogRelationDecision({
        previewId: preview.previewId,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: applyKey,
      });
      const next = await refresh(true);
      setNotice({
        tone: "success",
        title: "Decisión aplicada y verificada",
        detail: result.verification.passed
          ? `La decisión quedó guardada con su historial. ${countLabel(next.pending, "caso pendiente", "casos pendientes")}.`
          : "La decisión quedó registrada, pero aún necesita una verificación interna.",
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function deferDecision() {
    if (!current || !deferReason.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const idempotencyKey = deferKey ?? crypto.randomUUID();
      setDeferKey(idempotencyKey);
      const result = await adminApi.deferCatalogRelationDecision({
        decisionId: current.decisionId,
        expectedWorkVersion: current.workVersion,
        reason: deferReason.trim(), deferMinutes,
        idempotencyKey,
      });
      const next = await refresh(true);
      setNotice({
        tone: "success",
        title: "Anotado y guardado para después",
        detail: result.transition.deferredUntil
          ? `El caso sigue pendiente y volverá a estar disponible el ${formatDate(result.transition.deferredUntil)}. Quedan ${formatNumber(next.pending)} casos.`
          : "El caso sigue pendiente y conserva tu nota.",
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function resumeDecision() {
    if (!current || busy) return;
    setBusy(true);
    try {
      const idempotencyKey = resumeKey ?? crypto.randomUUID();
      setResumeKey(idempotencyKey);
      await adminApi.resumeCatalogRelationDecision({
        decisionId: current.decisionId,
        expectedWorkVersion: current.workVersion,
        idempotencyKey,
      });
      await refresh();
      setNotice({ tone: "success", title: "Caso reanudado", detail: "Ya puedes revisarlo y decidir con la información actual." });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function renderQueue() {
    return (
      <div className="rd-queue">
        <header className="rd-queue-head">
          <div>
            <Link href="/admin/catalogo/revisar" className="rd-back"><Icon name="back" /> Catálogo · Revisar</Link>
            <span className="rd-overline">Decisiones de relaciones</span>
            <h1>{countLabel(queue.pending, "decisión pendiente", "decisiones pendientes")}</h1>
            <p>Una causa compartida por caso. Revisa el problema, el cambio y qué pasará con los productos dudosos.</p>
          </div>
          <div className="rd-summary"><strong>{formatNumber(queue.total)}</strong><span>por decidir</span><small>{formatNumber(queue.deferred)} guardadas para después</small></div>
        </header>
        {notice ? <NoticeBlock notice={notice} onClose={() => setNotice(null)} /> : null}
        <section className="rd-list" aria-label="Cola de decisiones de relaciones">
          {queue.decisions.length ? queue.decisions.map((decision) => (
            <article className={`rd-list-card${decision.isDeferred ? " is-deferred" : ""}`} key={decision.decisionId}>
              <div className="rd-list-kind"><span>{familyLabel(decision.familyCode)}</span>{decision.isDeferred ? <small><Icon name="clock" /> Para después</small> : null}</div>
              <h2>{decision.title}</h2>
              <p>{decision.problem}</p>
              <div className="rd-list-counts"><span><b>{formatNumber(decision.affectedCount)}</b> {decision.affectedCount === 1 ? "asociación" : "asociaciones"}</span><span><b>{formatNumber(decision.affectedProductCount)}</b> {decision.affectedProductCount === 1 ? "producto" : "productos"}</span></div>
              <button type="button" onClick={() => openDecision(decision)}>Revisar <Icon name="arrow" /></button>
            </article>
          )) : <div className="rd-empty"><Icon name="check" /><h2>No quedan decisiones pendientes.</h2><p>Las nuevas aparecerán aquí cuando exista una causa compartida que requiera criterio humano.</p></div>}
        </section>
      </div>
    );
  }

  function renderDecision() {
    if (!current) return renderQueue();
    return (
      <div className="rd-decision-page">
        <header className="rd-topbar">
          <button type="button" className="rd-back" onClick={requestLeaveDecision}><Icon name="back" /> Volver a la cola</button>
          <span>{countLabel(queue.pending, "pendiente", "pendientes")}</span>
        </header>
        {notice ? <NoticeBlock notice={notice} onClose={() => setNotice(null)} /> : null}
        {confirmBack ? (
          <section className="rd-discard" role="alert">
            <div><strong>Tu texto todavía no está guardado.</strong><p>Puedes seguir editando o salir sin conservarlo.</p></div>
            <button type="button" onClick={() => setConfirmBack(false)}>Seguir editando</button>
            <button type="button" onClick={leaveDecision}>Salir sin guardar</button>
          </section>
        ) : null}
        <main className="rd-case">
          <header className="rd-case-head">
            <span className="rd-overline">{familyLabel(current.familyCode)}</span>
            <h1>{current.title}</h1>
            <div><span><Icon name="group" /> {countLabel(current.affectedCount, "asociación", "asociaciones")}</span><span>{countLabel(current.affectedProductCount, "producto", "productos")}</span></div>
          </header>

          <section className="rd-explanation">
            <article><span>Qué problema corrige</span><h2>{current.problem}</h2></article>
            <article className="rd-recommendation"><span>Qué recomendamos</span><h2>{current.recommendation}</h2></article>
            <article><span>Qué va a resolver</span><h2>{current.solves}</h2></article>
          </section>

          <section className="rd-uncertain"><Icon name="shield" /><div><strong>¿Y si no estamos seguros del tipo de un producto?</strong><p>{current.uncertainBehavior}</p></div></section>
          <p className="rd-no-commercial">{current.unchangedBusinessEffects}</p>

          {current.isDeferred ? (
            <section className="rd-deferred-card">
              <Icon name="clock" />
              <div><span>Guardado para después</span><strong>{current.deferReason}</strong><small>{current.deferredUntil ? `Volverá el ${formatDate(current.deferredUntil)}` : "Sin fecha"}</small></div>
              <button type="button" disabled={busy} onClick={resumeDecision}>{busy ? "Reanudando…" : "Reanudar ahora"}</button>
            </section>
          ) : (
            <section className="rd-action-panel">
              <header><span>Tu decisión</span><h2>{current.decisionQuestion}</h2></header>
              <div className="rd-actions">
                {activeActions.map((action, index) => (
                  <button
                    type="button"
                    key={action.code}
                    className={`${index === 0 ? "is-primary" : ""}${selectedAction?.code === action.code ? " is-selected" : ""}`}
                    onClick={() => { setSelectedAction(action); setPreview(null); setPreviewKey(null); setApplyKey(null); }}
                  >
                    <span>{selectedAction?.code === action.code ? <Icon name="check" /> : null}</span>
                    <div><strong>{action.label}</strong><small>{action.effect}</small></div>
                  </button>
                ))}
              </div>
              {selectedAction ? (
                <label className="rd-comment">
                  <span>{selectedAction.requiresComment ? "Cuéntanos qué debería cambiar" : "Comentario opcional"}</span>
                  <textarea value={comment} onChange={(event) => { setComment(event.target.value); setPreview(null); setPreviewKey(null); setApplyKey(null); }} maxLength={1000} placeholder={selectedAction.requiresComment ? "Ej.: este grupo mezcla productos con funciones distintas…" : "Puedes dejar una observación para el historial…"} />
                  <small>{comment.length}/1000</small>
                </label>
              ) : null}

              {preview ? (
                <section className="rd-confirm">
                  <div><span>Confirma el alcance</span><h3>{preview.confirmation.question}</h3><p>Se aplicará exactamente este conjunto. Si algo cambió desde que abriste el caso, el sistema se detendrá.</p></div>
                  <Impact preview={preview} />
                  <div className="rd-confirm-actions"><button type="button" onClick={() => setPreview(null)}>Volver</button><button type="button" disabled={busy || !applyKey} onClick={applyDecision}>{busy ? "Aplicando y verificando…" : "Confirmar decisión"}</button></div>
                </section>
              ) : (
                <div className="rd-action-footer">
                  <button type="button" className="rd-save-later" onClick={() => setShowDefer((value) => !value)}><Icon name="clock" /> Anotar y guardar pendiente</button>
                  <button type="button" className="rd-continue" disabled={!selectedAction || busy} onClick={prepareDecision}>{busy ? "Preparando…" : "Revisar el cambio antes de aplicar"}<Icon name="arrow" /></button>
                </div>
              )}

              {showDefer && !preview ? (
                <section className="rd-defer-form">
                  <div><span>No es un sí ni un no</span><h3>Anota qué falta y vuelve cuando tengas más información.</h3></div>
                  <label><span>Qué quieres comprobar</span><textarea value={deferReason} onChange={(event) => { setDeferReason(event.target.value); setDeferKey(null); }} maxLength={1000} placeholder="Ej.: revisar el envase o consultar la ficha de este grupo…" /></label>
                  <label><span>Volver a mostrar</span><select value={deferMinutes} onChange={(event) => { setDeferMinutes(Number(event.target.value)); setDeferKey(null); }}><option value={60}>En una hora</option><option value={1440}>Mañana</option><option value={10080}>En 7 días</option></select></label>
                  <button type="button" disabled={!deferReason.trim() || busy} onClick={deferDecision}>{busy ? "Guardando…" : "Guardar pendiente"}</button>
                </section>
              ) : null}
            </section>
          )}

          <details className="rd-evidence" onToggle={(event) => { if (event.currentTarget.open) void loadDetail(); }}>
            <summary><span><Icon name="shield" /> Ver productos, evidencia e historial</span><small>Solo si necesitas profundizar</small></summary>
            {detailBusy ? <p className="rd-loading">Cargando el expediente…</p> : detail ? (
              <div className="rd-evidence-body">
                <div className="rd-affected">
                  {detail.affected.map((item) => (
                    <article key={item.candidateId}>
                      <span>{item.position}</span>
                      <div><strong>{item.sourceProduct.name}</strong><small>con</small><strong>{item.targetProduct.name}</strong><p>{item.evidenceLabel}</p></div>
                      {item.needsTypeConfirmation ? <b>Confirmar tipo</b> : <b className="is-supported">Con respaldo</b>}
                    </article>
                  ))}
                  {detail.affectedTotal > detail.affected.length ? <p>Mostramos {detail.affected.length} de {detail.affectedTotal}. La decisión siempre conserva el conjunto completo.</p> : null}
                </div>
                <section className="rd-history"><h3>Historial</h3>{detail.history.map((event, index) => <div key={`${event.occurredAt}:${index}`}><span /><p><strong>{historyLabel(event.actionCode, event.eventType)}</strong><small>{event.actorLabel ?? "Sistema"} · {formatDate(event.occurredAt)}</small></p></div>)}</section>
              </div>
            ) : null}
          </details>
        </main>
      </div>
    );
  }

  return <div className="catalog-review-shell catalog-relation-decisions">{current ? renderDecision() : renderQueue()}</div>;
}
