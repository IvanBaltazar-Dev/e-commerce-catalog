"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import {
  adminApi,
  type GoodsReceiptSummary,
  type OperableBranch,
  type PurchaseOrderSummary,
  type SupplierDebt,
  type SupplierOption
} from "@/lib/admin/api";
import { PURCHASE_STATUS_LABELS } from "@/lib/admin/purchasing";
import type { CatalogListItem, CatalogProductDetail, PurchasableVariant } from "@/lib/catalog/contracts";
import { formatSoles, publicApi } from "@/lib/public/catalog";

type DraftLine = {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  /** Unidades pedidas en la orden, o recibidas en la recepción. */
  units: string;
  bonusUnits: string;
  damagedUnits: string;
  unitCost: string;
};

type Mode = "order" | "receipt";

function newLine(variant: PurchasableVariant, product: CatalogProductDetail): DraftLine {
  return {
    variantId: variant.id,
    sku: variant.sku,
    productName: product.name,
    variantName: variant.name,
    units: "1",
    bonusUnits: "0",
    damagedUnits: "0",
    unitCost: ""
  };
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function shortDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Abastecimiento: orden de compra, recepción y cuentas con el proveedor.
 *
 * Ningún importe se calcula aquí. El costo lo congela `issue_purchase_order`, el
 * costo real incorporado lo determina `register_goods_receipt` y la deuda sale
 * de obligaciones menos asignaciones, por moneda. La pantalla solo declara qué
 * llegó y cuánto se pagó.
 */
export function PurchasingView() {
  const showToast = useToast();
  const handleApiError = useApiError();

  const [mode, setMode] = useState<Mode>("order");
  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [terms, setTerms] = useState<"cash" | "credit">("cash");
  const [currency, setCurrency] = useState("PEN");
  const [exchangeRate, setExchangeRate] = useState("");
  const [notes, setNotes] = useState("");

  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<CatalogListItem[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProductDetail | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);

  const [orders, setOrders] = useState<PurchaseOrderSummary[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceiptSummary[]>([]);
  const [debt, setDebt] = useState<SupplierDebt | null>(null);
  const [loadingLists, setLoadingLists] = useState(true);
  const [payingObligation, setPayingObligation] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    setLoadingLists(true);
    try {
      const [orderItems, receiptItems, debtData] = await Promise.all([
        adminApi.listPurchaseOrders(),
        adminApi.listReceipts(),
        adminApi.supplierDebt()
      ]);
      setOrders(orderItems);
      setReceipts(receiptItems);
      setDebt(debtData);
    } catch (error) {
      handleApiError(error, "No se pudo cargar el abastecimiento.");
    } finally {
      setLoadingLists(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    (async () => {
      try {
        const [branchItems, supplierItems] = await Promise.all([
          adminApi.listOperableBranches(),
          adminApi.listSuppliers()
        ]);
        setBranches(branchItems);
        setBranchId((current) => current || branchItems.find((b) => b.isDefault)?.id || branchItems[0]?.id || "");
        setSuppliers(supplierItems);
        setSupplierId((current) => current || supplierItems[0]?.id || "");
      } catch (error) {
        handleApiError(error, "No se pudieron cargar sedes y proveedores.");
      }
    })();
    loadLists();
  }, [handleApiError, loadLists]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoadingProducts(true);
      try {
        const response = await publicApi.listProducts({
          page: 1, pageSize: 10, search: search.trim() || undefined, sort: "name_asc"
        });
        if (!cancelled) setProducts(response.items);
      } catch (error) {
        if (!cancelled) handleApiError(error, "No se pudo buscar en el catálogo.");
      } finally {
        if (!cancelled) setLoadingProducts(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, handleApiError]);

  // Cuando el proveedor cambia, su moneda por defecto manda: una recepción en
  // moneda extranjera exige tipo de cambio y la base lo rechaza sin él.
  useEffect(() => {
    const supplier = suppliers.find((item) => item.id === supplierId);
    if (supplier) setCurrency(supplier.defaultCurrency);
  }, [supplierId, suppliers]);

  const estimatedTotal = useMemo(
    () => money(lines.reduce((sum, line) => sum + (Number(line.units) || 0) * (Number(line.unitCost) || 0), 0)),
    [lines]
  );

  async function chooseProduct(product: CatalogListItem) {
    try {
      setSelectedProduct(await publicApi.getProduct(product.slug));
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las presentaciones.");
    }
  }

  function addVariant(product: CatalogProductDetail, variant: PurchasableVariant) {
    setLines((current) =>
      current.some((line) => line.variantId === variant.id)
        ? current
        : [...current, newLine(variant, product)]);
    showToast(`${variant.sku} agregado`);
  }

  function updateLine(variantId: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => line.variantId === variantId ? { ...line, ...patch } : line));
  }

  function clearDraft() {
    setLines([]);
    setSelectedProduct(null);
    setNotes("");
    setExchangeRate("");
    setOperationId(crypto.randomUUID());
  }

  async function submit() {
    if (saving) return;
    if (!branchId || !supplierId) { showToast("Elige sede y proveedor."); return; }
    if (lines.length === 0) { showToast("Agrega al menos una presentación."); return; }

    setSaving(true);
    try {
      if (mode === "order") {
        const order = await adminApi.issuePurchaseOrder({
          supplierId,
          branchId,
          clientOperationId: operationId,
          currency,
          terms,
          paymentTermsDays: null,
          expectedAt: null,
          notes: notes.trim() || null,
          lines: lines.map((line) => ({
            variantId: line.variantId,
            orderedUnits: Number(line.units) || 0,
            // Sin costo declarado, la base toma el acuerdo vigente del proveedor.
            unitCost: line.unitCost.trim() === "" ? null : Number(line.unitCost),
            discountAmount: null,
            notes: null
          }))
        });
        showToast(`Orden ${order.orderNumber} emitida ✓`);
      } else {
        const receipt = await adminApi.registerGoodsReceipt({
          supplierId,
          branchId,
          clientOperationId: operationId,
          purchaseOrderId: null,
          currency,
          exchangeRate: currency === "PEN" ? null : Number(exchangeRate) || null,
          terms,
          notes: notes.trim() || null,
          supplierDocument: null,
          lines: lines.map((line) => ({
            variantId: line.variantId,
            purchaseOrderLineId: null,
            expectedUnits: null,
            receivedUnits: Number(line.units) || 0,
            bonusUnits: Number(line.bonusUnits) || 0,
            bonusValuation: "same_variant" as const,
            bonusDeclaredUnitCost: null,
            damagedUnits: Number(line.damagedUnits) || 0,
            unitCost: Number(line.unitCost) || 0,
            discountAmount: null,
            notes: null
          }))
        });
        showToast(`Recepción ${receipt.receiptNumber} registrada ✓`);
      }

      clearDraft();
      await loadLists();
    } catch (error) {
      handleApiError(error, mode === "order" ? "No se pudo emitir la orden." : "No se pudo registrar la recepción.");
    } finally {
      setSaving(false);
    }
  }

  async function payObligation(obligationId: string, supplier: string, pending: number, obligationCurrency: string) {
    if (payingObligation) return;
    const raw = window.prompt(
      `Importe a pagar de esta obligación (pendiente ${pending.toFixed(2)} ${obligationCurrency}):`,
      pending.toFixed(2)
    );
    if (raw === null) return;

    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) { showToast("Importe no válido."); return; }

    setPayingObligation(obligationId);
    try {
      await adminApi.registerSupplierPayment({
        supplierId: supplier,
        branchId,
        method: "transfer",
        amount,
        clientOperationId: crypto.randomUUID(),
        currency: obligationCurrency,
        reference: null,
        evidencePath: null,
        paidAt: null,
        notes: null,
        allocations: [{ obligationId, amount }]
      });
      showToast("Pago registrado ✓");
      await loadLists();
    } catch (error) {
      handleApiError(error, "No se pudo registrar el pago al proveedor.");
    } finally {
      setPayingObligation(null);
    }
  }

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Abastecimiento</div>
          <div className="field-hint">
            La orden no mueve inventario; la recepción sí. El costo real y el promedio ponderado los resuelve PostgreSQL.
          </div>
        </div>
        <div className="order-delivery" style={{ margin: 0, minWidth: 260 }}>
          <button
            type="button"
            className={mode === "order" ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"}
            onClick={() => setMode("order")}
          >
            Orden de compra
          </button>
          <button
            type="button"
            className={mode === "receipt" ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"}
            onClick={() => setMode("receipt")}
          >
            Recepción
          </button>
        </div>
      </div>

      <div className="order-workspace">
        <section className="form-card order-catalog">
          <div className="order-section-title">1. Buscar presentaciones</div>
          <input
            className="input order-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Código, producto o marca…"
          />

          {loadingProducts ? (
            <div className="order-loading"><span className="spinner spinner--pink" /> Buscando…</div>
          ) : products.length === 0 ? (
            <div className="order-empty">No hay productos que coincidan.</div>
          ) : (
            <div className="order-products">
              {products.map((product) => (
                <button
                  key={product.productId}
                  type="button"
                  className={selectedProduct?.productId === product.productId ? "order-product order-product--active" : "order-product"}
                  onClick={() => chooseProduct(product)}
                >
                  <span className="order-product-main">
                    <span className="order-product-brand">{product.brand.name}</span>
                    <strong>{product.name}</strong>
                    <small>{product.featuredVariant.sku}</small>
                  </span>
                  <span className="order-product-price"><small>Elegir →</small></span>
                </button>
              ))}
            </div>
          )}

          {selectedProduct ? (
            <div className="order-variants">
              <div className="order-variants-head">
                <div><b>{selectedProduct.name}</b><small>{selectedProduct.brand.name}</small></div>
                <button type="button" onClick={() => setSelectedProduct(null)}>Cerrar</button>
              </div>
              {selectedProduct.variants.map((variant) => (
                <div key={variant.id} className="order-variant">
                  <div>
                    <strong>{variant.name}</strong>
                    <small>SKU {variant.sku}</small>
                  </div>
                  <div className="order-variant-action">
                    {/* Se compra lo agotado: la disponibilidad de venta no restringe el abastecimiento. */}
                    <button type="button" onClick={() => addVariant(selectedProduct, variant)}>Agregar</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="form-card order-draft">
          <div className="order-section-title">2. {mode === "order" ? "Orden" : "Recepción"}</div>

          <div className="order-customer-fields">
            <label><span>Proveedor</span>
              <select className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                {suppliers.length === 0 ? <option value="">Sin proveedores activos</option> : null}
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </label>
            <label><span>Sede de destino</span>
              <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </label>
            <label><span>Condición</span>
              <select className="input" value={terms} onChange={(event) => setTerms(event.target.value as "cash" | "credit")}>
                <option value="cash">Contado</option>
                <option value="credit">Crédito</option>
              </select>
            </label>
            <label><span>Moneda</span>
              <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value)}>
                <option value="PEN">PEN</option>
                <option value="USD">USD</option>
              </select>
            </label>
            {mode === "receipt" && currency !== "PEN" ? (
              <label><span>Tipo de cambio *</span>
                <input
                  className="input"
                  inputMode="decimal"
                  value={exchangeRate}
                  onChange={(event) => setExchangeRate(event.target.value)}
                  placeholder="3.80"
                />
              </label>
            ) : null}
          </div>

          {lines.length === 0 ? (
            <div className="order-empty order-empty--draft">
              Sin presentaciones.<br /><small>Búscalas a la izquierda y agrégalas.</small>
            </div>
          ) : (
            <div className="sale-payments">
              {lines.map((line) => (
                <div key={line.variantId} className="purchase-line">
                  <div className="order-line-info">
                    <strong>{line.productName}</strong>
                    <small>{line.variantName} · {line.sku}</small>
                  </div>
                  <label><span>{mode === "order" ? "Pedidas" : "Recibidas"}</span>
                    <input className="input" inputMode="numeric" value={line.units}
                      onChange={(event) => updateLine(line.variantId, { units: event.target.value })} />
                  </label>
                  {mode === "receipt" ? (
                    <>
                      <label><span>Bonificadas</span>
                        <input className="input" inputMode="numeric" value={line.bonusUnits}
                          onChange={(event) => updateLine(line.variantId, { bonusUnits: event.target.value })} />
                      </label>
                      <label><span>Dañadas</span>
                        <input className="input" inputMode="numeric" value={line.damagedUnits}
                          onChange={(event) => updateLine(line.variantId, { damagedUnits: event.target.value })} />
                      </label>
                    </>
                  ) : null}
                  <label><span>Costo unitario</span>
                    <input className="input" inputMode="decimal" value={line.unitCost}
                      placeholder={mode === "order" ? "acuerdo vigente" : "0.00"}
                      onChange={(event) => updateLine(line.variantId, { unitCost: event.target.value })} />
                  </label>
                  <button type="button" className="btn-ghost" aria-label="Quitar"
                    onClick={() => setLines((current) => current.filter((item) => item.variantId !== line.variantId))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="sale-balance">
            <span>Estimado <b>{formatSoles(estimatedTotal)}</b></span>
            <span>
              {mode === "receipt"
                ? "La bonificación del mismo artículo baja el costo efectivo; lo dañado no entra al stock."
                : "Sin costo declarado se toma el acuerdo vigente del proveedor."}
            </span>
          </div>

          <textarea className="input textarea order-note" value={notes}
            onChange={(event) => setNotes(event.target.value)} placeholder="Observación (opcional)" />

          <div className="order-actions">
            <button type="button" className="btn-cancel" disabled={saving} onClick={clearDraft}>Limpiar</button>
            <button type="button" className="btn-save" disabled={saving || lines.length === 0} onClick={submit}>
              {saving ? <span className="spinner" /> : null}
              {saving ? "Registrando…" : mode === "order" ? "Emitir orden" : "Registrar recepción"}
            </button>
          </div>
        </section>
      </div>

      <section className="form-card order-history">
        <div className="order-history-head">
          <div>
            <div className="order-section-title">Deuda con proveedores</div>
            <div className="field-hint">Por moneda: nunca se suman soles con dólares sin conversión explícita.</div>
          </div>
          <button type="button" className="btn-soft" onClick={loadLists} disabled={loadingLists}>Actualizar</button>
        </div>

        {loadingLists ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
        ) : !debt || debt.balances.length === 0 ? (
          <div className="order-empty">No hay deuda pendiente con proveedores.</div>
        ) : (
          <>
            <div className="order-history-list">
              {debt.balances.map((balance) => (
                <div key={`${balance.supplierId}-${balance.currency}`} className="sale-reservation">
                  <span><b>{balance.supplierName}</b><small>{balance.currency}</small></span>
                  <span><small>Vence</small>{shortDate(balance.nextDueDate)}</span>
                  <span className="order-history-total">
                    {balance.balance.toFixed(2)} {balance.currency}
                  </span>
                  <span><small>de {balance.totalDue.toFixed(2)} facturado</small></span>
                </div>
              ))}
            </div>

            {debt.obligations.length > 0 ? (
              <div className="order-history-list" style={{ marginTop: 12 }}>
                {debt.obligations.map((obligation) => (
                  <div key={obligation.id} className="sale-reservation">
                    <span><b>Obligación</b><small>{shortDate(obligation.dueDate)}</small></span>
                    <span><small>Pendiente</small>{obligation.pending.toFixed(2)} {obligation.currency}</span>
                    <span className="order-history-total">{obligation.amountDue.toFixed(2)}</span>
                    <span className="sale-reservation-actions">
                      <button
                        type="button"
                        className="btn-save"
                        disabled={payingObligation === obligation.id}
                        onClick={() => payObligation(obligation.id, obligation.supplierId, obligation.pending, obligation.currency)}
                      >
                        Pagar
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {debt.advances.length > 0 ? (
              <div className="field-hint" style={{ marginTop: 10 }}>
                Anticipos sin asignar: {debt.advances.map((advance) =>
                  `${advance.unallocated.toFixed(2)} ${advance.currency}`).join(" · ")}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="form-card order-history">
        <div className="order-section-title">Órdenes y recepciones</div>
        {loadingLists ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
        ) : orders.length === 0 && receipts.length === 0 ? (
          <div className="order-empty">Aún no hay compras registradas.</div>
        ) : (
          <div className="order-history-list">
            {orders.map((order) => (
              <div key={order.id} className="sale-reservation">
                <span><b>{order.orderNumber}</b><small>{order.supplierName}</small></span>
                <span><small>Esperada</small>{shortDate(order.expectedAt)}</span>
                <span className="order-history-total">{order.total.toFixed(2)} {order.currency}</span>
                <span className={`order-status order-status--${order.status === "received" ? "completed" : "registered"}`}>
                  {PURCHASE_STATUS_LABELS[order.status]}
                </span>
              </div>
            ))}
            {receipts.map((receipt) => (
              <div key={receipt.id} className="sale-reservation">
                <span><b>{receipt.receiptNumber}</b><small>{receipt.supplierName ?? "Recepción"}</small></span>
                <span><small>Recibida</small>{shortDate(receipt.receivedAt)}</span>
                <span className="order-history-total">{formatSoles(receipt.goodsTotalPen)}</span>
                <span className="order-status order-status--confirmed">Recibida</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
