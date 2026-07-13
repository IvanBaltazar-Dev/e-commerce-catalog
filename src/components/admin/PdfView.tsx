"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, formatDateTime } from "@/lib/admin/api";
import type { ApiPdfExport } from "@/lib/admin/types";

type PdfEstado = "Actualizado" | "Desactualizado" | "Generando" | "No generado" | "Error";

const BADGE_COLORS: Record<PdfEstado, { bg: string; fg: string; dot: string }> = {
  Actualizado: { bg: "#F2FBF5", fg: "#1E7A46", dot: "#2E9E5B" },
  Desactualizado: { bg: "#FDF3E3", fg: "#B07A2A", dot: "#D9A23C" },
  Generando: { bg: "#FDE6F1", fg: "#C42B7E", dot: "#E23E93" },
  "No generado": { bg: "#F3EDEF", fg: "#9A8492", dot: "#C9B2BD" },
  Error: { bg: "#FDECEC", fg: "#B03A3A", dot: "#D05252" }
};

function deriveEstado(latest: ApiPdfExport | null, generating: boolean): PdfEstado {
  if (generating) {
    return "Generando";
  }

  if (!latest) {
    return "No generado";
  }

  if (latest.status === "generating") {
    return "Generando";
  }

  if (latest.status === "error") {
    return "Error";
  }

  if (latest.status === "updated") {
    return latest.isStale ? "Desactualizado" : "Actualizado";
  }

  if (latest.status === "outdated") {
    return "Desactualizado";
  }

  return "No generado";
}

export function PdfView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [latest, setLatest] = useState<ApiPdfExport | null>(null);
  const [publishedCount, setPublishedCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    const [status, products] = await Promise.all([
      adminApi.pdfStatus(),
      adminApi.listProducts()
    ]);
    setLatest(status.items[0] ?? null);
    setPublishedCount(products.filter((product) => product.is_active).length);
  }, []);

  useEffect(() => {
    let cancelled = false;

    load()
      .catch((error) => {
        if (!cancelled) {
          handleApiError(error, "No se pudo cargar el estado del PDF.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load, handleApiError]);

  async function handleGenerate() {
    if (generating) {
      return;
    }

    setGenerating(true);

    try {
      await adminApi.pdfGenerate();
      await load();
      showToast("PDF generado con éxito ✓");
    } catch (error) {
      handleApiError(error, "No se pudo generar el PDF.");
      await load().catch(() => {});
    } finally {
      setGenerating(false);
    }
  }

  async function withDownloadUrl(action: (url: string) => void, missingMessage: string) {
    if (!latest || latest.status !== "updated" || !latest.storage_path) {
      showToast(missingMessage);
      return;
    }

    if (opening) {
      return;
    }

    setOpening(true);

    try {
      const { downloadUrl } = await adminApi.pdfDownloadUrl(latest.id);
      action(downloadUrl);
    } catch (error) {
      handleApiError(error, "No se pudo obtener el PDF.");
    } finally {
      setOpening(false);
    }
  }

  function handlePreview() {
    withDownloadUrl(
      (url) => window.open(url, "_blank", "noopener"),
      "Genera el PDF primero para ver la vista previa"
    );
  }

  function handleDownload() {
    withDownloadUrl((url) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = "Catalogo-Bellaroshe.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast("Descargando Catalogo-Bellaroshe.pdf ✓");
    }, "Genera el PDF primero para descargar la versión actual");
  }

  if (!loaded) {
    return (
      <div className="loading-block">
        <span className="spinner spinner--pink" /> Cargando estado del PDF…
      </div>
    );
  }

  const estado = deriveEstado(latest, generating);
  const badge = BADGE_COLORS[estado];

  return (
    <div className="pdf-page br-fade">
      <div className="page-title">Catálogo PDF</div>
      <div className="page-sub">
        Genera y descarga la versión imprimible. No aparece en la web pública.
      </div>

      <div className="pdf-card">
        <div className="pdf-file">
          <div className="pdf-icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C42B7E"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </div>
          <div className="pdf-info">
            <div className="pdf-name-row">
              <span className="pdf-name">Catálogo Bellaroshé</span>
              <span
                className="badge-status"
                style={{ background: badge.bg, color: badge.fg }}
              >
                <span className="dot" style={{ background: badge.dot }} />
                {estado}
              </span>
            </div>
            <div className="pdf-meta">
              Última generación: {formatDateTime(latest?.generated_at ?? null)} · Productos
              incluidos: {publishedCount}
            </div>
          </div>
        </div>

        {generating ? (
          <div className="gen-banner">
            <span className="spinner spinner--amber" />
            Generando el PDF con las fotos y precios actuales…
          </div>
        ) : null}

        {estado === "Error" && latest?.error_message ? (
          <div className="login-error" style={{ marginTop: 16 }}>
            {latest.error_message}
          </div>
        ) : null}

        <div className="pdf-actions">
          <button type="button" className="btn-soft" onClick={handlePreview} disabled={opening}>
            Vista previa
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleGenerate}
            disabled={generating}
          >
            Generar nuevo PDF
          </button>
          <button
            type="button"
            className="btn-success"
            onClick={handleDownload}
            disabled={opening}
          >
            Descargar PDF
          </button>
        </div>
      </div>

      <div className="hint-card">
        El PDF incluye portada con logo y WhatsApp, una página por producto con precios por unidad
        y por mayor, y la carta de colores cuando exista. Si cambias precios o fotos, vuelve a
        generarlo.
      </div>
    </div>
  );
}
