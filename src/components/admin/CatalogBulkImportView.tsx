"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, AdminApiError } from "@/lib/admin/api";
import { BULK_FAMILY_MAP } from "@/lib/admin/catalog-bulk-import/family-map";
import type { BulkBatchPreview, BulkCommitReport } from "@/lib/admin/catalog-bulk-import/types";

type BulkBatchListItem = Awaited<ReturnType<typeof adminApi.listBulkImportBatches>>[number];

function errorMessage(error: unknown) {
  if (error instanceof AdminApiError) return error.message;
  return error instanceof Error ? error.message : "No se pudo completar la operación.";
}

const ACTION_LABELS: Record<string, string> = {
  create_product: "Productos nuevos",
  create_variant: "Variantes nuevas",
  update_product: "Productos reutilizados",
  update_variant: "Ofertas adicionales",
  skip: "Omitidas (duplicados)",
  merge: "Fusiones a decidir"
};

const REPORT_LABELS: Array<[keyof BulkCommitReport["counts"], string]> = [
  ["filasProcesadas", "Filas procesadas"],
  ["productosNuevos", "Productos nuevos"],
  ["productosReutilizados", "Productos reutilizados"],
  ["variantesCreadas", "Variantes creadas"],
  ["duplicadosEvitados", "Duplicados evitados"],
  ["imagenesExactas", "Imágenes exactas"],
  ["imagenesAltaConfianza", "Imágenes alta confianza"],
  ["imagenesEnRevision", "Imágenes en revisión"],
  ["imagenesFaltantes", "Imágenes faltantes"],
  ["variantesConColorRespaldo", "Variantes con color de respaldo"],
  ["filasRechazadas", "Filas rechazadas"],
  ["issues", "Issues abiertos"]
];

