"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch } from "@/lib/admin/api";
import { EXPENSE_SCOPE_LABELS, type Expense, type ExpenseCategory } from "@/lib/admin/operations";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/admin/sales";

const METHODS: PaymentMethod[] = ["cash", "yape", "plin", "transfer", "card", "other"];

function money(value: number) {
  return `S/ ${value.toFixed(2)}`;
}

/**
 * Registro y consulta de gastos.
 *
 * Un gasto en efectivo sale del cajón automáticamente: lo decide
 * `register_expense`, no esta pantalla. La anulación no borra: marca el gasto y
 * devuelve el importe al cajón como movimiento compensatorio.
 */
export function ExpensesView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [items, setItems] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeVoided, setIncludeVoided] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const [form, setForm] = useState({
    branchId: "",
    categoryId: "",
    method: "cash" as PaymentMethod,
    amount: "",
    description: "",
    payeeName: "",
    incurredAt: new Date().toISOString().slice(0, 10)
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listExpenses({ includeVoided });
      setCategories(result.categories);
      setItems(result.items);
      setForm((current) => ({
        ...current,
        categoryId: current.categoryId || result.categories[0]?.id || ""
      }));
    } catch (error) {
      handleApiError(error, "No se pudieron cargar los gastos.");
    } finally {
      setLoading(false);
    }
  }, [includeVoided, handleApiError]);

  useEffect(() => {
    adminApi.listBranches().then((list) => {
      setBranches(list);
      const preferred = list.find((branch) => branch.isDefault) ?? list[0];
      if (preferred) setForm((current) => ({ ...current, branchId: current.branchId || preferred.id }));
    }).catch(() => setBranches([]));
    load();
  }, [load]);

  const totals = useMemo(() => {
    const live = items.filter((item) => !item.voidedAt);
    return {
      count: live.length,
      total: live.reduce((sum, item) => sum + item.amount, 0),
      cash: live.filter((item) => item.method === "cash").reduce((sum, item) => sum + item.amount, 0)
    };
  }, [items]);

  async function submit() {
    if (saving) return;

    const amount = Number(form.amount.replace(",", "."));

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Indica un importe válido");
      return;
    }

    if (!form.description.trim()) {
      showToast("Describe el gasto");
      return;
    }

    setSaving(true);
    try {
      await adminApi.registerExpense({
        branchId: form.branchId,
        expenseCategoryId: form.categoryId,
        method: form.method,
        amount,
        description: form.description.trim(),
        clientOperationId: crypto.randomUUID(),
        payeeName: form.payeeName.trim() || null,
        incurredAt: form.incurredAt,
        recurrence: "one_off"
      });
      showToast("Gasto registrado");
      setCreating(false);
      setForm((current) => ({ ...current, amount: "", description: "", payeeName: "" }));
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo registrar el gasto.");
    } finally {
      setSaving(false);
    }
  }

  async function submitVoid() {
    if (!voidingId || saving) return;

    if (!voidReason.trim()) {
      showToast("Anular un gasto exige un motivo");
      return;
    }

    setSaving(true);
    try {
      await adminApi.voidExpense(voidingId, voidReason.trim());
      showToast("Gasto anulado");
      setVoidingId(null);
      setVoidReason("");
      await load();
    } catch (error) {
      handleApiError(error, "No se pudo anular el gasto.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-page">
      <header className="ops-head">
        <div>
          <h1>Gastos</h1>
          <p>Un gasto en efectivo sale del cajón; los demás medios solo se registran.</p>
        </div>
        <button type="button" className="btn-save" onClick={() => setCreating(true)}>Registrar gasto</button>
      </header>

      <div className="ops-filters">
        <button
          type="button"
          className={includeVoided ? "opt-chip opt-chip--active" : "opt-chip"}
          onClick={() => setIncludeVoided((value) => !value)}
        >
          Incluir anulados
        </button>
      </div>

      <div className="ops-totals">
        <div><span>Gastos vigentes</span><b>{totals.count}</b></div>
        <div><span>Total</span><b>{money(totals.total)}</b></div>
        <div><span>Salido del cajón</span><b>{money(totals.cash)}</b><small>solo efectivo</small></div>
      </div>

      {loading ? (
        <p className="ops-empty">Cargando gastos…</p>
      ) : items.length === 0 ? (
        <p className="ops-empty">Todavía no hay gastos registrados.</p>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Fecha</th><th>Categoría</th><th>Descripción</th>
                <th>Medio</th><th className="num">Importe</th><th />
              </tr>
            </thead>
            <tbody>
              {items.map((expense) => (
                <tr key={expense.id} className={expense.voidedAt ? "row-void" : undefined}>
                  <td>{expense.incurredAt}</td>
                  <td>
                    {expense.category}
                    <small>{EXPENSE_SCOPE_LABELS[expense.scope] ?? expense.scope}</small>
                  </td>
                  <td>
                    {expense.description}
                    {expense.payeeName ? <small>{expense.payeeName}</small> : null}
                    {expense.voidedAt ? <small className="tag-warn">Anulado: {expense.voidReason}</small> : null}
                  </td>
                  <td>{PAYMENT_METHOD_LABELS[expense.method] ?? expense.method}</td>
                  <td className="num">{money(expense.amount)}</td>
                  <td className="actions">
                    {expense.voidedAt ? null : (
                      <button type="button" onClick={() => setVoidingId(expense.id)}>Anular</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body ops-drawer-body--narrow">
            <header>
              <div><b>Registrar gasto</b></div>
              <button type="button" onClick={() => setCreating(false)}>Cerrar</button>
            </header>

            <div className="grid-fields">
              <label className="product-field">
                <span className="field-label">Sede *</span>
                <select className="input" value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })}>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
              <label className="product-field">
                <span className="field-label">Categoría *</span>
                <select className="input" value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name} · {EXPENSE_SCOPE_LABELS[category.scope] ?? category.scope}
                    </option>
                  ))}
                </select>
              </label>
              <label className="product-field">
                <span className="field-label">Medio de pago *</span>
                <select className="input" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as PaymentMethod })}>
                  {METHODS.map((method) => (
                    <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                  ))}
                </select>
              </label>
              <label className="product-field">
                <span className="field-label">Importe *</span>
                <input className="input" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
              </label>
              <label className="product-field">
                <span className="field-label">Fecha efectiva *</span>
                <input className="input" type="date" value={form.incurredAt} onChange={(event) => setForm({ ...form, incurredAt: event.target.value })} />
              </label>
              <label className="product-field">
                <span className="field-label">Beneficiario</span>
                <input className="input" value={form.payeeName} onChange={(event) => setForm({ ...form, payeeName: event.target.value })} placeholder="Opcional" />
              </label>
            </div>

            <label className="product-field">
              <span className="field-label">Descripción *</span>
              <textarea className="input" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>

            {form.method === "cash" ? (
              <p className="carta-note">Este gasto saldrá del cajón de la caja abierta en esa sede.</p>
            ) : null}

            <div className="product-step-actions">
              <button type="button" className="btn-cancel" onClick={() => setCreating(false)}>Cancelar</button>
              <button type="button" className="btn-save" disabled={saving} onClick={submit}>
                {saving ? "Registrando…" : "Registrar gasto"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {voidingId ? (
        <div className="ops-drawer" role="dialog" aria-modal="true">
          <div className="ops-drawer-body ops-drawer-body--narrow">
            <header>
              <div><b>Anular gasto</b><small>El gasto no se borra: queda marcado</small></div>
              <button type="button" onClick={() => setVoidingId(null)}>Cerrar</button>
            </header>
            <label className="product-field">
              <span className="field-label">Motivo *</span>
              <textarea className="input" rows={3} autoFocus value={voidReason} onChange={(event) => setVoidReason(event.target.value)} />
            </label>
            <div className="product-step-actions">
              <button type="button" className="btn-cancel" onClick={() => setVoidingId(null)}>Cancelar</button>
              <button type="button" className="btn-save" disabled={saving} onClick={submitVoid}>
                {saving ? "Anulando…" : "Anular gasto"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
