"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch } from "@/lib/admin/api";
import { CASH_MOVEMENT_LABELS, type CashMovement, type CashSession } from "@/lib/admin/operations";
import { PAYMENT_METHOD_LABELS } from "@/lib/admin/sales";

function money(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `S/ ${value.toFixed(2)}`;
}

/**
 * Apertura, movimientos, arqueo y cierre de caja.
 *
 * El efectivo esperado lo calcula PostgreSQL —solo cuenta los movimientos en
 * efectivo, porque nadie cuenta Yapes a mano al cerrar— y la diferencia se
 * congela al cerrar. Esta pantalla no suma nada: muestra lo que la base resolvió.
 */
export function CashView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [selected, setSelected] = useState<CashSession | null>(null);
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [openBranch, setOpenBranch] = useState("");
  const [openFloat, setOpenFloat] = useState("0");
  const [closing, setClosing] = useState(false);
  const [countedCash, setCountedCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await adminApi.listCashSessions();
      setSessions(items);
      const open = items.find((session) => session.status === "open");
      if (open) await openDetail(open.id);
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las cajas.");
    } finally {
      setLoading(false);
    }
    // openDetail es estable: no depende de estado que cambie entre renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleApiError]);

  async function openDetail(id: string) {
    try {
      const result = await adminApi.getCashSession(id);
      setSelected(result.session);
      setMovements(result.movements);
    } catch (error) {
      handleApiError(error, "No se pudo cargar el detalle de la caja.");
    }
  }

  useEffect(() => {
    adminApi.listBranches().then((items) => {
      setBranches(items);
      const preferred = items.find((branch) => branch.isDefault) ?? items[0];
      if (preferred) setOpenBranch(preferred.id);
    }).catch(() => setBranches([]));
    load();
  }, [load]);

  const openSession = sessions.find((session) => session.status === "open") ?? null;

  async function submitOpen() {
    if (saving) return;

    if (!openBranch) {
      showToast("Elige la sede");
      return;
    }

    setSaving(true);
    try {
      const session = await adminApi.openCashSession({
        branchId: openBranch,
        openingFloat: Number(openFloat.replace(",", ".")) || 0
      });
      showToast(`Caja ${session.sessionNumber} abierta`);
      setOpening(false);
      setOpenFloat("0");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo abrir la caja.");
    } finally {
      setSaving(false);
    }
  }

  async function submitClose() {
    if (!selected || saving) return;

    const counted = Number(countedCash.replace(",", "."));

    if (!Number.isFinite(counted) || counted < 0) {
      showToast("Declara el efectivo contado");
      return;
    }

    setSaving(true);
    try {
      const session = await adminApi.closeCashSession(selected.id, {
        countedCash: counted,
        note: closeNote.trim() || null
      });
      const difference = session.difference ?? 0;
      showToast(
        difference === 0
          ? "Caja cerrada sin diferencia"
          : `Caja cerrada con ${difference > 0 ? "sobrante" : "faltante"} de ${money(Math.abs(difference))}`
      );
      setClosing(false);
      setCountedCash("");
      setCloseNote("");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo cerrar la caja.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-page">
      <header className="ops-head">
        <div>
          <h1>Caja</h1>
          <p>Apertura, arqueo y cierre. Solo el efectivo cuadra el cajón.</p>
        </div>
        {openSession ? (
          <button type="button" className="btn-save" onClick={() => setClosing(true)}>
            Cerrar caja
          </button>
        ) : (
          <button type="button" className="btn-save" onClick={() => setOpening(true)}>
            Abrir caja
          </button>
        )}
      </header>

      {loading ? (
        <p className="ops-empty">Cargando…</p>
      ) : !openSession ? (
        <p className="ops-empty">
          No hay caja abierta. Ábrela para que las ventas en efectivo, los gastos y
          los reembolsos queden registrados en el cajón.
        </p>
      ) : null}

      {selected ? (
        <>
          <div className="ops-totals">
            <div><span>Caja</span><b>{selected.sessionNumber}</b><small>{selected.status === "open" ? "Abierta" : "Cerrada"}</small></div>
            <div><span>Fondo inicial</span><b>{money(selected.openingFloat)}</b></div>
            <div>
              <span>Efectivo esperado</span>
              <b>{money(selected.status === "open" ? selected.expectedCashNow : selected.expectedCash)}</b>
            </div>
            {selected.status === "closed" ? (
              <>
                <div><span>Contado</span><b>{money(selected.countedCash)}</b></div>
                <div className={selected.difference === 0 ? undefined : "total-alert"}>
                  <span>Diferencia</span>
                  <b>{money(selected.difference)}</b>
                  <small>
                    {selected.difference === 0
                      ? "cuadra"
                      : (selected.difference ?? 0) > 0 ? "sobrante" : "faltante"}
                  </small>
                </div>
              </>
            ) : null}
          </div>

          <section className="ops-section">
            <h2>Resumen por medio de pago</h2>
            {selected.byMethod.length === 0 ? (
              <p className="ops-empty">Sin movimientos todavía.</p>
            ) : (
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr><th>Medio</th><th className="num">Movimientos</th><th className="num">Total</th><th>Cuadra el cajón</th></tr>
                  </thead>
                  <tbody>
                    {selected.byMethod.map((row) => (
                      <tr key={row.method}>
                        <td>{PAYMENT_METHOD_LABELS[row.method] ?? row.method}</td>
                        <td className="num">{row.movements}</td>
                        <td className="num">{money(row.total)}</td>
                        <td>{row.method === "cash" ? "Sí" : "No — no se cuenta a mano"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="ops-section">
            <h2>Movimientos</h2>
            {movements.length === 0 ? (
              <p className="ops-empty">Sin movimientos todavía.</p>
            ) : (
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Hora</th><th>Concepto</th><th>Medio</th>
                      <th className="num">Importe</th><th>Origen</th><th>Responsable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((movement) => (
                      <tr key={movement.id}>
                        <td>{new Date(movement.occurredAt).toLocaleTimeString("es-PE")}</td>
                        <td>{CASH_MOVEMENT_LABELS[movement.kind] ?? movement.kind}</td>
                        <td>{PAYMENT_METHOD_LABELS[movement.method] ?? movement.method}</td>
                        <td className="num">{money(movement.amount)}</td>
                        <td>{movement.sourceLabel ?? movement.note ?? "—"}</td>
                        <td>{movement.actorLabel ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      <section className="ops-section">
        <h2>Historial</h2>
        {sessions.length === 0 ? (
          <p className="ops-empty">Todavía no se ha abierto ninguna caja.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Caja</th><th>Apertura</th><th>Cierre</th>
                  <th className="num">Esperado</th><th className="num">Contado</th>
                  <th className="num">Diferencia</th><th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className={session.difference !== null && session.difference !== 0 ? "row-alert" : undefined}>
                    <td><b>{session.sessionNumber}</b><small>{session.openedByLabel ?? "—"}</small></td>
                    <td>{new Date(session.openedAt).toLocaleString("es-PE")}</td>
                    <td>{session.closedAt ? new Date(session.closedAt).toLocaleString("es-PE") : "Abierta"}</td>
                    <td className="num">{money(session.expectedCash)}</td>
                    <td className="num">{money(session.countedCash)}</td>
                    <td className="num">{money(session.difference)}</td>
                    <td className="actions">
                      <button type="button" onClick={() => openDetail(session.id)}>Ver</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {opening ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body ops-drawer-body--narrow">
            <header>
              <div><b>Abrir caja</b><small>Solo puede haber una caja abierta por sede</small></div>
              <button type="button" onClick={() => setOpening(false)}>Cerrar</button>
            </header>
            <label className="product-field">
              <span className="field-label">Sede *</span>
              <select className="input" value={openBranch} onChange={(event) => setOpenBranch(event.target.value)}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
            <label className="product-field">
              <span className="field-label">Fondo inicial</span>
              <input
                className="input"
                inputMode="decimal"
                value={openFloat}
                onChange={(event) => setOpenFloat(event.target.value)}
              />
              <small className="field-hint">El efectivo con el que empieza el cajón.</small>
            </label>
            <div className="product-step-actions">
              <button type="button" className="btn-cancel" onClick={() => setOpening(false)}>Cancelar</button>
              <button type="button" className="btn-save" disabled={saving} onClick={submitOpen}>
                {saving ? "Abriendo…" : "Abrir caja"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {closing && selected ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body ops-drawer-body--narrow">
            <header>
              <div><b>Arqueo y cierre</b><small>{selected.sessionNumber}</small></div>
              <button type="button" onClick={() => setClosing(false)}>Cerrar</button>
            </header>
            <p className="carta-note">
              El sistema espera <b>{money(selected.expectedCashNow)}</b> en efectivo.
              Cuenta el cajón antes de escribir la cifra: la diferencia queda registrada.
            </p>
            <label className="product-field">
              <span className="field-label">Efectivo contado *</span>
              <input
                className="input"
                inputMode="decimal"
                autoFocus
                value={countedCash}
                onChange={(event) => setCountedCash(event.target.value)}
              />
            </label>
            <label className="product-field">
              <span className="field-label">Observación</span>
              <textarea
                className="input"
                rows={3}
                value={closeNote}
                onChange={(event) => setCloseNote(event.target.value)}
                placeholder="Explica la diferencia si la hubo"
              />
            </label>
            <div className="product-step-actions">
              <button type="button" className="btn-cancel" onClick={() => setClosing(false)}>Cancelar</button>
              <button type="button" className="btn-save" disabled={saving} onClick={submitClose}>
                {saving ? "Cerrando…" : "Cerrar caja"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
