"use client";

import { useState } from "react";
import { adminApi, AdminApiError } from "@/lib/admin/api";
import type {
  CatalogImportCommitResult,
  CatalogImportPreview,
  CatalogMediaPackageCommitResult,
  CatalogMediaPackagePreview
} from "@/lib/admin/catalog-import-types";

function errorMessage(error: unknown) {
  if (error instanceof AdminApiError) return error.message;
  return error instanceof Error ? error.message : "No se pudo procesar el archivo.";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function productLineApprovalKey(brandSlug: string, slug: string) {
  return `${brandSlug.toLowerCase()}|${slug.toLowerCase()}`;
}

export function CatalogImportView() {
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<CatalogMediaPackagePreview | null>(null);
  const [mediaResult, setMediaResult] = useState<CatalogMediaPackageCommitResult | null>(null);
  const [mediaConfirmation, setMediaConfirmation] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [mediaLoading, setMediaLoading] = useState<"preview" | "commit" | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaSkipped, setMediaSkipped] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [result, setResult] = useState<CatalogImportCommitResult | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [productLineNames, setProductLineNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"preview" | "commit" | null>(null);
  const requiredConfirmation = preview?.productLinesToCreate.length ? "AUTORIZAR E IMPORTAR" : "IMPORTAR";
  const productLineApprovals = (preview?.productLinesToCreate ?? []).map((proposal) => ({
    brandSlug: proposal.brandSlug,
    slug: proposal.slug,
    name: productLineNames[productLineApprovalKey(proposal.brandSlug, proposal.slug)]?.trim() ?? ""
  }));
  const productLineNamesAreValid = productLineApprovals.every((approval) => approval.name.length > 0 && approval.name.length <= 120);

  function resetCatalogSelection() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setConfirmation("");
    setProductLineNames({});
    setError("");
  }

  function chooseMediaFile(nextFile: File | null) {
    setMediaFile(nextFile);
    setMediaPreview(null);
    setMediaResult(null);
    setMediaConfirmation("");
    setMediaError("");
    setMediaReady(false);
    setMediaSkipped(false);
    resetCatalogSelection();
  }

  async function previewMediaFile() {
    if (!mediaFile || mediaLoading) return;
    setMediaLoading("preview");
    setMediaError("");
    setMediaResult(null);
    setMediaReady(false);
    try {
      setMediaPreview(await adminApi.previewCatalogMediaPackage(mediaFile));
    } catch (cause) {
      setMediaPreview(null);
      setMediaError(errorMessage(cause));
    } finally {
      setMediaLoading(null);
    }
  }

  async function commitMediaFile() {
    if (!mediaFile || !mediaPreview?.canCommit || mediaConfirmation !== "SUBIR MEDIOS" || mediaLoading) return;
    setMediaLoading("commit");
    setMediaError("");
    try {
      const committed = await adminApi.commitCatalogMediaPackage(mediaFile, mediaPreview.fileSha256);
      setMediaResult(committed);
      setMediaPreview(null);
      setMediaConfirmation("");
      setMediaReady(true);
      setMediaSkipped(false);
    } catch (cause) {
      setMediaError(errorMessage(cause));
    } finally {
      setMediaLoading(null);
    }
  }

  function continueWithExistingMedia() {
    setMediaReady(true);
    setMediaSkipped(true);
    setMediaError("");
  }

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setResult(null);
    setConfirmation("");
    setProductLineNames({});
    setError("");
  }

  async function previewFile() {
    if (!file || loading || !mediaReady) return;
    setLoading("preview");
    setError("");
    setResult(null);
    try {
      const nextPreview = await adminApi.previewCatalogImport(file);
      setPreview(nextPreview);
      setProductLineNames(Object.fromEntries(nextPreview.productLinesToCreate.map((proposal) => [
        productLineApprovalKey(proposal.brandSlug, proposal.slug),
        proposal.suggestedName
      ])));
    } catch (cause) {
      setPreview(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  async function commitFile() {
    if (!file || !preview?.canCommit || confirmation !== requiredConfirmation || !productLineNamesAreValid || loading) return;
    setLoading("commit");
    setError("");
    try {
      const committed = await adminApi.commitCatalogImport(file, preview.fileSha256, productLineApprovals);
      setResult(committed);
      setPreview(null);
      setConfirmation("");
      setProductLineNames({});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="import-page">
      <div className="list-head">
        <div>
          <div className="eyebrow">Solo developer</div>
          <h1 className="page-title">Importar catálogo y medios</h1>
          <p className="page-sub">Sube primero el paquete seguro de imágenes y documentos; después previsualiza el XLSX antes de crear el catálogo.</p>
        </div>
        <a className="btn-secondary" href="/api/admin/importaciones/template">Descargar plantilla</a>
      </div>

      <section className="import-security">
        <strong>Contenedores restringidos</strong>
        <span>ZIP: máximo 32 MB, únicamente WebP/PDF válidos bajo <code>productos/</code>. Se bloquean scripts, ejecutables, rutas inseguras, cifrado, enlaces simbólicos, duplicados y compresión sospechosa.</span>
        <span>XLSX: máximo 8 MB. Se bloquean macros, VBA, ActiveX, OLE, objetos embebidos, conexiones, enlaces externos, fórmulas e hipervínculos.</span>
        <span>Los archivos originales ZIP/XLSX no se almacenan y los medios existentes nunca se sobrescriben.</span>
      </section>

      <div className="import-step-head">
        <span className={mediaReady ? "import-step-number import-step-number--done" : "import-step-number"}>{mediaReady ? "✓" : "1"}</span>
        <div><strong>Paquete de medios</strong><span>Sube imágenes y PDF conservando las rutas usadas por el Excel.</span></div>
      </div>

      <section className="form-card import-upload-card">
        <label className="import-dropzone">
          <input
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={(event) => chooseMediaFile(event.target.files?.[0] ?? null)}
          />
          <span className="import-dropzone-icon">ZIP</span>
          <strong>{mediaFile ? mediaFile.name : "Selecciona el paquete de medios"}</strong>
          <small>{mediaFile ? formatBytes(mediaFile.size) : "Se cargarán WebP/PDF; CSV y TXT informativos se ignoran"}</small>
        </label>
        <button type="button" className="btn-primary" disabled={!mediaFile || mediaLoading !== null} onClick={previewMediaFile}>
          {mediaLoading === "preview" ? "Inspeccionando…" : "Inspeccionar ZIP"}
        </button>
      </section>

      {!mediaReady ? (
        <div className="import-existing-option">
          <span>¿Los medios ya fueron cargados anteriormente?</span>
          <button type="button" className="btn-secondary" onClick={continueWithExistingMedia}>Continuar con medios existentes</button>
        </div>
      ) : null}

      {mediaError ? <div className="import-message import-message--error">{mediaError}</div> : null}

      {mediaPreview ? (
        <>
          <section className="form-card">
            <div className="import-preview-head">
              <div>
                <div className="form-title">Resultado de la inspección del ZIP</div>
                <div className="import-hash">SHA-256: {mediaPreview.fileSha256}</div>
              </div>
              <span className="import-status import-status--ok">Paquete seguro</span>
            </div>
            <div className="import-stats">
              {[
                ["Archivos", mediaPreview.summary.mediaFiles],
                ["WebP", mediaPreview.summary.webpFiles],
                ["PDF", mediaPreview.summary.pdfFiles],
                ["Por subir", mediaPreview.summary.filesToUpload],
                ["Ya existentes", mediaPreview.summary.existingFiles],
                ["Ignorados", mediaPreview.summary.ignoredFiles]
              ].map(([label, value]) => <div className="import-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}
            </div>
            <div className="import-security-checks">
              <span>✓ Firmas verificadas</span><span>✓ Solo productos/</span><span>✓ Sin ejecutables</span><span>✓ Sin sobrescritura</span><span>✓ ZIP no almacenado</span>
            </div>
            <div className="import-media-disposition">
              <strong>{mediaPreview.summary.mediaFiles} medios válidos sí se procesan.</strong>
              <span>
                Las rutas bajo <code>productos/</code> no están siendo ignoradas. Solo se excluyen {mediaPreview.summary.ignoredFiles} archivos informativos del paquete.
              </span>
            </div>
            <details className="import-details">
              <summary>Ver qué se procesará y qué se ignorará</summary>
              <div className="import-path-groups">
                <section className="import-path-group import-path-group--accepted">
                  <div className="import-path-heading">
                    <div>
                      <strong>Rutas válidas — SÍ se procesan</strong>
                      <span>Esta lista es solo una muestra; los demás medios válidos del ZIP también se procesan.</span>
                    </div>
                    <span className="import-path-count">{mediaPreview.samplePaths.length} ejemplos de {mediaPreview.summary.mediaFiles}</span>
                  </div>
                  <div className="import-path-list">
                    {mediaPreview.samplePaths.map((storagePath) => <code key={storagePath}>{storagePath}</code>)}
                  </div>
                </section>

                <section className="import-path-group import-path-group--ignored">
                  <div className="import-path-heading">
                    <div>
                      <strong>Archivos informativos — NO se almacenan</strong>
                      <span>Estos archivos ayudan a preparar el paquete, pero no forman parte del catálogo.</span>
                    </div>
                    <span className="import-path-count">{mediaPreview.summary.ignoredFiles} ignorados</span>
                  </div>
                  <div className="import-path-list import-path-list--ignored">
                    {mediaPreview.ignored.length > 0
                      ? mediaPreview.ignored.map((item) => <span key={item.path}><code>{item.path}</code> — {item.reason}</span>)
                      : <span>Ningún archivo ignorado.</span>}
                  </div>
                </section>
              </div>
            </details>
          </section>

          <section className="form-card import-confirm">
            <div>
              <div className="form-title">Confirmar carga de medios</div>
              <p>Se subirán {mediaPreview.summary.filesToUpload} archivos y se conservarán {mediaPreview.summary.existingFiles} existentes. Escribe <b>SUBIR MEDIOS</b>.</p>
            </div>
            <input className="input" value={mediaConfirmation} onChange={(event) => setMediaConfirmation(event.target.value.toUpperCase())} placeholder="SUBIR MEDIOS" autoComplete="off" />
            <button type="button" className="btn-primary" disabled={mediaConfirmation !== "SUBIR MEDIOS" || mediaLoading !== null} onClick={commitMediaFile}>
              {mediaLoading === "commit" ? "Subiendo…" : "Subir medios"}
            </button>
          </section>
        </>
      ) : null}

      {mediaResult ? (
        <section className="form-card import-result">
          <div className="import-result-mark">✓</div>
          <div>
            <div className="form-title">Medios disponibles</div>
            <p>Se subieron {mediaResult.uploadedFiles} archivos ({formatBytes(mediaResult.uploadedBytes)}) y se conservaron {mediaResult.existingFiles} existentes. Lote: <code>{mediaResult.batchId}</code>.</p>
          </div>
        </section>
      ) : null}

      {mediaSkipped ? <div className="import-message import-message--warning">Se omitió el ZIP. La previsualización del XLSX comprobará que cada ruta exista en <code>catalog-assets</code>.</div> : null}

      <div className="import-step-head">
        <span className="import-step-number">2</span>
        <div><strong>Archivo de catálogo</strong><span>{mediaReady ? "Selecciona el XLSX y ejecuta la validación final." : "Completa o confirma primero el paso de medios."}</span></div>
      </div>

      <section className={`form-card import-upload-card${mediaReady ? "" : " import-upload-card--disabled"}`}>
        <label className="import-dropzone">
          <input
            type="file"
            disabled={!mediaReady}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
          <span className="import-dropzone-icon">XLSX</span>
          <strong>{file ? file.name : "Selecciona el archivo de importación"}</strong>
          <small>{file ? formatBytes(file.size) : "No se aceptan .xlsm, .xls ni .xlsb"}</small>
        </label>
        <button type="button" className="btn-primary" disabled={!mediaReady || !file || loading !== null} onClick={previewFile}>
          {loading === "preview" ? "Inspeccionando…" : "Inspeccionar y previsualizar"}
        </button>
      </section>

      {error ? <div className="import-message import-message--error">{error}</div> : null}

      {preview ? (
        <>
          <section className="form-card">
            <div className="import-preview-head">
              <div>
                <div className="form-title">Resultado de la previsualización</div>
                <div className="import-hash">SHA-256: {preview.fileSha256}</div>
              </div>
              <span className={preview.canCommit ? "import-status import-status--ok" : "import-status import-status--bad"}>
                {preview.canCommit
                  ? (preview.productLinesToCreate.length ? "Listo con autorización" : "Listo para importar")
                  : "Requiere correcciones"}
              </span>
            </div>
            <div className="import-stats">
              {[
                ["Productos", preview.summary.products],
                ["Variantes", preview.summary.variants],
                ["Líneas nuevas", preview.summary.productLinesToCreate],
                ["Tonos nuevos", preview.summary.tonesToCreate],
                ["Atributos", preview.summary.productAttributes + preview.summary.variantAttributes],
                ["Medios", preview.summary.media],
                ["Relaciones", preview.summary.relations]
              ].map(([label, value]) => <div className="import-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}
            </div>
            <div className="import-security-checks">
              <span>✓ Sin macros</span><span>✓ Sin fórmulas</span><span>✓ Sin enlaces externos</span><span>✓ Sin objetos embebidos</span><span>✓ Original no almacenado</span>
            </div>
          </section>

          {preview.productLinesToCreate.length ? (
            <section className="form-card import-structure-proposals">
              <div className="import-preview-head">
                <div>
                  <div className="form-title">Líneas de producto propuestas</div>
                  <p>Ninguna línea se crea durante la previsualización. Revisa o edita el nombre y autoriza su creación junto con la importación.</p>
                </div>
                <span>{preview.productLinesToCreate.length} por autorizar</span>
              </div>
              <div className="import-proposal-list">
                {preview.productLinesToCreate.map((proposal) => {
                  const key = productLineApprovalKey(proposal.brandSlug, proposal.slug);
                  return (
                    <div className="import-proposal" key={key}>
                      <div className="import-proposal-meta">
                        <strong>{proposal.brandName}</strong>
                        <span>Slug: <code>{proposal.slug}</code></span>
                        <span>Familias: {proposal.templateCodes.join(", ")}</span>
                      </div>
                      <label>
                        <span>Nombre de la línea a crear</span>
                        <input
                          className="input"
                          maxLength={120}
                          value={productLineNames[key] ?? ""}
                          onChange={(event) => setProductLineNames((current) => ({ ...current, [key]: event.target.value }))}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {preview.products.length ? (
            <section className="form-card import-table-wrap">
              <div className="form-title">Productos seleccionados</div>
              <table className="import-table">
                <thead><tr><th>Código</th><th>Producto</th><th>Marca / línea</th><th>Variantes</th><th>Estado</th></tr></thead>
                <tbody>{preview.products.map((product) => (
                  <tr key={product.code}><td><code>{product.code}</code></td><td>{product.name}</td><td>{product.brand}{product.line ? ` · ${product.line}` : ""}</td><td>{product.variants}</td><td>{product.editorialStatus}</td></tr>
                ))}</tbody>
              </table>
            </section>
          ) : null}

          {preview.issues.length ? (
            <section className="form-card import-table-wrap">
              <div className="import-preview-head">
                <div className="form-title">Validaciones</div>
                <span>{preview.summary.errors} errores · {preview.summary.warnings} advertencias</span>
              </div>
              <table className="import-table import-issues-table">
                <thead><tr><th>Nivel</th><th>Ubicación</th><th>Detalle</th></tr></thead>
                <tbody>{preview.issues.map((issue, index) => (
                  <tr key={`${issue.code}-${index}`}>
                    <td><span className={`import-level import-level--${issue.severity}`}>{issue.severity === "error" ? "Error" : "Aviso"}</span></td>
                    <td>{issue.sheet ?? "Archivo"}{issue.row ? ` · fila ${issue.row}` : ""}{issue.field ? ` · ${issue.field}` : ""}</td>
                    <td>{issue.message}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          ) : null}

          {preview.canCommit ? (
            <section className="form-card import-confirm">
              <div>
                <div className="form-title">Confirmación final</div>
                <p>
                  El servidor volverá a inspeccionar el mismo archivo y comprobará su hash antes de escribir.
                  {preview.productLinesToCreate.length ? " También verificará que las líneas autorizadas coincidan exactamente con las propuestas vigentes." : ""}
                  {" "}Escribe <b>{requiredConfirmation}</b> para continuar.
                </p>
              </div>
              <input className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder={requiredConfirmation} autoComplete="off" />
              <button type="button" className="btn-primary" disabled={confirmation !== requiredConfirmation || !productLineNamesAreValid || loading !== null} onClick={commitFile}>
                {loading === "commit"
                  ? "Importando…"
                  : `${preview.productLinesToCreate.length ? "Autorizar y crear" : "Crear"} ${preview.summary.products} producto${preview.summary.products === 1 ? "" : "s"}`}
              </button>
            </section>
          ) : null}
        </>
      ) : null}

      {result ? (
        <section className="form-card import-result">
          <div className="import-result-mark">✓</div>
          <div>
            <div className="form-title">Importación completada</div>
            <p>Se crearon {result.products.length} productos, {result.createdProductLineCount} líneas y {result.createdToneCount} tonos. Lote de auditoría: <code>{result.batchId}</code>.</p>
            <div className="import-result-products">{result.products.map((product) => <span key={product.id}>{product.code} · {product.name}</span>)}</div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
