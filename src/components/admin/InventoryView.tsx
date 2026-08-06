"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch } from "@/lib/admin/api";
import {
  MOVEMENT_TYPE_LABELS,
  type InventoryPosition,
  type KardexEntry
} from "@/lib/admin/operations";

function money(value: number | null) {
  if (value === null) return "—";
  return `S/ ${value.toFixed(2)}`;
}

function units(value: number) {
  return new Intl.NumberFormat("es-PE").format(value);
}

/**
 * Existencias por sede y kardex por presentación.
 *
 * Ningún importe se calcula aquí: cantidades, disponibilidad y valoración
 * llegan resueltos de `inventory_position`. Las columnas de costo aparecen
 * vacías para la vendedora porque la RLS no le devuelve esas filas, no porque
 * la pantalla las esconda.
 */
export function InventoryView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [search, setSearch] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [items, setItems] = useState<InventoryPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [kardexOf, setKardexOf] = useState<InventoryPosition | null>(null);
  const [kardex, setKardex] = useState<KardexEntry[]>([]);
  const [adjusting, setAdjusting] = useState<InventoryPosition | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listInventory({ branchId, search, onlyLow });
      setItems(result);
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las existencias.");
    } finally {
      setLoading(false);
    }
  }, [branchId, search, onlyLow, handleApiError]);

  useEffect(() => {
    adminApi.listBranches().then(setBranches).catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const totals = useMemo(() => {
    const value = items.reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
    const anyValued = items.some((item) => item.totalValue !== null);
    return {
      lines: items.length,
      onHand: items.reduce((sum, item) => sum + item.onHand, 0),
      reserved: items.reduce((sum, item) => sum + item.reserved, 0),
      unvalued: items.reduce((sum, item) => sum + item.unvaluedQuantity, 0),
      value: anyValued ? value : null
    };
  }, [items]);

  async function openKardex(item: InventoryPosition) {
    setKardexOf(item);
    setKardex([]);
    try {
      setKardex(await adminApi.getKardex(item.variantId, item.branchId));
    } catch (error) {
      handleApiError(error, "No se pudo cargar el kardex.");
    }
  }

  async function submitAdjustment() {
    if (!adjusting || saving) return;

    const quantity = Number.parseInt(adjustQty, 10);

    if (!Number.isInteger(quantity) || quantity === 0) {
      showToast("Indica cuántas unidades sumar o restar");
      return;
    }

    if (!adjustReason.trim()) {
      showToast("Un ajuste exige un motivo");
      return;
    }

    setSaving(true);
    try {
      await adminApi.adjustInventory({
        variantId: adjusting.variantId,
        branchId: adjusting.branchId,
        quantity,
        reason: adjustReason.trim()
      });
      showToast("Ajuste registrado");
      setAdjusting(null);
      setAdjustQty("");
      setAdjustReason("");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo registrar el ajuste.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-page">
      <header className="ops-head">
        <div>
          <h1>Inventario</h1>
          <p>Existencias por sede, con su kardex y su valoración.</p>
        </div>
      </header>

      <div className="ops-filters">
        <input
          className="input"
          placeholder="Buscar por SKU, producto o presentación…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
          <option value="">Todas mis sedes</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>{branch.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={onlyLow ? "opt-chip opt-chip--active" : "opt-chip"}
          onClick={() => setOnlyLow((value) => !value)}
        >
          Solo bajo stock
        </button>
      </div>

      <div className="ops-totals">
        <div><span>Presentaciones</span><b>{units(totals.lines)}</b></div>
        <div><span>En existencia</span><b>{units(totals.onHand)}</b></div>
        <div><span>Comprometido</span><b>{units(totals.reserved)}</b></div>
        <div>
          <span>Sin valorar</span>
          <b>{units(totals.unvalued)}</b>
          {totals.unvalued > 0 ? <small>unidades con costo desconocido</small> : null}
        </div>
        <div><span>Valor</span><b>{money(totals.value)}</b></div>
      </div>

      {loading ? (
        <p className="ops-empty">Cargando existencias…</p>
      ) : items.length === 0 ? (
        <p className="ops-empty">
          No hay existencias registradas todavía. Empieza por la carga inicial.
        </p>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Presentación</th>
                <th>Sede</th>
                <th className="num">Físico</th>
                <th className="num">Comprometido</th>
                <th className="num">Disponible</th>
                <th className="num">Costo prom.</th>
                <th className="num">Valor</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.variantId}-${item.branchId}`} className={item.available <= 0 ? "row-alert" : undefined}>
                  <td>
                    <b>{item.productName}</b>
                    <small>{item.variantName} · {item.sku ?? "sin SKU"}</small>
                    {item.unvaluedQuantity > 0 ? (
                      <small className="tag-warn">{units(item.unvaluedQuantity)} sin costo conocido</small>
                    ) : null}
                  </td>
                  <td>{item.branchName}</td>
                  <td className="num">{units(item.onHand)}</td>
                  <td className="num">{units(item.reserved)}</td>
                  <td className="num"><b>{units(item.available)}</b></td>
                  <td className="num">{money(item.averageUnitCost)}</td>
                  <td className="num">{money(item.totalValue)}</td>
                  <td className="actions">
                    <button type="button" onClick={() => openKardex(item)}>Kardex</button>
                    <button type="button" onClick={() => setAdjusting(item)}>Ajustar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {kardexOf ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body">
            <header>
              <div>
                <b>Kardex · {kardexOf.productName}</b>
                <small>{kardexOf.variantName} · {kardexOf.branchName}</small>
              </div>
              <button type="button" onClick={() => setKardexOf(null)}>Cerrar</button>
            </header>
            {kardex.length === 0 ? (
              <p className="ops-empty">Sin movimientos registrados.</p>
            ) : (
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Movimiento</th>
                    <th className="num">Cantidad</th>
                    <th className="num">Saldo</th>
                    <th className="num">Costo unit.</th>
                    <th>Origen</th>
                    <th>Responsable</th>
                  </tr>
                </thead>
                <tbody>
                  {kardex.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.occurredAt).toLocaleString("es-PE")}</td>
                      <td>
                        {MOVEMENT_TYPE_LABELS[entry.movementType] ?? entry.movementType}
                        {entry.costBasis === "unknown" ? <small className="tag-warn">costo desconocido</small> : null}
                        {entry.costBasis === "mixed" ? <small className="tag-warn">costo mixto</small> : null}
                      </td>
                      <td className="num">{entry.quantity > 0 ? `+${units(entry.quantity)}` : units(entry.quantity)}</td>
                      <td className="num">{units(entry.balanceAfter)}</td>
                      <td className="num">{money(entry.unitCost)}</td>
                      <td>{entry.sourceLabel ?? entry.reason ?? "—"}</td>
                      <td>{entry.actorLabel ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}

      {adjusting ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body ops-drawer-body--narrow">
            <header>
              <div>
                <b>Ajustar existencia</b>
                <small>{adjusting.productName} · {adjusting.variantName} · {adjusting.branchName}</small>
              </div>
              <button type="button" onClick={() => setAdjusting(null)}>Cerrar</button>
            </header>
            <label className="product-field">
              <span className="field-label">Unidades a sumar o restar *</span>
              <input
                className="input"
                inputMode="numeric"
                placeholder="Ej. -3 para dar de baja 3"
                value={adjustQty}
                onChange={(event) => setAdjustQty(event.target.value)}
              />
              <small className="field-hint">
                Actualmente hay {units(adjusting.onHand)} en físico y {units(adjusting.reserved)} comprometidas.
              </small>
            </label>
            <label className="product-field">
              <span className="field-label">Motivo *</span>
              <textarea
                className="input"
                rows={3}
                placeholder="Rotura, merma, corrección de conteo…"
                value={adjustReason}
                onChange={(event) => setAdjustReason(event.target.value)}
              />
            </label>
            <div className="product-step-actions">
              <button type="button" className="btn-cancel" onClick={() => setAdjusting(null)}>Cancelar</button>
              <button type="button" className="btn-save" disabled={saving} onClick={submitAdjustment}>
                {saving ? "Registrando…" : "Registrar ajuste"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
