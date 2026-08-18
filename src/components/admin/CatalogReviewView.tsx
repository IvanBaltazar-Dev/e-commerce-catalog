"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminApiError, adminApi, publicAssetUrl, uploadCatalogImage } from "@/lib/admin/api";
import type {
  CatalogReviewBootstrap,
  CatalogReviewCase,
  CatalogReviewEvidence,
  CatalogReviewOption,
  CatalogReviewTarget,
} from "@/lib/admin/catalog-review";

type Screen = "home" | "review" | "dossier";
type Notice = { tone: "success" | "warning" | "error"; title: string; detail: string };

function Icon({ name }: { name: "arrow" | "back" | "check" | "clock" | "external" | "folder" | "history" | "image" | "shield" | "spark" | "warning" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    back: <><path d="M19 12H5" /><path d="m10 17-5-5 5-5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v6H5V6h6" /></>,
    folder: <><path d="M3 7h7l2 2h9v10H3z" /><path d="M3 7V5h7l2 2" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v6h6" /><path d="M12 7v5l3 2" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="16" cy="9" r="1.5" /><path d="m3 16 5-5 4 4 3-3 6 6" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z" /><path d="m9 12 2 2 4-5" /></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" /></>,
    warning: <><path d="M12 3 2.8 20h18.4z" /><path d="M12 9v5M12 17h.01" /></>,
  };
  return <svg className="cr-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{paths[name]}</svg>;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-PE").format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function evidenceImage(caseItem: CatalogReviewCase) {
  return caseItem.evidence.find((item) => item.kind === "image") ?? null;
}

function evidenceFact(caseItem: CatalogReviewCase, id: string) {
  return caseItem.evidence.find((item) => item.id === id)?.value ?? null;
}

function Visual({ url, label, tone = "paper" }: { url: string | null | undefined; label: string; tone?: "paper" | "rose" }) {
  if (url) {
    return (
      <div
        className="cr-visual cr-visual--image"
        role="img"
        aria-label={label}
        style={{ backgroundImage: `url("${url.replaceAll('"', "%22")}")` }}
      />
    );
  }
  return <div className={`cr-visual cr-visual--${tone}`} aria-label={`${label}, sin imagen`}><span>{label.slice(0, 2).toUpperCase()}</span><small>Sin imagen verificada</small></div>;
}

