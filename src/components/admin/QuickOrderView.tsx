"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import type { AdminOrder, AdminOrderStatus } from "@/lib/admin/orders";
import type { CartEvaluation, CatalogListItem, CatalogProductDetail, PurchasableVariant } from "@/lib/catalog/contracts";
import { formatSoles, publicApi, retailPrice } from "@/lib/public/catalog";

type DraftLine = {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string;
  brandName: string;
  availability: PurchasableVariant["availability"];
  quantity: number;
  referencePrice: number | null;
};

const STATUS_LABELS: Record<AdminOrderStatus, string> = {
  registered: "Registrado",
  confirmed: "Confirmado",
  completed: "Completado",
  cancelled: "Cancelado"
};

function orderCode(value: number) {
  return `PED-${String(value).padStart(6, "0")}`;
}

function orderDate(value: string) {
  return new Date(value).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function QuickOrderView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<CatalogListItem[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProductDetail | null>(null);
  const [loadingProductId, setLoadingProductId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [evaluation, setEvaluation] = useState<CartEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<"shipping" | "pickup">("pickup");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      setOrders(await adminApi.listOrders());
    } catch (error) {
      handleApiError(error, "No se pudo cargar el historial de pedidos.");
    } finally {
      setLoadingOrders(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoadingProducts(true);
      try {
        const response = await publicApi.listProducts({
          page: 1,
          pageSize: 12,
          search: search.trim() || undefined,
          sort: "name_asc"
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

  useEffect(() => {
    let cancelled = false;
    if (lines.length === 0) {
      setEvaluation(null);
      setEvaluating(false);
      return;
    }

    setEvaluating(true);
    publicApi.evaluateCart(lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })))
      .then((result) => {
        if (!cancelled) setEvaluation(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setEvaluation(null);
          handleApiError(error, "No se pudieron recalcular los precios del pedido.");
        }
      })
      .finally(() => {
        if (!cancelled) setEvaluating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lines, handleApiError]);

  const totalUnits = useMemo(
    () => evaluation?.totalUnits ?? lines.reduce((total, line) => total + line.quantity, 0),
    [evaluation, lines]
  );

  async function chooseProduct(product: CatalogListItem) {
    if (loadingProductId) return;
    setLoadingProductId(product.productId);
    try {
      setSelectedProduct(await publicApi.getProduct(product.slug));
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las presentaciones del producto.");
    } finally {
      setLoadingProductId(null);
    }
  }

  function addVariant(product: CatalogProductDetail, variant: PurchasableVariant) {
    if (variant.availability === "sold_out") return;
    setLines((current) => {
      const existing = current.find((line) => line.variantId === variant.id);
      if (existing) {
        return current.map((line) => line.variantId === variant.id ? { ...line, quantity: line.quantity + 1 } : line);
      }
      return [...current, {
        variantId: variant.id,
        productId: product.productId,
        sku: variant.sku,
        productName: product.name,
        variantName: variant.name,
        brandName: product.brand.name,
        availability: variant.availability,
        quantity: 1,
        referencePrice: retailPrice(variant)
      }];
    });
    showToast(`${product.name} · ${variant.name} agregado`);
  }

  function changeQuantity(variantId: string, delta: number) {
    setLines((current) => current
      .map((line) => line.variantId === variantId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  function clearForm() {
    setLines([]);
    setEvaluation(null);
    setCustomerName("");
    setCustomerPhone("");
    setDeliveryAddress("");
    setCustomerNote("");
    setDeliveryMethod("pickup");
    setSelectedProduct(null);
  }

  async function saveOrder() {
    if (saving) return;
    if (!customerName.trim()) {
      showToast("Ingresa el nombre del cliente.");
      return;
    }
    if (lines.length === 0) {
      showToast("Agrega al menos un producto.");
      return;
    }

    setSaving(true);
    try {
      const created = await adminApi.createOrder({
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim() || null,
        deliveryMethod,
        deliveryAddress: deliveryMethod === "shipping" ? deliveryAddress.trim() || null : null,
        customerNote: customerNote.trim() || null,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }))
      });
      showToast(`Pedido ${orderCode(created.orderNumber)} registrado ✓`);
      clearForm();
      await loadOrders();
    } catch (error) {
      handleApiError(error, "No se pudo registrar el pedido.");
    } finally {
      setSaving(false);
    }
  }

  async function updateStatus(order: AdminOrder, status: AdminOrderStatus) {
    if (updatingOrderId) return;
    setUpdatingOrderId(order.id);
    try {
      await adminApi.updateOrderStatus(order.id, status);
      setOrders((current) => current.map((item) => item.id === order.id ? { ...item, status } : item));
      showToast(`${orderCode(order.orderNumber)} actualizado`);
    } catch (error) {
      handleApiError(error, "No se pudo actualizar el pedido.");
    } finally {
      setUpdatingOrderId(null);
    }
  }

  async function copyOrder(order: AdminOrder) {
    const summary = [
      `Pedido ${orderCode(order.orderNumber)}`,
      `Cliente: ${order.customerName}${order.customerPhone ? ` · ${order.customerPhone}` : ""}`,
      ...order.lines.map((line) => `${line.quantity} × ${line.productName} · ${line.variantName} (${line.sku})`),
      `Total: ${formatSoles(order.subtotal)}`
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      showToast("Resumen copiado ✓");
    } catch {
      showToast("No se pudo copiar el resumen.");
    }
  }

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">Registrar pedido</div>
          <div className="field-hint">Busca, agrega cantidades y guarda. Los precios se validan automáticamente.</div>
        </div>
        <div className="order-steps" aria-label="Flujo del pedido">
          <span><b>1</b> Buscar</span><span><b>2</b> Agregar</span><span><b>3</b> Registrar</span>
        </div>
      </div>

      <div className="order-workspace">
        <section className="form-card order-catalog">
          <div className="order-section-title">1. Buscar productos</div>
          <input
            className="input order-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Código, producto o marca…"
            autoFocus
          />

          {loadingProducts ? (
            <div className="order-loading"><span className="spinner spinner--pink" /> Buscando…</div>
          ) : products.length === 0 ? (
            <div className="order-empty">No hay productos publicados que coincidan.</div>
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
                    <small>{product.featuredVariant.sku} · {product.category.name}</small>
                  </span>
                  <span className="order-product-price">
                    {formatSoles(product.availabilitySummary.available === 0 && product.availabilitySummary.consult > 0 ? null : product.startingPrice)}
                    <small>{loadingProductId === product.productId ? "Cargando…" : "Elegir →"}</small>
                  </span>
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
              {selectedProduct.variants.map((variant) => {
                const inOrder = lines.find((line) => line.variantId === variant.id)?.quantity ?? 0;
                return (
                  <div key={variant.id} className="order-variant">
                    <div>
                      <strong>{variant.name}</strong>
                      <small>SKU {variant.sku} · {variant.availability === "available" ? "Disponible" : variant.availability === "sold_out" ? "Agotado" : "Precio por consultar"}</small>
                    </div>
                    <div className="order-variant-action">
                      <span>{formatSoles(retailPrice(variant))}</span>
                      <button type="button" disabled={variant.availability === "sold_out"} onClick={() => addVariant(selectedProduct, variant)}>
                        {inOrder ? `Agregar otro (${inOrder})` : "Agregar"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="form-card order-draft">
          <div className="order-section-title">2. Pedido actual</div>
          {lines.length === 0 ? (
            <div className="order-empty order-empty--draft">El pedido está vacío.<br /><small>Elige un producto y una presentación.</small></div>
          ) : (
            <div className="order-lines">
              {lines.map((line) => {
                const evaluated = evaluation?.lines.find((item) => item.variantId === line.variantId);
                const unitPrice = evaluated?.unitPrice ?? line.referencePrice;
                return (
                  <div key={line.variantId} className="order-line">
                    <div className="order-line-info">
                      <strong>{line.productName}</strong>
                      <small>{line.variantName} · {line.sku}</small>
                      <span>{evaluated?.purchaseMode === "wholesale" ? "Precio mayorista aplicado" : line.availability === "consult" ? "Precio por consultar" : formatSoles(unitPrice)}</span>
                    </div>
                    <div className="order-qty">
                      <button type="button" aria-label="Restar una unidad" onClick={() => changeQuantity(line.variantId, -1)}>−</button>
                      <b>{line.quantity}</b>
                      <button type="button" aria-label="Sumar una unidad" onClick={() => changeQuantity(line.variantId, 1)}>+</button>
                    </div>
                    <div className="order-line-total">{formatSoles(evaluated?.subtotal ?? (unitPrice === null ? null : unitPrice * line.quantity))}</div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="order-total">
            <span>{totalUnits} {totalUnits === 1 ? "unidad" : "unidades"}</span>
            <strong>{formatSoles(evaluation?.subtotal ?? null)}</strong>
            <small>{evaluating ? "Recalculando…" : evaluation?.unresolvedLines ? `${evaluation.unresolvedLines} línea(s) requieren confirmación de precio.` : "Precios y mayorista validados."}</small>
          </div>

          <div className="order-section-title order-customer-title">3. Datos del cliente</div>
          <div className="order-customer-fields">
            <label><span>Nombre *</span><input className="input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Nombre del cliente" /></label>
            <label><span>Teléfono</span><input className="input" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="999 999 999" inputMode="tel" /></label>
          </div>

          <div className="order-delivery">
            <button type="button" className={deliveryMethod === "pickup" ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"} onClick={() => setDeliveryMethod("pickup")}>Recojo en tienda</button>
            <button type="button" className={deliveryMethod === "shipping" ? "order-delivery-option order-delivery-option--active" : "order-delivery-option"} onClick={() => setDeliveryMethod("shipping")}>Envío</button>
          </div>
          {deliveryMethod === "shipping" ? <input className="input" value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="Dirección o distrito" /> : null}
          <textarea className="input textarea order-note" value={customerNote} onChange={(event) => setCustomerNote(event.target.value)} placeholder="Observación (opcional)" />

          <div className="order-actions">
            <button type="button" className="btn-cancel" disabled={saving || (lines.length === 0 && !customerName)} onClick={clearForm}>Limpiar</button>
            <button type="button" className="btn-save" disabled={saving || evaluating || lines.length === 0 || !customerName.trim()} onClick={saveOrder}>
              {saving ? <span className="spinner" /> : null}{saving ? "Registrando…" : "Registrar pedido"}
            </button>
          </div>
        </section>
      </div>

      <section className="form-card order-history">
        <div className="order-history-head">
          <div><div className="order-section-title">Pedidos recientes</div><div className="field-hint">Últimos 30 pedidos registrados.</div></div>
          <button type="button" className="btn-soft" onClick={loadOrders} disabled={loadingOrders}>Actualizar</button>
        </div>
        {loadingOrders ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando pedidos…</div>
        ) : orders.length === 0 ? (
          <div className="order-empty">Aún no hay pedidos registrados.</div>
        ) : (
          <div className="order-history-list">
            {orders.map((order) => (
              <details key={order.id} className="order-history-item">
                <summary>
                  <span className="order-history-code"><b>{orderCode(order.orderNumber)}</b><small>{orderDate(order.createdAt)}</small></span>
                  <span className="order-history-customer"><b>{order.customerName}</b><small>{order.totalUnits} un. · {order.deliveryMethod === "shipping" ? "Envío" : "Recojo"}</small></span>
                  <span className="order-history-total">{formatSoles(order.subtotal)}</span>
                  <span className={`order-status order-status--${order.status}`}>{STATUS_LABELS[order.status]}</span>
                </summary>
                <div className="order-history-detail">
                  <div className="order-history-lines">
                    {order.lines.map((line, index) => <div key={line.id ?? `${line.variantId}-${index}`}><span>{line.quantity} × {line.productName} · {line.variantName}</span><b>{formatSoles(line.subtotal)}</b></div>)}
                  </div>
                  <div className="order-history-meta">
                    {order.customerPhone ? <span>Teléfono: {order.customerPhone}</span> : null}
                    {order.deliveryAddress ? <span>Entrega: {order.deliveryAddress}</span> : null}
                    {order.customerNote ? <span>Nota: {order.customerNote}</span> : null}
                  </div>
                  <div className="order-history-actions">
                    <label>Estado
                      <select className="input" value={order.status} disabled={updatingOrderId === order.id} onChange={(event) => updateStatus(order, event.target.value as AdminOrderStatus)}>
                        {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <button type="button" className="btn-soft" onClick={() => copyOrder(order)}>Copiar resumen</button>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