export function CatalogBulkImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [loteName, setLoteName] = useState("");
  const [familias, setFamilias] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BulkBatchPreview | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [confirmation, setConfirmation] = useState("");
  const [report, setReport] = useState<BulkCommitReport | null>(null);
  const [batches, setBatches] = useState<BulkBatchListItem[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const familiasDisponibles = useMemo(() => BULK_FAMILY_MAP.map((config) => config.familia), []);
  const loteNameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(loteName);

  const refreshBatches = useCallback(async () => {
    try {
      setBatches(await adminApi.listBulkImportBatches());
    } catch {
      // La lista de lotes es informativa; no bloquea el flujo.
    }
  }, []);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  function toggleFamilia(familia: string) {
    setFamilias((current) => {
      const next = new Set(current);
      if (next.has(familia)) next.delete(familia);
      else next.add(familia);
      return next;
    });
  }

  function toggleRow(row: number) {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  }

  async function runPreview() {
    if (!file || !loteNameValid || loading) return;
    setLoading("preview");
    setError("");
    setNotice("");
    setReport(null);
    try {
      const result = await adminApi.previewBulkImport(file, {
        name: loteName,
        familias: familias.size ? [...familias] : undefined
      });
      setPreview(result);
      setSelectedRows(new Set());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  async function runApprove(options: { includeReview?: boolean; rowNumbers?: number[]; skipRowNumbers?: number[] }, label: string) {
    if (!preview || loading) return;
    setLoading("approve");
    setError("");
    try {
      const result = await adminApi.approveBulkImport({ batchId: preview.batchId, ...options });
      setPreview(result.preview);
      setSelectedRows(new Set());
      setNotice(`${label}: ${result.approved} aprobadas, ${result.skipped} omitidas${result.blockedByIssues ? `, ${result.blockedByIssues} bloqueadas por issues de error` : ""}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  async function runCommit() {
    if (!preview || loading || confirmation !== "IMPORTAR LOTE") return;
    setLoading("commit");
    setError("");
    setNotice("");
    try {
      const result = await adminApi.commitBulkImport({ batchId: preview.batchId, confirmation });
      setReport(result);
      setConfirmation("");
      setPreview(null);
      await refreshBatches();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  async function runMediaSync(batchId: string) {
    if (loading) return;
    setLoading(`media-${batchId}`);
    setError("");
    try {
      const result = await adminApi.syncBulkImportMedia(batchId);
      setNotice(`Conciliación de imágenes: ${result.variantesConImagen} variantes y ${result.productosConImagen} productos adoptaron imagen; ${result.sinCambio} sin cambio.`);
      await refreshBatches();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="import-flow">
      <section className="form-card import-security-summary">
        <strong>Carga masiva del listado real</strong>
        <span>El Excel crudo jamás toca las tablas definitivas: cada fila se normaliza, se agrupa en producto/variantes, se deduplica y queda en staging. Tú revisas solo las excepciones.</span>
        <span>Ejecutar dos veces el mismo lote no duplica productos, variantes ni imágenes.</span>
      </section>

      <div className="import-step-head">
        <span className="import-step-number">1</span>
        <div><strong>Definir el lote</strong><span>Listado .xlsx + nombre del lote + familias incluidas (~100–250 filas).</span></div>
      </div>

      <section className="form-card import-upload-card">
        <label className="import-dropzone">
          <input type="file" accept=".xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setReport(null); }} />
          <span className="import-dropzone-icon">XLSX</span>
          <strong>{file ? file.name : "Selecciona el listado organizado"}</strong>
          <small>Hoja «Catálogo organizado» con las columnas del listado real</small>
        </label>
        <div className="bulk-lote-fields">
          <label className="bulk-field">
            <span>Nombre del lote</span>
            <input
              type="text"
              value={loteName}
              placeholder="p. ej. unas-esmaltes-01"
              onChange={(event) => setLoteName(event.target.value.trim().toLowerCase())}
            />
            {!loteNameValid && loteName ? <small className="bulk-field-error">Minúsculas y guiones, p. ej. «piloto-01».</small> : null}
          </label>
          <details className="import-details">
            <summary>Familias incluidas {familias.size ? `(${familias.size})` : "(todas las del archivo)"}</summary>
            <div className="bulk-familias-grid">
              {familiasDisponibles.map((familia) => (
                <label key={familia} className="bulk-familia-option">
                  <input type="checkbox" checked={familias.has(familia)} onChange={() => toggleFamilia(familia)} />
                  <span>{familia}</span>
                </label>
              ))}
            </div>
          </details>
        </div>
        <button type="button" className="btn-primary" disabled={!file || !loteNameValid || loading !== null} onClick={runPreview}>
          {loading === "preview" ? "Normalizando…" : "Previsualizar lote"}
        </button>
      </section>

      {error ? <div className="import-message import-message--error">{error}</div> : null}
      {notice ? <div className="import-message">{notice}</div> : null}

      {preview ? (
        <>
          <div className="import-step-head">
            <span className="import-step-number">2</span>
            <div><strong>Revisar solo las excepciones</strong><span>Lote «{preview.loteName}» · {preview.totalRows} filas · estado {preview.status}</span></div>
          </div>

          <section className="form-card">
            <div className="import-stats">
              {Object.entries(preview.porAccion).filter(([, value]) => value > 0).map(([action, value]) => (
                <div className="import-stat" key={action}><strong>{value}</strong><span>{ACTION_LABELS[action] ?? action}</span></div>
              ))}
              <div className="import-stat"><strong>{preview.productos.length}</strong><span>Productos propuestos</span></div>
              <div className="import-stat"><strong>{preview.issuesAbiertos}</strong><span>Issues abiertos</span></div>
            </div>

            <details className="import-details">
              <summary>Productos propuestos ({preview.productos.length})</summary>
              <div className="bulk-table-scroll">
                <table className="bulk-table">
                  <thead>
                    <tr><th>Código</th><th>Producto</th><th>Marca</th><th>Familia</th><th>Variantes</th><th>Imágenes</th></tr>
                  </thead>
                  <tbody>
                    {preview.productos.map((producto) => (
                      <tr key={producto.productCode}>
                        <td><code>{producto.productCode}</code></td>
                        <td>{producto.productName}</td>
                        <td>{producto.brand}</td>
                        <td>{producto.familia ?? "—"}</td>
                        <td>{producto.variantCount}</td>
                        <td>
                          {producto.mediaStatus.exact + producto.mediaStatus.high > 0 ? `${producto.mediaStatus.exact + producto.mediaStatus.high} ✓ ` : ""}
                          {producto.mediaStatus.color_fallback > 0 ? `${producto.mediaStatus.color_fallback} color ` : ""}
                          {producto.mediaStatus.missing > 0 ? `${producto.mediaStatus.missing} pend.` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          {preview.excepciones.length ? (
            <section className="form-card">
              <div className="form-title">Excepciones ({preview.excepciones.length})</div>
              <div className="bulk-table-scroll">
                <table className="bulk-table">
                  <thead>
                    <tr><th></th><th>Fila</th><th>Producto</th><th>Descripción original</th><th>Motivos</th></tr>
                  </thead>
                  <tbody>
                    {preview.excepciones.map((excepcion) => (
                      <tr key={excepcion.importRowId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedRows.has(excepcion.row)}
                            onChange={() => toggleRow(excepcion.row)}
                            aria-label={`Seleccionar fila ${excepcion.row}`}
                          />
                        </td>
                        <td>{excepcion.row}</td>
                        <td><code>{excepcion.productCode}</code></td>
                        <td>{excepcion.description ?? "—"}</td>
                        <td>
                          {excepcion.reasons.map((reason) => <div key={reason}>· {reason}</div>)}
                          {excepcion.issues.map((issue) => (
                            <div key={`${issue.code}-${issue.message}`} className={issue.severity === "error" || issue.severity === "blocking" ? "bulk-field-error" : undefined}>
                              · [{issue.severity}] {issue.message}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="bulk-actions-row">
                <button type="button" className="btn-secondary" disabled={loading !== null} onClick={() => runApprove({}, "Aprobación de filas limpias")}>
                  Aprobar todo lo limpio
                </button>
                <button type="button" className="btn-secondary" disabled={loading !== null} onClick={() => runApprove({ includeReview: true }, "Aprobación masiva con revisión")}>
                  Aprobar también revisión (sin errores)
                </button>
                <button type="button" className="btn-secondary" disabled={loading !== null || !selectedRows.size} onClick={() => runApprove({ rowNumbers: [...selectedRows] }, "Aprobación de seleccionadas")}>
                  Aprobar seleccionadas ({selectedRows.size})
                </button>
                <button type="button" className="btn-secondary" disabled={loading !== null || !selectedRows.size} onClick={() => runApprove({ skipRowNumbers: [...selectedRows] }, "Omisión de seleccionadas")}>
                  Omitir seleccionadas
                </button>
              </div>
            </section>
          ) : (
            <section className="form-card">
              <div className="form-title">Sin excepciones pendientes</div>
              <div className="bulk-actions-row">
                <button type="button" className="btn-secondary" disabled={loading !== null} onClick={() => runApprove({}, "Aprobación de filas limpias")}>
                  Aprobar todo lo limpio
                </button>
              </div>
            </section>
          )}

          <div className="import-step-head">
            <span className="import-step-number">3</span>
            <div><strong>Importar el lote aprobado</strong><span>Solo entran filas aprobadas; los merge con issues de error siguen fuera.</span></div>
          </div>
          <section className="form-card import-upload-card">
            <label className="bulk-field">
              <span>Escribe <code>IMPORTAR LOTE</code> para confirmar</span>
              <input type="text" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="IMPORTAR LOTE" />
            </label>
            <button type="button" className="btn-primary" disabled={confirmation !== "IMPORTAR LOTE" || loading !== null} onClick={runCommit}>
              {loading === "commit" ? "Importando…" : "Importar lote"}
            </button>
          </section>
        </>
      ) : null}

      {report ? (
        <section className="form-card">
          <div className="import-preview-head">
            <div className="form-title">Reporte del lote «{report.loteName}»</div>
            <span className="import-status import-status--ok">{(report.counts.duracionMs / 1000).toFixed(1)} s</span>
          </div>
          <div className="import-stats">
            {REPORT_LABELS.map(([key, label]) => (
              <div className="import-stat" key={key}><strong>{report.counts[key]}</strong><span>{label}</span></div>
            ))}
          </div>
          {report.rechazadas.length ? (
            <details className="import-details">
              <summary>Filas rechazadas ({report.rechazadas.length})</summary>
              <div className="import-path-list">
                {report.rechazadas.map((rechazo) => <code key={`${rechazo.row}-${rechazo.reason}`}>Fila {rechazo.row}: {rechazo.reason}</code>)}
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {batches.length ? (
        <>
          <div className="import-step-head">
            <span className="import-step-number">≡</span>
            <div><strong>Lotes de carga masiva</strong><span>Historial con su reporte; concilia imágenes cuando llegue un ZIP nuevo.</span></div>
          </div>
          <section className="form-card">
            <div className="bulk-table-scroll">
              <table className="bulk-table">
                <thead>
                  <tr><th>Lote</th><th>Estado</th><th>Filas</th><th>Procesadas</th><th>Errores</th><th>Fecha</th><th></th></tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr key={batch.id}>
                      <td>{String((batch.summary as { lote?: string })?.lote ?? batch.source_name)}</td>
                      <td>{batch.status}</td>
                      <td>{batch.total_rows}</td>
                      <td>{batch.processed_rows}</td>
                      <td>{batch.error_rows}</td>
                      <td>{new Date(batch.created_at).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })}</td>
                      <td>
                        {batch.status === "committed" ? (
                          <button type="button" className="btn-secondary" disabled={loading !== null} onClick={() => runMediaSync(batch.id)}>
                            {loading === `media-${batch.id}` ? "Conciliando…" : "Conciliar imágenes"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