function Metric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "rose" | "sand" | "blue" | "green" }) {
  return (
    <article className={`cr-metric cr-metric--${tone}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
      <small>{detail}</small>
    </article>
  );
}

function NoticeBlock({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={`cr-notice cr-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span className="cr-notice-icon"><Icon name={notice.tone === "success" ? "check" : notice.tone === "warning" ? "warning" : "shield"} /></span>
      <div><strong>{notice.title}</strong><p>{notice.detail}</p></div>
      <button type="button" onClick={onClose} aria-label="Cerrar mensaje">×</button>
    </div>
  );
}

function EvidenceCard({ item }: { item: CatalogReviewEvidence }) {
  if (item.kind === "image") {
    return (
      <article className="cr-evidence cr-evidence--image">
        <Visual url={item.imageUrl} label={item.value} />
        <div><span>{item.label}</span><strong>{item.value}</strong>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">Ver fuente <Icon name="external" /></a> : null}</div>
      </article>
    );
  }
  return (
    <article className={`cr-evidence cr-evidence--${item.kind}`}>
      <span>{item.label}</span>
      <strong>{item.value}</strong>
      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">Abrir fuente <Icon name="external" /></a> : null}
    </article>
  );
}

function IdentityComparison({ caseItem }: { caseItem: CatalogReviewCase }) {
  const officialImage = evidenceImage(caseItem);
  const officialTitle = evidenceFact(caseItem, "official-title") ?? officialImage?.value ?? "Registro oficial candidato";
  const officialLine = evidenceFact(caseItem, "official-line");
  const recordFacts = caseItem.entity.facts.filter((fact) => fact.group === "record");
  const catalogFacts = caseItem.entity.facts.filter((fact) => fact.group === "catalog");
  const source = caseItem.entity.sourceSnapshot;
  return (
    <div className="cr-compare" aria-label="Comparación de identidad">
      <article className="cr-compare-card cr-compare-card--internal">
        <div className="cr-compare-label"><span>En Bellaroshé</span><small>Registro interno</small></div>
        <div className="cr-internal-hero">
          <Visual url={caseItem.entity.imageUrl} label={caseItem.entity.name} tone="rose" />
          <div className="cr-compare-copy">
            <span className="cr-entity-kind">{caseItem.entity.type}</span>
            <strong>{caseItem.entity.name}</strong>
            <p>{caseItem.entity.description ?? [caseItem.entity.brand, caseItem.entity.code].filter(Boolean).join(" · ")}</p>
            <div className="cr-identity-chips">
              {recordFacts.map((fact) => <span key={fact.label}><small>{fact.label}</small><b>{fact.value}</b></span>)}
            </div>
          </div>
        </div>
        <details className="cr-internal-section cr-internal-details">
          <summary><span>Ver datos internos</span><small>{catalogFacts.length} campos</small></summary>
          <dl className="cr-internal-facts">
            {catalogFacts.map((fact) => (
              <div className={fact.status ? `is-${fact.status}` : undefined} key={fact.label}>
                <dt>{fact.label}</dt><dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </details>
        {source ? (
          <section className="cr-internal-section cr-internal-section--source">
            <header>
              <span>Fila original del Excel normalizado</span>
              <small>{source.sheet}{source.rowNumber ? ` · fila ${source.rowNumber}` : ""}</small>
            </header>
            <p className="cr-source-file">{source.fileName}</p>
            <dl className="cr-internal-facts">
              {source.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
            </dl>
          </section>
        ) : null}
      </article>
      <div className="cr-compare-mark" aria-hidden="true">?</div>
      <article className="cr-compare-card">
        <div className="cr-compare-label"><span>En la fuente</span><small>Registro externo</small></div>
        <Visual url={officialImage?.imageUrl} label={officialTitle} />
        <div className="cr-compare-copy">
          <strong>{officialTitle}</strong>
          <p>{officialLine ?? "Línea no informada"}</p>
          {officialImage?.url ? <a href={officialImage.url} target="_blank" rel="noreferrer">Abrir ficha oficial <Icon name="external" /></a> : null}
        </div>
      </article>
    </div>
  );
}

function DecisionScope({ caseItem }: { caseItem: CatalogReviewCase }) {
  return (
    <section className="cr-scope" aria-label="Alcance exacto de la decisión">
      <div className="cr-scope-main">
        <span><Icon name="shield" /> Qué estás decidiendo</span>
        <strong>{caseItem.decisionScope.resolves}</strong>
      </div>
      <details>
        <summary>Ver exactamente qué cambia y qué seguirá pendiente</summary>
        <div className="cr-scope-effects">
          <p><b>Si confirmas</b>{caseItem.decisionScope.approveEffect}</p>
          <p><b>Si rechazas</b>{caseItem.decisionScope.rejectEffect}</p>
        </div>
        <ul>{caseItem.decisionScope.doesNotResolve.map((item) => <li key={item}>{item}</li>)}</ul>
      </details>
    </section>
  );
}

function OptionButton({ option, selected, onSelect }: { option: CatalogReviewOption; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`cr-option cr-option--${option.tone}${selected ? " cr-option--selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="cr-option-radio">{selected ? <Icon name="check" /> : null}</span>
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
    </button>
  );
}

export function CatalogReviewView({ initial }: { initial: CatalogReviewBootstrap }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [bootstrap, setBootstrap] = useState(initial);
  const [caseItem, setCaseItem] = useState<CatalogReviewCase | null>(initial.nextCase);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetResults, setTargetResults] = useState<CatalogReviewTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<CatalogReviewTarget | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceNotes, setReferenceNotes] = useState("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showDefer, setShowDefer] = useState(false);
  const [deferReason, setDeferReason] = useState("");
  const [deferMinutes, setDeferMinutes] = useState(1440);
  const [sessionDecisions, setSessionDecisions] = useState(0);
  const [sessionUnlocks, setSessionUnlocks] = useState(0);
  const [sessionExcluded, setSessionExcluded] = useState<string[]>([]);

  const option = useMemo(
    () => caseItem?.options.find((item) => item.id === selectedOption) ?? null,
    [caseItem, selectedOption],
  );

  const isIdentityRejection = caseItem?.caseKind === "identity_match" && option?.actionCode === "reject";

  useEffect(() => {
    if (!isIdentityRejection || selectedTarget || targetQuery.trim().length < 2) {
      setTargetResults([]);
      setTargetBusy(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setTargetBusy(true);
      try {
        const results = await adminApi.searchCatalogReviewTargets(targetQuery.trim());
        if (active) setTargetResults(results.filter((item) => item.id !== caseItem?.entity.id));
      } catch (error) {
        if (active) setNotice({
          tone: "error",
          title: "No pudimos buscar el destino",
          detail: error instanceof Error ? error.message : "Ocurrió un error inesperado.",
        });
      } finally {
        if (active) setTargetBusy(false);
      }
    }, 280);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [caseItem?.entity.id, isIdentityRejection, selectedTarget, targetQuery]);

  useEffect(() => {
    if (!referenceImage) {
      setReferenceImagePreview(null);
      return;
    }
    const preview = URL.createObjectURL(referenceImage);
    setReferenceImagePreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [referenceImage]);

  function resetDecision() {
    setSelectedOption(null);
    setReason("");
    setTargetQuery("");
    setTargetResults([]);
    setSelectedTarget(null);
    setReferenceUrl("");
    setReferenceNotes("");
    setReferenceImage(null);
    setShowDefer(false);
    setDeferReason("");
  }

  async function refresh(nextScreen: Screen = screen) {
    const [next, sessionNext] = await Promise.all([
      adminApi.getCatalogReviewBootstrap(),
      sessionExcluded.length > 0
        ? adminApi.getNextCatalogReviewCase(sessionExcluded)
        : Promise.resolve(undefined),
    ]);
    setBootstrap(next);
    setCaseItem(sessionNext === undefined ? next.nextCase : sessionNext);
    resetDecision();
    setScreen(nextScreen);
    return next;
  }

  function errorNotice(error: unknown) {
    if (error instanceof AdminApiError && error.code === "catalog_review_stale") {
      setNotice({
        tone: "warning",
        title: "Este caso cambió en otra sesión",
        detail: "No sobrescribimos la decisión existente. Te mostramos el siguiente caso vigente.",
      });
      void refresh("review");
      return;
    }
    setNotice({
      tone: "error",
      title: "No pudimos registrar la operación",
      detail: error instanceof Error ? error.message : "Ocurrió un error inesperado.",
    });
  }

  async function beginReview() {
    setNotice(null);
    if (!caseItem) {
      setBusy(true);
      try { await refresh("review"); } catch (error) { errorNotice(error); } finally { setBusy(false); }
      return;
    }
    setScreen("review");
  }

  function chooseReferenceImage(file: File | null) {
    if (!file) {
      setReferenceImage(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setNotice({ tone: "warning", title: "El archivo no es una imagen", detail: "Adjunta una fotografía PNG, JPG, WebP o GIF." });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setNotice({ tone: "warning", title: "La fotografía pesa más de 8 MB", detail: "Reduce su tamaño para conservarla como evidencia de revisión." });
      return;
    }
    setReferenceImage(file);
  }

  async function resolve() {
    if (!caseItem || !option || busy) return;
    if (option.requiresReason && !reason.trim()) {
      setNotice({ tone: "warning", title: "Falta una explicación breve", detail: "Describe qué evidencia te permitió tomar esta decisión." });
      return;
    }
    if (isIdentityRejection && referenceUrl.trim()) {
      try {
        const parsed = new URL(referenceUrl.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("protocol");
      } catch {
        setNotice({ tone: "warning", title: "El enlace de referencia no es válido", detail: "Usa una dirección completa que empiece con http:// o https://." });
        return;
      }
    }
    setBusy(true);
    setNotice(null);
    try {
      const uploadedImagePath = isIdentityRejection && referenceImage
        ? await uploadCatalogImage("product-image", referenceImage)
        : null;
      const uploadedImageUrl = uploadedImagePath ? publicAssetUrl(uploadedImagePath) : null;
      const placement = isIdentityRejection ? {
        target: selectedTarget ? {
          entityType: selectedTarget.entityType,
          entityId: selectedTarget.id,
          productId: selectedTarget.productId,
          name: selectedTarget.name,
          productName: selectedTarget.productName,
          code: selectedTarget.code,
          brand: selectedTarget.brand,
        } : null,
        suggestedName: targetQuery.trim() || null,
        referenceUrl: referenceUrl.trim() || null,
        imagePath: uploadedImagePath,
        imageUrl: uploadedImageUrl,
        notes: referenceNotes.trim() || null,
      } : null;
      const redirected = Boolean(selectedTarget);
      const result = await adminApi.resolveCatalogReviewCase(caseItem.id, {
        expectedVersion: caseItem.rowVersion,
        actionCode: option.actionCode,
        payload: { ...option.payload, reason: reason.trim(), ...(placement ? { placement } : {}) },
        evidence: [
          ...caseItem.evidence.map((item) => ({ id: item.id, kind: item.kind, label: item.label, value: item.value, url: item.url ?? null, imageUrl: item.imageUrl ?? null })),
          ...(placement ? [{
            id: "reviewer-redirect-reference",
            kind: "reviewer_reference",
            target: placement.target,
            url: placement.referenceUrl,
            imagePath: placement.imagePath,
            imageUrl: placement.imageUrl,
            notes: placement.notes,
            suggestedName: placement.suggestedName,
          }] : []),
        ],
        idempotencyKey: crypto.randomUUID(),
      });
      setSessionDecisions((value) => value + 1);
      setSessionUnlocks((value) => value + result.unlockedCount);
      await refresh("review");
      setNotice({
        tone: "success",
        title: option.actionCode === "reject" ? "Comparación rechazada sin perder la pista" : "Decisión registrada",
        detail: redirected
          ? "Esta pareja quedó cerrada y se creó una nueva candidata separada con el destino que señalaste. Todavía deberá confirmarse; no se aprobó automáticamente."
          : option.actionCode === "reject"
            ? "Esta pareja quedó cerrada. Las notas, enlaces y fotografías quedaron conservados como evidencia para ubicar el registro correcto."
            : result.unlockedCount > 0
          ? `Desbloqueaste ${formatNumber(result.unlockedCount)} trabajo${result.unlockedCount === 1 ? "" : "s"}. El siguiente caso ya está listo.`
          : "La verdad canónica y el historial se actualizaron juntos. El siguiente caso ya está listo.",
      });
    } catch (error) {
      errorNotice(error);
    } finally {
      setBusy(false);
    }
  }

  async function defer() {
    if (!caseItem || !deferReason.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await adminApi.transitionCatalogReviewCase(caseItem.id, {
        expectedVersion: caseItem.rowVersion,
        actionCode: "defer",
        reason: deferReason.trim(),
        deferMinutes,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh("review");
      setNotice({
        tone: "success",
        title: "Caso conservado para después",
        detail: result.deferredUntil
          ? `No se marcó como resuelto. Volverá a estar disponible el ${formatDate(result.deferredUntil)}.`
          : "No se marcó como resuelto y conserva toda su evidencia.",
      });
    } catch (error) {
      errorNotice(error);
    } finally {
      setBusy(false);
    }
  }

  async function showAnother() {
    if (!caseItem || busy) return;
    setBusy(true);
    setNotice(null);
    const excluded = [...sessionExcluded, caseItem.id];
    try {
      const next = await adminApi.getNextCatalogReviewCase(excluded);
      setSessionExcluded(excluded);
      setCaseItem(next);
      resetDecision();
      if (!next) setNotice({ tone: "warning", title: "No quedan más casos en esta vuelta", detail: "Puedes volver al inicio o reiniciar la sesión para recorrerlos nuevamente." });
    } catch (error) {
      errorNotice(error);
    } finally {
      setBusy(false);
    }
  }

  function renderHome() {
    const { summary, activity } = bootstrap;
    return (
      <div className="cr-home">
        <header className="cr-home-head">
          <div>
            <span className="cr-overline">Catálogo · Revisar</span>
            <h1>Una decisión clara a la vez.</h1>
            <p>El sistema ordena el trabajo y reúne la evidencia. Tú intervienes solo cuando tu criterio aporta valor.</p>
          </div>
          <button type="button" className="cr-primary cr-primary--large" onClick={beginReview} disabled={busy || !caseItem}>
            <span>{caseItem ? "Continuar revisión" : "No hay decisiones disponibles"}<small>{caseItem ? "Abrir el siguiente caso prioritario" : "Revisa captura y fuentes pendientes"}</small></span>
            <Icon name="arrow" />
          </button>
        </header>

        {notice ? <NoticeBlock notice={notice} onClose={() => setNotice(null)} /> : null}

        <section className="cr-metrics" aria-label="Estado de la revisión">
          <Metric label="Por revisar" value={summary.reviewable} detail={`${Math.round(summary.humanShareOfActive * 100)} % del trabajo activo`} tone="rose" />
          <Metric label="Necesitan captura" value={summary.capture} detail="Requieren evidencia física" tone="sand" />
          <Metric label="En espera" value={summary.waiting} detail="Dependen de una fuente externa" tone="blue" />
          <Metric label="Completados" value={summary.completed} detail="Decisiones cerradas" tone="green" />
        </section>

        <div className="cr-home-grid">
          <Link className="cr-card cr-relation-entry" href="/admin/catalogo/revisar/decisiones">
            <div className="cr-card-icon"><Icon name="spark" /></div>
            <div>
              <span className="cr-overline">Decisiones de relaciones</span>
              <h2>Revisar reglas y grupos de productos.</h2>
              <p>Casos agrupados para decidir una sola vez, con productos inciertos fuera del cambio.</p>
              <b>Abrir cola <Icon name="arrow" /></b>
            </div>
          </Link>
          <section className="cr-card cr-impact-card">
            <div className="cr-card-icon"><Icon name="spark" /></div>
            <div>
              <span className="cr-overline">Por qué empezar ahora</span>
              <h2>Las decisiones disponibles pueden mover {formatNumber(summary.potentialUnlocks)} trabajos.</h2>
              <p>{formatNumber(summary.blocked)} trabajos dependen de decisiones anteriores. No necesitas abrirlos: aparecerán cuando realmente puedan resolverse.</p>
              <p>{formatNumber(summary.automaticDebt)} señales se conservan como deuda automática y no compiten por tu atención.</p>
            </div>
          </section>
          <section className="cr-card cr-today-card">
            <header><span className="cr-overline">Hoy</span><small>Progreso sin medir velocidad</small></header>
            <div className="cr-today-values">
              <div><strong>{formatNumber(activity.decisionsToday)}</strong><span>decisiones</span></div>
              <div><strong>{formatNumber(activity.unlockedToday)}</strong><span>desbloqueados</span></div>
              <div><strong>{formatNumber(activity.entitiesAdvancedToday)}</strong><span>entidades avanzadas</span></div>
            </div>
          </section>
        </div>

        <section className="cr-how">
          <span className="cr-overline">Cómo funciona</span>
          <div>
            <article><b>1</b><span><strong>Comprende</strong><small>Compara registro, fuente y advertencias.</small></span></article>
            <article><b>2</b><span><strong>Decide o pospone</strong><small>Nunca inventes una respuesta por falta de evidencia.</small></span></article>
            <article><b>3</b><span><strong>Continúa</strong><small>El siguiente caso aparece sin volver al tablero.</small></span></article>
          </div>
        </section>
      </div>
    );
  }

  function renderDossier() {
    if (!caseItem) return renderEmpty();
    return (
      <div className="cr-dossier">
        <button type="button" className="cr-back" onClick={() => setScreen("review")}><Icon name="back" /> Volver a la decisión</button>
        <header className="cr-dossier-head">
          <div><span className="cr-overline">Expediente</span><h1>{caseItem.entity.name}</h1><p>Lo que sabemos, de dónde proviene y qué continúa pendiente.</p></div>
          <span className="cr-safe"><Icon name="shield" /> Consulta, no modifica</span>
        </header>
        <div className="cr-dossier-grid">
          <section className="cr-card cr-entity-file">
            <Visual url={caseItem.entity.imageUrl} label={caseItem.entity.name} tone="rose" />
            <div><span>{caseItem.entity.type}</span><h2>{caseItem.entity.name}</h2><p>{[caseItem.entity.brand, caseItem.entity.code].filter(Boolean).join(" · ") || "Sin código confirmado"}</p></div>
            <dl>
              {caseItem.entity.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
            </dl>
          </section>
          <section className="cr-card cr-file-section">
            <header><Icon name="folder" /><div><h2>Evidencia de este caso</h2><p>{caseItem.evidence.length} elementos conservados</p></div></header>
            <div className="cr-file-evidence">{caseItem.evidence.map((item) => <EvidenceCard item={item} key={item.id} />)}</div>
          </section>
          <section className="cr-card cr-file-section">
            <header><Icon name="spark" /><div><h2>Trabajo relacionado</h2><p>No necesitas resolverlo desde aquí</p></div></header>
            <div className="cr-related">
              {caseItem.relatedOpenWork.length
                ? caseItem.relatedOpenWork.map((item) => <div key={item.purpose}><strong>{item.count}</strong><span>{item.label}</span></div>)
                : <p>No hay otro trabajo abierto directamente sobre esta entidad.</p>}
            </div>
          </section>
          <section className="cr-card cr-file-section cr-file-history">
            <header><Icon name="history" /><div><h2>Historial inmutable</h2><p>Cada transición queda explicada</p></div></header>
            <ol>
              {caseItem.history.map((event) => (
                <li key={event.id} className={`cr-history-event cr-history-event--${event.tone}`}>
                  <span /><div><strong>{event.title}</strong><p>{event.detail}</p><small>{event.actor} · {formatDate(event.occurredAt)}</small></div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    );
  }

  function renderEmpty() {
    return (
      <div className="cr-empty">
        <span><Icon name="check" /></span>
        <h1>No quedan decisiones en esta vuelta.</h1>
        <p>Los trabajos de captura y fuente externa aparecerán cuando tengan evidencia suficiente.</p>
        <button type="button" className="cr-primary" onClick={() => { setSessionExcluded([]); void refresh("review"); }}>Reiniciar recorrido</button>
        <button type="button" className="cr-link-button" onClick={() => setScreen("home")}>Volver al inicio</button>
      </div>
    );
  }

  function renderReview() {
    if (!caseItem) return renderEmpty();
    const visualEvidence = caseItem.evidence.filter((item) => item.id !== "internal-record" && item.kind !== "image");
    return (
      <div className="cr-review">
        <header className="cr-review-bar">
          <button type="button" className="cr-back" onClick={() => setScreen("home")}><Icon name="back" /> Inicio</button>
          <div className="cr-session"><span>Esta sesión</span><b>{sessionDecisions} decisiones</b><i>·</i><b>{sessionUnlocks} desbloqueados</b></div>
          <button type="button" className="cr-file-button" onClick={() => setScreen("dossier")}><Icon name="folder" /> Ver expediente</button>
        </header>

        {notice ? <NoticeBlock notice={notice} onClose={() => setNotice(null)} /> : null}

        <main className="cr-case">
          <header className="cr-case-head">
            <div>
              <span className="cr-overline">{caseItem.eyebrow}</span>
              <h1>{caseItem.title}</h1>
              <p>{caseItem.findingSummary}</p>
            </div>
            <div className="cr-case-signals">
              {caseItem.hasContradiction ? <span className="cr-signal cr-signal--warning"><Icon name="warning" /> Contradicción</span> : null}
              {caseItem.impact.unlockCount > 0 ? <span className="cr-signal cr-signal--impact"><Icon name="spark" /> Puede liberar {caseItem.impact.unlockCount}</span> : null}
            </div>
          </header>

          {caseItem.warnings.length ? <div className="cr-warnings">{caseItem.warnings.map((warning) => <p key={warning}><Icon name="warning" />{warning}</p>)}</div> : null}

          {caseItem.caseKind === "identity_match"
            ? <IdentityComparison caseItem={caseItem} />
            : <section className="cr-subject"><Visual url={caseItem.entity.imageUrl} label={caseItem.entity.name} tone="rose" /><div><span>{caseItem.entity.type}</span><h2>{caseItem.entity.name}</h2><p>{caseItem.entity.description ?? caseItem.findingSummary}</p></div></section>}

          <section className="cr-decision">
            <div className="cr-question"><span>Tu decisión</span><h2>{caseItem.question}</h2></div>
            <div className="cr-options">{caseItem.options.map((item) => <OptionButton key={item.id} option={item} selected={selectedOption === item.id} onSelect={() => setSelectedOption(item.id)} />)}</div>
            {isIdentityRejection ? (
              <section className="cr-redirect">
                <header>
                  <div><span>Destino o evidencia de corrección</span><h3>¿A qué registro debería corresponder?</h3></div>
                  <small>No tienes que saber todo. Deja cualquier pista verificable.</small>
                </header>
                <div className="cr-redirect-explainer">
                  <Icon name="shield" />
                  <p><b>Esto no moverá ni aprobará el registro automáticamente.</b> Cerrará la pareja equivocada y abrirá una pista separada para confirmar el destino correcto.</p>
                </div>
                <div className="cr-redirect-grid">
                  <div className="cr-target-search">
                    <label>
                      <span>Buscar producto o variante de destino</span>
                      <input
                        value={selectedTarget ? `${selectedTarget.name} · ${selectedTarget.code ?? selectedTarget.productName}` : targetQuery}
                        onChange={(event) => { setSelectedTarget(null); setTargetQuery(event.target.value); }}
                        placeholder="Nombre, código, SKU o tono…"
                        autoComplete="off"
                      />
                    </label>
                    {selectedTarget ? (
                      <div className="cr-target-selected">
                        <span><Icon name="check" /></span>
                        <div><strong>{selectedTarget.name}</strong><small>{selectedTarget.detail}</small></div>
                        <button type="button" onClick={() => { setSelectedTarget(null); setTargetQuery(""); }}>Cambiar</button>
                      </div>
                    ) : targetQuery.trim().length >= 2 ? (
                      <div className="cr-target-results" role="listbox" aria-label="Destinos encontrados">
                        {targetBusy ? <p>Buscando en el catálogo…</p> : targetResults.length ? targetResults.map((target) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected="false"
                            key={`${target.entityType}:${target.id}`}
                            onClick={() => { setSelectedTarget(target); setTargetQuery(target.name); setTargetResults([]); }}
                          >
                            <span>{target.entityType === "variant" ? "Variante" : "Producto"}</span>
                            <strong>{target.name}</strong>
                            <small>{target.detail}</small>
                          </button>
                        )) : <p>No encontramos un destino exacto. Conserva el texto y agrega otra referencia.</p>}
                      </div>
                    ) : null}
                  </div>
                  <label>
                    <span>Enlace de referencia</span>
                    <input type="url" value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} maxLength={600} placeholder="https://sitio-oficial.com/producto…" />
                    <small>Puede ser otra ficha oficial, proveedor o página que ayude a identificarlo.</small>
                  </label>
                </div>
                <div className="cr-redirect-grid">
                  <label className="cr-reference-upload">
                    <span>Fotografía de referencia</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => chooseReferenceImage(event.target.files?.[0] ?? null)} />
                    <span className="cr-upload-box">
                      {referenceImagePreview
                        ? <span className="cr-upload-preview" role="img" aria-label="Vista previa de la referencia" style={{ backgroundImage: `url("${referenceImagePreview.replaceAll('"', "%22")}")` }} />
                        : <Icon name="image" />}
                      <b>{referenceImage ? referenceImage.name : "Adjuntar envase, etiqueta o captura"}</b>
                      <small>PNG, JPG, WebP o GIF · máximo 8 MB</small>
                    </span>
                  </label>
                  <label>
                    <span>Datos que ayuden a encontrarlo</span>
                    <textarea value={referenceNotes} onChange={(event) => setReferenceNotes(event.target.value)} maxLength={1200} placeholder="Ej.: el envase dice…, código visible…, línea…, tamaño…, proveedor…" />
                    <small>{referenceNotes.length}/1200</small>
                  </label>
                </div>
              </section>
            ) : null}
            {option ? (
              <label className="cr-reason">
                <span>{isIdentityRejection ? "¿Por qué sabes que esta pareja es incorrecta?" : option.requiresReason ? "¿Qué evidencia sustenta tu decisión?" : "Nota opcional"}</span>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder={isIdentityRejection ? "Ej.: el código o la línea no coinciden; la foto corresponde a otra presentación…" : "Ej.: el código, la presentación y la imagen del envase coinciden…"} />
                <small>{reason.length}/1000</small>
              </label>
            ) : null}
            <div className="cr-decision-actions">
              <button type="button" className="cr-primary" disabled={!option || busy} onClick={resolve}>{busy ? "Guardando…" : "Registrar y continuar"}<Icon name="arrow" /></button>
              <button type="button" className="cr-secondary" onClick={() => setShowDefer((value) => !value)} disabled={busy}><Icon name="clock" /> No tengo evidencia suficiente</button>
              <button type="button" className="cr-link-button" onClick={showAnother} disabled={busy}>Ver otro sin cambiar este caso</button>
            </div>
          </section>

          {showDefer ? (
            <section className="cr-defer">
              <div><span className="cr-overline">Conservar pendiente</span><h2>¿Qué información falta?</h2><p>Esto no cuenta como completado ni rechaza la propuesta.</p></div>
              <label><span>Motivo</span><textarea value={deferReason} onChange={(event) => setDeferReason(event.target.value)} maxLength={1000} placeholder="Ej.: necesito fotografiar la base del envase para comprobar el código…" /></label>
              <label><span>Volver a mostrar</span><select value={deferMinutes} onChange={(event) => setDeferMinutes(Number(event.target.value))}><option value={60}>En 1 hora</option><option value={1440}>Mañana</option><option value={10080}>En 7 días</option></select></label>
              <div><button type="button" className="cr-secondary" onClick={defer} disabled={!deferReason.trim() || busy}>{busy ? "Guardando…" : "Posponer sin resolver"}</button><button type="button" className="cr-link-button" onClick={() => setShowDefer(false)}>Cancelar</button></div>
            </section>
          ) : null}

          <DecisionScope caseItem={caseItem} />

          {visualEvidence.length ? (
            <details className="cr-evidence-disclosure" open={caseItem.hasContradiction}>
              <summary><span><Icon name="shield" /> Evidencia reunida</span><small>{visualEvidence.length} elementos</small></summary>
              <div className="cr-evidence-grid">{visualEvidence.map((item) => <EvidenceCard item={item} key={item.id} />)}</div>
            </details>
          ) : null}
        </main>
      </div>
    );
  }

  return <div className="catalog-review-shell">{screen === "home" ? renderHome() : screen === "dossier" ? renderDossier() : renderReview()}</div>;
}
