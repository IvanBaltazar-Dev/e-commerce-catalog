"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiError } from "@/components/admin/useApiError";
import type {
  InventoryBoardData,
  InventoryBoardItem,
} from "@/lib/admin/inventory-board-contract";

/**
 * D1 Existencias y D2 Reposición: la misma vista con distinta pregunta.
 *
 * D1 responde «¿cuánto tengo de esto?» y deja abrir los movimientos que
 * explican esa cantidad. D2 responde «¿qué tengo que reponer y por qué?».
 * Comparten componente porque comparten fila y comparten definición: si cada
 * una decidiera por su cuenta qué está por agotarse, la dueña vería dos
 * respuestas distintas a la misma pregunta.
 */

type Movimiento = {
  occurredAt: string;
  movementType: string;
  quantity: number;
  balanceAfter: number;
  sourceLabel: string | null;
  reason: string | null;
};

const MOTIVO: Record<string, { texto: string; clase: string }> = {
  agotado: { texto: "Agotado", clase: "inv-tag inv-tag--agotado" },
  cobertura: { texto: "Se agota pronto", clase: "inv-tag inv-tag--cobertura" }
};

export function InventoryBoardView({
  soloReposicion,
  initialData,
}: {
  soloReposicion: boolean;
  initialData: InventoryBoardData;
}) {
  const handleApiError = useApiError();
  const skipInitialRequest = useRef(true);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<InventoryBoardItem[]>(initialData.items);
  const [rango, setRango] = useState(initialData.rango);
  const [cargando, setCargando] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [cargandoMov, setCargandoMov] = useState(false);

  const cargar = useCallback(async (termino: string) => {
    setCargando(true);
    try {
      const params = new URLSearchParams();
      if (termino.trim()) params.set("q", termino.trim());
      if (soloReposicion) params.set("reposition", "true");
      const res = await fetch(`/api/admin/inventory/board?${params.toString()}`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error?.message ?? "No se pudo cargar el inventario.");
      setItems((payload?.data?.items ?? []) as InventoryBoardItem[]);
      setRango(payload?.data?.rango ?? null);
    } catch (error) {
      handleApiError(error, "No se pudo cargar el inventario.");
    } finally {
      setCargando(false);
    }
  }, [handleApiError, soloReposicion]);

  useEffect(() => {
    if (skipInitialRequest.current) {
      skipInitialRequest.current = false;
      return;
    }
    const timer = window.setTimeout(() => { cargar(query); }, 220);
    return () => window.clearTimeout(timer);
  }, [query, cargar]);

  /** Los movimientos son la explicación de la cantidad, no un extra. */
  async function abrirMovimientos(item: InventoryBoardItem) {
    if (abierta === item.variantId) { setAbierta(null); return; }
    setAbierta(item.variantId);
    setCargandoMov(true);
    setMovimientos([]);
    try {
      const res = await fetch(
        `/api/admin/inventory/kardex?variant=${item.variantId}&branch=${item.branchId}`
      );
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error?.message ?? "No se pudieron cargar los movimientos.");
      const filas = payload?.data?.items ?? payload?.data?.movements ?? payload?.data ?? [];
      setMovimientos(Array.isArray(filas) ? filas : []);
    } catch (error) {
      handleApiError(error, "No se pudieron cargar los movimientos.");
    } finally {
      setCargandoMov(false);
    }
  }

  const resumen = useMemo(() => {
    const agotadas = items.filter((i) => i.reason === "agotado").length;
    const pronto = items.filter((i) => i.reason === "cobertura").length;
    return { agotadas, pronto };
  }, [items]);

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head">
        <div>
          <div className="form-title">{soloReposicion ? "Reposición" : "Existencias"}</div>
          <div className="field-hint">
            {soloReposicion
              ? "Lo que hay que reponer y por qué. La cobertura sale de las salidas del periodo."
              : "La unidad es la variante. Cada cantidad se explica con sus movimientos."}
            {rango ? ` Periodo: ${rango.desde} a ${rango.hasta} (${rango.dias} días).` : null}
          </div>
        </div>
      </div>

      <section className="form-card">
        <input
          className="input order-search inv-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Producto, SKU, marca o tono…"
          autoFocus
        />

        {soloReposicion && !cargando && items.length > 0 ? (
          <div className="inv-summary">
            <span><b>{resumen.agotadas}</b> agotada(s)</span>
            <span><b>{resumen.pronto}</b> se agota(n) pronto</span>
          </div>
        ) : null}

        {cargando ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
        ) : items.length === 0 ? (
          <div className="order-empty">
            {soloReposicion
              ? "Nada pide reposición ahora mismo."
              : query.trim()
                ? `Nada coincide con «${query.trim()}».`
                : "No hay existencias registradas."}
          </div>
        ) : (
          <div className="inv-rows">
            {items.map((item) => (
              <div key={`${item.variantId}-${item.branchId}`} className="inv-row">
                <div className="inv-row-head">
                  <span
                    className="pos-swatch"
                    style={item.referenceColor ? { background: item.referenceColor } : undefined}
                    aria-hidden="true"
                  />
                  <div className="pos-result-main">
                    <span className="order-product-brand">{item.brandName}</span>
                    <strong>{item.productName}</strong>
                    <small>
                      {[item.shadeName ?? item.variantName, item.shadeCode, item.sku, item.branchName]
                        .filter(Boolean).join(" · ")}
                    </small>
                  </div>

                  <div className="inv-qty">
                    <span className="inv-qty-main">{item.available}</span>
                    <small>
                      {item.reserved > 0 ? `${item.onHand} en mano · ${item.reserved} reservadas` : "disponibles"}
                    </small>
                  </div>

                  <div className="inv-signal">
                    {item.reason ? (
                      <span className={MOTIVO[item.reason].clase}>{MOTIVO[item.reason].texto}</span>
                    ) : null}
                    <small>
                      {/* Cuando no se puede estimar, se dice. Un cero aquí parecería un dato. */}
                      {item.coverageDays === null
                        ? "sin salidas: cobertura no estimable"
                        : `~${item.coverageDays} días de cobertura`}
                    </small>
                  </div>

                  <div className="inv-actions">
                    <button type="button" className="btn-ghost" onClick={() => abrirMovimientos(item)}>
                      {abierta === item.variantId ? "Ocultar" : "Movimientos"}
                    </button>
                    {soloReposicion ? (
                      <Link className="btn-soft" href={`/admin/compras?variante=${item.variantId}`}>Reponer →</Link>
                    ) : null}
                  </div>
                </div>

                {abierta === item.variantId ? (
                  <div className="inv-ledger">
                    {cargandoMov ? (
                      <div className="order-loading"><span className="spinner spinner--pink" /> Cargando movimientos…</div>
                    ) : movimientos.length === 0 ? (
                      <div className="order-empty">Esta variante no tiene movimientos registrados.</div>
                    ) : (
                      <table className="ops-table">
                        <thead>
                          <tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Saldo</th><th>Origen</th></tr>
                        </thead>
                        <tbody>
                          {movimientos.slice(0, 25).map((mov, index) => (
                            <tr key={`${mov.occurredAt}-${index}`}>
                              <td>{new Date(mov.occurredAt).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })}</td>
                              <td>{mov.movementType}</td>
                              <td>{mov.quantity > 0 ? `+${mov.quantity}` : mov.quantity}</td>
                              <td>{mov.balanceAfter}</td>
                              <td>{mov.sourceLabel ?? mov.reason ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
