"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import type { OrderAmbiguity, OrderProposal } from "@/lib/ai/matching";
import type { AiProviderInfo } from "@/lib/ai/contracts";
import type { VisionResult } from "@/lib/ai/vision";

/** Lo que viaja del asistente a la pantalla de Ventas por sessionStorage. */
export const ASSISTANT_HANDOFF_KEY = "br-asistente-propuesta";

export type AssistantHandoff = {
  interactionIds: string[];
  lineas: { variantId: string; sku: string | null; nombre: string; cantidad: number }[];
};

type DraftLine = AssistantHandoff["lineas"][number];

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function providerBadge(proveedor: AiProviderInfo | null) {
  if (!proveedor) return null;
  if (proveedor.estado === "ok") {
    return <span className="ai-badge ai-badge--ok">IA · {proveedor.modelo}</span>;
  }
  if (proveedor.estado === "degraded") {
    return <span className="ai-badge ai-badge--warn" title={proveedor.detalle ?? undefined}>Modo determinista</span>;
  }
  return <span className="ai-badge ai-badge--off" title={proveedor.detalle ?? undefined}>IA no disponible</span>;
}

/**
 * El asistente del Bloque 4 en una pantalla: dictar un pedido, identificar
 * por foto y consultar a la asesora. Todo termina en UNA propuesta que la
 * persona revisa y lleva a Ventas — aquí no se vende nada (regla 9), y sin
 * credencial de IA cada sección degrada con honestidad (regla 10).
 */
