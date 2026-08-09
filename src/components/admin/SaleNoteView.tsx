"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApi } from "@/lib/admin/api";
import { useApiError } from "@/components/admin/useApiError";
import { SaleNote } from "@/components/admin/SaleNote";
import type { Sale } from "@/lib/admin/sales";

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
    <div className="form-page br-fade">
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
          <Link className="btn-soft" href="/admin/ventas">Volver a vender</Link>
          <button type="button" className="btn-save" disabled={!sale} onClick={() => window.print()}>
            Imprimir
          </button>
        </div>
      </div>

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
    </div>
  );
}
