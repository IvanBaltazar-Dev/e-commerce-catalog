"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApi } from "@/lib/admin/api";
import { useApiError } from "@/components/admin/useApiError";
import { SaleNote } from "@/components/admin/SaleNote";
import { TaxDocumentSheet } from "@/components/admin/TaxDocumentSheet";
import type { Sale } from "@/lib/admin/sales";

type PaperWidth = 58 | 80;
const PAPER_WIDTH_STORAGE_KEY = "bellaroshe.thermal-paper-width";

/**
 * La nota impresa de una venta ya registrada.
 *
 * Vive en su propia ruta y no en un modal: la vendedora la abre, imprime y
 * vuelve a vender. Y así el enlace se puede reabrir después desde el historial
 * sin repetir la venta.
 */
export function SaleNoteView({ saleId }: { saleId: string }) {
  const handleApiError = useApiError();
  const [sale, setSale] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  // Nivel 3 (SKU, códigos internos) NO se imprime por omisión: vive en la venta
  // digital. Esta casilla es la excepción consciente para control interno.
  const [printSku, setPrintSku] = useState(false);
  const [paperWidth, setPaperWidth] = useState<PaperWidth>(80);
  const [taxOpen, setTaxOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(PAPER_WIDTH_STORAGE_KEY);
    if (stored === "58" || stored === "80") setPaperWidth(Number(stored) as PaperWidth);
  }, []);

  function changePaperWidth(value: string) {
    const next = value === "58" ? 58 : 80;
    setPaperWidth(next);
    window.localStorage.setItem(PAPER_WIDTH_STORAGE_KEY, String(next));
  }

  useEffect(() => {
    let cancelled = false;
    adminApi
      .getSale(saleId)
      .then((result) => { if (!cancelled) setSale(result); })
      .catch((error) => { if (!cancelled) handleApiError(error, "No se pudo abrir la nota de esta venta."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [saleId, handleApiError]);

  return (
    <div className={`form-page br-fade print-page--${paperWidth}`}>
      <div className="form-head ticket-noprint">
        <div>
          <div className="form-title">Nota de venta {sale?.saleNumber ?? ""}</div>
          <div className="field-hint">
            Documento interno de control. El comprobante fiscal es otro trámite y se solicita aparte.
          </div>
        </div>
        <div className="order-actions">
          <label className="tone-toggle">
            <input type="checkbox" checked={printSku} onChange={(event) => setPrintSku(event.target.checked)} />
            Imprimir códigos
          </label>
          <label className="ticket-paper-select">
            Papel
            <select value={paperWidth} onChange={(event) => changePaperWidth(event.target.value)}>
              <option value="80">80 mm</option>
              <option value="58">58 mm</option>
            </select>
          </label>
          <Link className="btn-soft" href="/admin/ventas">Volver a vender</Link>
          {/* La solicitud del comprobante se hace SOBRE una venta ya registrada
              y no es condición para nada: la venta existe, esté o no pedida. */}
          <button type="button" className="btn-soft" disabled={!sale} onClick={() => setTaxOpen(true)}>
            {sale?.taxDocument ? "Cambiar documento" : "Documento"}
          </button>
          <button type="button" className="btn-save" disabled={!sale} onClick={() => window.print()}>
            Imprimir
          </button>
        </div>
      </div>

      <details className="ticket-setup ticket-noprint">
        <summary>Configurar impresora térmica Bluetooth</summary>
        <p>En el cuadro de impresión selecciona la impresora Bluetooth real, no “Guardar como PDF” ni “Microsoft Print to PDF”.</p>
        <p>En Preferencias de impresión usa papel de <strong>{paperWidth} mm</strong>, escala 100 %, márgenes 0 y desactiva “Ajustar a página”.</p>
        <p>Si la impresora solo avanza papel, instala su controlador ESC/POS del fabricante: un controlador “Generic/Text Only” no interpreta este ticket gráfico.</p>
      </details>

      {loading ? (
        <div className="order-loading ticket-noprint"><span className="spinner spinner--pink" /> Cargando la nota…</div>
      ) : !sale ? (
        <div className="order-empty ticket-noprint">No se encontró esta venta.</div>
      ) : (
        <div className="ticket-stage">
          <div className="ticket-paper">
            <SaleNote sale={sale} printSku={printSku} />
          </div>
        </div>
      )}

      {taxOpen && sale ? (
        <TaxDocumentSheet sale={sale} onClose={() => setTaxOpen(false)} onDone={setSale} />
      ) : null}
    </div>
  );
}