export function AssistantView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const router = useRouter();

  // La propuesta compartida: dictado, foto y asesora alimentan el mismo pedido.
  const [lineas, setLineas] = useState<DraftLine[]>([]);
  const [interactionIds, setInteractionIds] = useState<string[]>([]);

  // Dictado
  const [texto, setTexto] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [propuesta, setPropuesta] = useState<OrderProposal | null>(null);
  const [proveedorDictado, setProveedorDictado] = useState<AiProviderInfo | null>(null);

  // Foto
  const [etapa, setEtapa] = useState<"single" | "small_group">("single");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [vision, setVision] = useState<VisionResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Asesora
  const [pregunta, setPregunta] = useState("");
  const [advising, setAdvising] = useState(false);
  const [consejo, setConsejo] = useState<Awaited<ReturnType<typeof adminApi.adviseAssist>> | null>(null);

  useEffect(() => {
    setSpeechSupported(getSpeechRecognition() != null);
    return () => recognitionRef.current?.stop();
  }, []);

  function toggleDictation() {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "es-PE";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const chunk = Array.from({ length: event.results.length }, (_, i) => event.results[i]?.[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (chunk) setTexto((current) => (current ? `${current} ${chunk}` : chunk));
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      showToast("El micrófono se detuvo; puedes escribir el pedido.");
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function addLinea(nueva: DraftLine) {
    setLineas((current) => {
      const existing = current.find((line) => line.variantId === nueva.variantId);
      if (existing) {
        return current.map((line) =>
          line.variantId === nueva.variantId
            ? { ...line, cantidad: Math.min(999, line.cantidad + nueva.cantidad) }
            : line
        );
      }
      return [...current, nueva];
    });
  }

  function trackInteraction(id: string) {
    setInteractionIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  async function interpret() {
    const value = texto.trim();
    if (!value || interpreting) return;
    setInterpreting(true);
    try {
      const result = await adminApi.interpretOrderAssist({ texto: value });
      setPropuesta(result.propuesta);
      setProveedorDictado(result.proveedor);
      trackInteraction(result.interactionId);
      for (const linea of result.propuesta.lineas) {
        addLinea({ variantId: linea.variantId, sku: linea.sku, nombre: linea.nombre, cantidad: linea.cantidad });
      }
      if (result.propuesta.lineas.length === 0 && result.propuesta.ambiguedades.length === 0) {
        showToast("No encontré productos en el dictado; revisa el texto.");
      }
    } catch (error) {
      handleApiError(error, "No se pudo interpretar el pedido.");
    } finally {
      setInterpreting(false);
    }
  }

  function resolveAmbiguity(amb: OrderAmbiguity, opcion: OrderAmbiguity["opciones"][number]) {
    addLinea({ variantId: opcion.variantId, sku: opcion.sku, nombre: opcion.nombre, cantidad: amb.cantidad });
    setPropuesta((current) =>
      current
        ? { ...current, ambiguedades: current.ambiguedades.filter((item) => item !== amb) }
        : current
    );
    showToast(`${opcion.nombre} agregado ✓`);
  }

  async function identifyPhoto(file: File) {
    setPhotoBusy(true);
    setVision(null);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const base64 = dataUrl.split(",")[1] ?? "";

      const result = await adminApi.photoAssist({ imagenBase64: base64, mediaType: "image/jpeg", etapa });
      setVision(result.resultado);
      trackInteraction(result.interactionId);
    } catch (error) {
      handleApiError(error, "No se pudo procesar la foto.");
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function ask() {
    const value = pregunta.trim();
    if (!value || advising) return;
    setAdvising(true);
    try {
      const result = await adminApi.adviseAssist({ pregunta: value });
      setConsejo(result);
      trackInteraction(result.interactionId);
    } catch (error) {
      handleApiError(error, "La asesora no pudo responder.");
    } finally {
      setAdvising(false);
    }
  }

  function takeToSales() {
    if (lineas.length === 0) return;
    const handoff: AssistantHandoff = { interactionIds, lineas };
    window.sessionStorage.setItem(ASSISTANT_HANDOFF_KEY, JSON.stringify(handoff));
    router.push("/admin/ventas");
  }

  async function discardAll() {
    for (const id of interactionIds) {
      try {
        await adminApi.resolveAssist({ interactionId: id, estado: "discarded", nota: "Descartada desde el asistente" });
      } catch {
        // Una interacción ya resuelta no detiene la limpieza del resto.
      }
    }
    setLineas([]);
    setInteractionIds([]);
    setPropuesta(null);
    setVision(null);
    setConsejo(null);
    showToast("Propuesta descartada.");
  }

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Asistente Bellaroshé</div>
          <div className="field-hint">
            La IA propone; tú decides. Nada se vende desde aquí: la propuesta se revisa y se lleva a Ventas.
          </div>
        </div>
      </div>

      <div className="assistant-grid">
        <div className="assistant-main">
          {/* Dictado */}
          <section className="form-card">
            <div className="order-section-title">
              Dictar pedido {providerBadge(proveedorDictado)}
            </div>
            <div className="ai-dictation">
              <textarea
                className="input textarea"
                rows={3}
                value={texto}
                onChange={(event) => setTexto(event.target.value)}
                placeholder="«Dos esmaltes rojo cereza de Masglo y un kit de gel para principiante»"
              />
              <div className="ai-dictation-actions">
                {speechSupported ? (
                  <button type="button"
                    className={listening ? "btn-cancel" : "btn-soft"}
                    onClick={toggleDictation}>
                    {listening ? "● Grabando… detener" : "🎙 Dictar"}
                  </button>
                ) : (
                  <span className="field-hint">Este navegador no dicta; escribe el pedido.</span>
                )}
                <button type="button" className="btn-save" disabled={interpreting || !texto.trim()} onClick={interpret}>
                  {interpreting ? "Interpretando…" : "Interpretar pedido"}
                </button>
              </div>
            </div>

            {propuesta && propuesta.ambiguedades.length > 0 ? (
              <div className="ai-block">
                <div className="ai-block-title">Necesito que decidas tú:</div>
                {propuesta.ambiguedades.map((amb, index) => (
                  <div key={`${amb.texto}-${index}`} className="ai-ambiguity">
                    <span>«{amb.texto}» × {amb.cantidad}</span>
                    <div className="ai-options">
                      {amb.opciones.map((opcion) => (
                        <button key={opcion.variantId} type="button" className="btn-soft"
                          onClick={() => resolveAmbiguity(amb, opcion)}>
                          {opcion.nombre}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {propuesta && propuesta.noEncontrado.length > 0 ? (
              <div className="ai-block ai-block--muted">
                No están en el catálogo: {propuesta.noEncontrado.map((item) => `«${item}»`).join(", ")}.
              </div>
            ) : null}
          </section>

          {/* Foto */}
          <section className="form-card">
            <div className="order-section-title">Identificar por foto</div>
            <div className="ai-photo-controls">
              <select className="input" value={etapa} onChange={(event) => setEtapa(event.target.value as typeof etapa)}>
                <option value="single">Un producto</option>
                <option value="small_group">Grupo pequeño (máx. 6)</option>
              </select>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="input"
                disabled={photoBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void identifyPhoto(file);
                }} />
              {photoBusy ? <span className="spinner spinner--pink" /> : null}
            </div>
            <div className="field-hint">
              Por etapas, como debe ser: un producto o un grupo chico. Para bandejas grandes usa el dictado o los códigos.
            </div>

            {vision?.estado === "unavailable" || vision?.estado === "error" || vision?.estado === "refusal" ? (
              <div className="ai-block ai-block--warn">
                Reconocimiento no disponible: {vision.detalle} La operación sigue con registro manual.
              </div>
            ) : null}

            {vision?.estado === "ok" ? (
              <div className="ai-block">
                {vision.candidatos.length === 0 ? (
                  <div className="order-empty">No se distinguieron productos en la foto.</div>
                ) : vision.candidatos.map((candidato, index) => (
                  <div key={index} className="ai-ambiguity">
                    <span>
                      {candidato.descripcion}
                      {candidato.marcaVisible ? ` · ${candidato.marcaVisible}` : ""}
                      <small className="ai-confidence"> confianza {(candidato.confianza * 100).toFixed(0)}%</small>
                    </span>
                    <div className="ai-options">
                      {candidato.opciones.length === 0 ? (
                        <span className="field-hint">Sin coincidencia en el catálogo.</span>
                      ) : candidato.opciones.map((opcion) => (
                        <button key={opcion.variantId} type="button" className="btn-soft"
                          onClick={() => {
                            addLinea({ variantId: opcion.variantId, sku: opcion.sku, nombre: opcion.nombre, cantidad: 1 });
                            showToast(`${opcion.nombre} agregado ✓`);
                          }}>
                          {opcion.nombre}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {vision.advertencias.map((advertencia, index) => (
                  <div key={index} className="field-hint">⚠ {advertencia}</div>
                ))}
              </div>
            ) : null}
          </section>

          {/* Asesora */}
          <section className="form-card">
            <div className="order-section-title">
              Asesora Bellaroshé {consejo ? providerBadge(consejo.proveedor) : null}
            </div>
            <div className="ai-dictation">
              <textarea
                className="input textarea"
                rows={2}
                value={pregunta}
                onChange={(event) => setPregunta(event.target.value)}
                placeholder="«¿Qué necesita una clienta que recién empieza con semipermanente?»"
              />
              <div className="ai-dictation-actions">
                <button type="button" className="btn-save" disabled={advising || !pregunta.trim()} onClick={ask}>
                  {advising ? "Consultando…" : "Preguntar"}
                </button>
              </div>
            </div>

            {consejo ? (
              <div className="ai-block">
                <p className="ai-answer">{consejo.respuesta}</p>
                {consejo.recomendaciones.length > 0 ? (
                  <div className="ai-options">
                    {consejo.recomendaciones.map((rec) => (
                      <button key={rec.variantId} type="button" className="btn-soft"
                        title={rec.razon}
                        onClick={() => {
                          addLinea({ variantId: rec.variantId, sku: rec.sku, nombre: rec.nombre, cantidad: 1 });
                          showToast(`${rec.nombre} agregado ✓`);
                        }}>
                        + {rec.nombre}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button type="button" className="btn-soft" style={{ marginTop: 8 }}
                  onClick={() => {
                    void navigator.clipboard.writeText(consejo.respuesta);
                    showToast("Respuesta copiada ✓");
                  }}>
                  Copiar respuesta
                </button>
              </div>
            ) : null}
          </section>
        </div>

        {/* La propuesta viva */}
        <aside className="form-card assistant-cart">
          <div className="order-section-title">Pedido en preparación</div>
          {lineas.length === 0 ? (
            <div className="order-empty">Dicta, fotografía o pregunta: lo que confirmes aparece aquí.</div>
          ) : (
            <>
              <div className="order-lines">
                {lineas.map((linea) => (
                  <div key={linea.variantId} className="ai-line">
                    <span>{linea.nombre}<small>{linea.sku ?? ""}</small></span>
                    <div className="ai-line-qty">
                      <button type="button" className="btn-soft" onClick={() =>
                        setLineas((current) => current
                          .map((l) => l.variantId === linea.variantId ? { ...l, cantidad: l.cantidad - 1 } : l)
                          .filter((l) => l.cantidad > 0))}>−</button>
                      <b>{linea.cantidad}</b>
                      <button type="button" className="btn-soft" onClick={() =>
                        setLineas((current) => current
                          .map((l) => l.variantId === linea.variantId ? { ...l, cantidad: Math.min(999, l.cantidad + 1) } : l))}>+</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="field-hint" style={{ marginTop: 8 }}>
                El precio y el stock los valida Ventas al registrar — el asistente nunca es fuente de precio.
              </div>
              <div className="ai-cart-actions">
                <button type="button" className="btn-save" onClick={takeToSales}>
                  Llevar a Ventas →
                </button>
                <button type="button" className="btn-cancel" onClick={discardAll}>
                  Descartar
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
