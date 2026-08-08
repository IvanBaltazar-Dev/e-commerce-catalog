"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch, type ReservationSummary, type SaleSummary } from "@/lib/admin/api";
import { ASSISTANT_HANDOFF_KEY, type AssistantHandoff } from "@/components/admin/AssistantView";
import {
  FULFILLMENT_LABELS,
  PAYMENT_METHOD_LABELS,
  SOURCE_CHANNEL_LABELS,
  type FulfillmentMethod,
  type PaymentMethod,
  type Reservation,
  type Sale,
  type SaleSourceChannel
} from "@/lib/admin/sales";
import type { CartEvaluation, CatalogProductDetail, PurchasableVariant } from "@/lib/catalog/contracts";
import { formatSoles, publicApi, retailPrice } from "@/lib/public/catalog";

type DraftLine = {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  referencePrice: number | null;
};

type DraftPayment = {
  key: string;
  method: PaymentMethod;
  amount: string;
  tenderedAmount: string;
  reference: string;
};

const CHANNELS: SaleSourceChannel[] = [
  "in_store", "whatsapp", "instagram", "facebook", "tiktok", "web", "phone", "other"
];

const FULFILLMENTS: FulfillmentMethod[] = ["in_store", "pickup", "delivery"];

// `reservation_advance` se excluye a propósito: esa fila la crea la conversión
// de la reserva, no la pantalla, y lleva el pago original al que se aplica.
const CHARGEABLE_METHODS: PaymentMethod[] = ["cash", "yape", "plin", "transfer", "card", "store_credit", "other"];

/** Una fila del buscador del POS: es una variante, no un producto. */
type PosVariant = {
  variantId: string;
  sku: string | null;
  barcode: string | null;
  variantName: string;
  productId: string;
  productName: string;
  presentation: string | null;
  brandName: string;
  lineName: string | null;
  shadeName: string | null;
  shadeCode: string | null;
  referenceColor: string | null;
  unitPrice: number;
  wholesalePrice: number | null;
  /** Del producto y configurable por la dueña. Jamás una constante. */
  wholesaleMinQuantity: number | null;
  availability: "available" | "sold_out" | "consult";
  tracksInventory: boolean;
  availableQuantity: number;
};

function newPayment(method: PaymentMethod = "cash", amount = ""): DraftPayment {
  return { key: crypto.randomUUID(), method, amount, tenderedAmount: "", reference: "" };
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Lee un importe tecleado en mostrador. Acepta coma decimal porque en Perú se
 * escribe «12,50» tan a menudo como «12.50», y rechazarlo en silencio hace que
 * la vendedora cobre 12 soles creyendo que cobró 12,50.
 */
function toNumber(text: string): number {
  const clean = text.replace(/\s/g, "").replace(",", ".");
  const value = Number(clean);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Botones rápidos de efectivo calculados desde el total: el exacto y los dos
 * billetes siguientes con los que suelen pagar. Nada de una botonera fija que
 * ofrezca S/ 200 para una venta de S/ 19.
 */
function cashSuggestions(total: number): number[] {
  const billetes = [10, 20, 50, 100, 200];
  const mayores = billetes.filter((b) => b > total).slice(0, 2);
  const redondo = Math.ceil(total / 10) * 10;
  const extra = redondo > total && !mayores.includes(redondo) ? [redondo] : [];
  return [...new Set([...extra, ...mayores])].slice(0, 3);
}

function saleDate(value: string) {
  return new Date(value).toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function inTwoDays() {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  date.setSeconds(0, 0);
  return date.toISOString().slice(0, 16);
}

export function SalesView() {
  const showToast = useToast();
  const handleApiError = useApiError();

  const [branches, setBranches] = useState<OperableBranch[]>([]);
  const [branchId, setBranchId] = useState("");

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PosVariant[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<CatalogProductDetail | null>(null);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [evaluation, setEvaluation] = useState<CartEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [discountTotal, setDiscountTotal] = useState("");

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerDocument, setCustomerDocument] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [sourceChannel, setSourceChannel] = useState<SaleSourceChannel>("in_store");
  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("in_store");
  const [notes, setNotes] = useState("");

  const [payments, setPayments] = useState<DraftPayment[]>([newPayment()]);
  // Dividir el pago es una decisión explícita, no el estado por defecto: la
  // inmensa mayoría de las ventas se cobran con un solo medio.
  const [splitPayment, setSplitPayment] = useState(false);
  // Candado instantáneo contra el doble cobro. El estado de React tarda un
  // render en llegar al DOM, y en ese hueco cabe un segundo clic.
  const registeringRef = useRef(false);
  // Se genera una sola vez por borrador: es lo que hace idempotente el registro.
  // Un doble clic devuelve la misma venta en lugar de duplicarla.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);

  const [expiresAt, setExpiresAt] = useState(inTwoDays);
  const [reservationMode, setReservationMode] = useState(false);

  // Propuesta llegada del Asistente (Bloque 4). Se guarda quiénes fueron las
  // interacciones para CERRAR el ciclo con honestidad: al registrar la venta,
  // cada asistencia queda confirmada y enlazada a la venta que la persona
  // ejecutó aquí — la IA propuso, el humano vendió (regla 9).
  const assistantInteractionsRef = useRef<string[]>([]);

  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [loadingSales, setLoadingSales] = useState(true);
  const [openSale, setOpenSale] = useState<Sale | null>(null);
  const [reservations, setReservations] = useState<ReservationSummary[]>([]);
  const [loadingReservations, setLoadingReservations] = useState(true);
  const [busyReservationId, setBusyReservationId] = useState<string | null>(null);

  const loadBranches = useCallback(async () => {
    try {
      const items = await adminApi.listOperableBranches();
      setBranches(items);
      setBranchId((current) => current || items.find((item) => item.isDefault)?.id || items[0]?.id || "");
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las sedes en las que puedes operar.");
    }
  }, [handleApiError]);

  const loadSales = useCallback(async () => {
    setLoadingSales(true);
    try {
      setSales(await adminApi.listSales());
    } catch (error) {
      handleApiError(error, "No se pudo cargar el historial de ventas.");
    } finally {
      setLoadingSales(false);
    }
  }, [handleApiError]);

  const loadReservations = useCallback(async () => {
    setLoadingReservations(true);
    try {
      setReservations(await adminApi.listReservations("active"));
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las reservas vigentes.");
    } finally {
      setLoadingReservations(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    loadBranches();
    loadSales();
    loadReservations();
  }, [loadBranches, loadSales, loadReservations]);

  // Si el Asistente dejó una propuesta, se carga como borrador. El precio NO
  // viene con ella: lo evalúa PostgreSQL aquí, como con cualquier borrador.
  useEffect(() => {
    const raw = window.sessionStorage.getItem(ASSISTANT_HANDOFF_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(ASSISTANT_HANDOFF_KEY);
    try {
      const handoff = JSON.parse(raw) as AssistantHandoff;
      if (!Array.isArray(handoff.lineas) || handoff.lineas.length === 0) return;
      assistantInteractionsRef.current = handoff.interactionIds ?? [];
      setLines(handoff.lineas.map((linea) => {
        const [productName, variantName] = linea.nombre.split(" · ");
        return {
          variantId: linea.variantId,
          sku: linea.sku ?? "",
          productName: productName ?? linea.nombre,
          variantName: variantName ?? "",
          quantity: linea.cantidad,
          referencePrice: null
        };
      }));
      showToast("Propuesta del asistente cargada: revisa y registra.");
    } catch {
      // Un handoff corrupto no debe romper la pantalla de ventas.
    }
    // Solo al montar: el asistente navega hacia acá con el dato ya puesto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El cierre honesto del ciclo del asistente: la venta o reserva que la
  // persona registró queda enlazada en cada interacción propuesta.
  async function resolveAssistantInteractions(link: { saleId?: string; reservationId?: string }) {
    const ids = assistantInteractionsRef.current;
    if (ids.length === 0) return;
    assistantInteractionsRef.current = [];
    for (const id of ids) {
      try {
        await adminApi.resolveAssist({
          interactionId: id,
          estado: "confirmed",
          saleId: link.saleId ?? null,
          reservationId: link.reservationId ?? null,
          nota: "Registrada desde Ventas"
        });
      } catch {
        // Una interacción ya resuelta o ajena no interrumpe el registro real.
      }
    }
  }

  // Primera velocidad de la venta: «sé qué quiere». El buscador devuelve la
  // VARIANTE, no el producto — teclear «Abrumadora» no puede obligar a abrir el
  // esmalte y recorrer sus 200 tonos. El orden y el recorte por sede los
  // resuelve pos_variant_search en PostgreSQL.
  useEffect(() => {
    let cancelled = false;
    const term = search.trim();

    if (!branchId || term.length === 0) {
      setResults([]);
      setLoadingProducts(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setLoadingProducts(true);
      try {
        const response = await fetch(
          `/api/admin/sales/search?branch=${encodeURIComponent(branchId)}&q=${encodeURIComponent(term)}`
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? "Búsqueda fallida");
        if (!cancelled) setResults((payload?.data?.items ?? []) as PosVariant[]);
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
  }, [search, branchId, handleApiError]);

  // Precio, modalidad mayorista y disponibilidad se resuelven en PostgreSQL. La
  // pantalla solo muestra lo que la base ya decidió: nunca calcula un importe.
  useEffect(() => {
    let cancelled = false;
    if (lines.length === 0) {
      setEvaluation(null);
      setEvaluating(false);
      return;
    }

    setEvaluating(true);
    publicApi.evaluateCart(lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })))
      .then((result) => { if (!cancelled) setEvaluation(result); })
      .catch((error) => {
        if (!cancelled) {
          setEvaluation(null);
          handleApiError(error, "No se pudieron recalcular los precios de la venta.");
        }
      })
      .finally(() => { if (!cancelled) setEvaluating(false); });

    return () => { cancelled = true; };
  }, [lines, handleApiError]);

  const gross = evaluation?.subtotal ?? null;
  const discount = money(Number(discountTotal) || 0);
  const total = gross === null ? null : money(gross - discount);
  // Con un solo medio no se pregunta el importe: es el total. El campo existía
  // para que la vendedora tecleara un número que la pantalla ya conocía.
  const singleMethod = !splitPayment && payments.length === 1;
  const paid = useMemo(() => {
    if (singleMethod && total !== null) return total;
    return money(payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
  }, [payments, singleMethod, total]);

  const change = useMemo(
    () => money(payments.reduce((sum, payment) => {
      if (payment.method !== "cash") return sum;
      const tendered = toNumber(payment.tenderedAmount);
      const asignado = singleMethod && total !== null ? total : toNumber(payment.amount);
      return sum + (tendered > asignado ? tendered - asignado : 0);
    }, 0)),
    [payments, singleMethod, total]
  );
  const missing = total === null ? null : money(total - paid);


  /**
   * Agrega la variante que el buscador ya resolvió y devuelve el foco al
   * buscador: en mostrador se encadenan productos, y obligar a volver con el
   * ratón entre uno y otro rompe el ritmo de la venta.
   */
  function addFound(item: PosVariant) {
    if (item.availability === "sold_out") return;
    setLines((current) => {
      const existing = current.find((line) => line.variantId === item.variantId);
      if (existing) {
        return current.map((line) =>
          line.variantId === item.variantId ? { ...line, quantity: line.quantity + 1 } : line);
      }
      return [...current, {
        variantId: item.variantId,
        sku: item.sku ?? "",
        productName: item.productName,
        variantName: item.shadeName ?? item.variantName,
        quantity: 1,
        referencePrice: item.unitPrice
      }];
    });
    showToast(`${item.productName} · ${item.shadeName ?? item.variantName} agregado`);
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  function addVariant(product: CatalogProductDetail, variant: PurchasableVariant) {
    if (variant.availability === "sold_out") return;
    setLines((current) => {
      const existing = current.find((line) => line.variantId === variant.id);
      if (existing) {
        return current.map((line) =>
          line.variantId === variant.id ? { ...line, quantity: line.quantity + 1 } : line);
      }
      return [...current, {
        variantId: variant.id,
        sku: variant.sku,
        productName: product.name,
        variantName: variant.name,
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

  function updatePayment(key: string, patch: Partial<DraftPayment>) {
    setPayments((current) => current.map((payment) => payment.key === key ? { ...payment, ...patch } : payment));
  }

  /**
   * El exceso solo existe en efectivo, porque solo ahí hay vuelto que devolver.
   * Si a Yape o a la tarjeta se les asigna más de lo que falta, se recorta: no
   * hay forma de devolver por esos medios y aceptarlo dejaría una venta
   * cobrada de más que nadie sabría cómo cuadrar.
   */
  function assignAmount(key: string, text: string) {
    const payment = payments.find((item) => item.key === key);
    if (!payment || payment.method === "cash" || total === null) {
      updatePayment(key, { amount: text });
      return;
    }
    const otros = payments
      .filter((item) => item.key !== key)
      .reduce((sum, item) => sum + toNumber(item.amount), 0);
    const tope = money(total - otros);
    const pedido = toNumber(text);
    if (pedido > tope && tope >= 0) {
      updatePayment(key, { amount: String(tope) });
      showToast(`Por ${PAYMENT_METHOD_LABELS[payment.method]} no se puede cobrar de más: no hay vuelto que devolver.`);
      return;
    }
    updatePayment(key, { amount: text });
  }

  function coverRest(key: string) {
    if (missing === null || missing <= 0) return;
    const current = Number(payments.find((payment) => payment.key === key)?.amount) || 0;
    updatePayment(key, { amount: String(money(current + missing)) });
  }

  function clearDraft() {
    setLines([]);
    setEvaluation(null);
    setDiscountTotal("");
    setCustomerName("");
    setCustomerPhone("");
    setCustomerDocument("");
    setDeliveryAddress("");
    setNotes("");
    setSourceChannel("in_store");
    setFulfillmentMethod("in_store");
    setPayments([newPayment()]);
    setSelectedProduct(null);
    setReservationMode(false);
    setOperationId(crypto.randomUUID());
  }

  async function registerSale() {
    // El ref cierra antes que el estado: entre setSaving(true) y el render que
    // deshabilita el botón cabe un segundo clic, y ahí es donde nacen los
    // cobros duplicados. El clientOperationId hace idempotente el backend; esto
    // evita además la segunda petición.
    if (registeringRef.current || saving) return;
    registeringRef.current = true;
    if (!branchId) { showToast("Elige la sede en la que registras la venta."); registeringRef.current = false; return; }
    if (lines.length === 0) { showToast("Agrega al menos una presentación."); registeringRef.current = false; return; }

    setSaving(true);
    try {
      const sale = await adminApi.registerSale({
        branchId,
        clientOperationId: operationId,
        sourceChannel,
        fulfillmentMethod,
        sourceReference: null,
        customer: {
          name: customerName.trim() || null,
          phone: customerPhone.trim() || null,
          document: customerDocument.trim() || null,
          address: fulfillmentMethod === "delivery" ? deliveryAddress.trim() || null : null
        },
        discountTotal: discount,
        notes: notes.trim() || null,
        reservationId: null,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        // Con un solo medio el importe es el total: la pantalla no se lo
        // pregunta a la vendedora y tampoco se lo inventa aquí.
        payments: payments
          .map((payment) => ({
            payment,
            amount: singleMethod && total !== null ? total : toNumber(payment.amount)
          }))
          .filter(({ amount }) => amount > 0)
          .map(({ payment, amount }) => ({
            method: payment.method,
            amount,
            tenderedAmount: payment.method === "cash" && toNumber(payment.tenderedAmount) > 0
              ? toNumber(payment.tenderedAmount) : null,
            reference: payment.reference.trim() || null,
            evidencePath: null,
            receivedAt: null
          }))
      });

      showToast(`Venta ${sale.saleNumber} registrada ✓`);
      await resolveAssistantInteractions({ saleId: sale.id });
      clearDraft();
      await Promise.all([loadSales(), loadReservations()]);
    } catch (error) {
      handleApiError(error, "No se pudo registrar la venta.");
    } finally {
      setSaving(false);
      registeringRef.current = false;
    }
  }

  async function saveReservation() {
    if (saving) return;
    if (!branchId) { showToast("Elige la sede."); return; }
    if (!customerName.trim()) { showToast("Una reserva exige el nombre de la clienta."); return; }
    if (lines.length === 0) { showToast("Agrega al menos una presentación."); return; }

    const advance = payments.find((payment) => Number(payment.amount) > 0);

    setSaving(true);
    try {
      const reservation = await adminApi.createReservation({
        branchId,
        clientOperationId: operationId,
        customer: {
          name: customerName.trim(),
          phone: customerPhone.trim() || null,
          document: customerDocument.trim() || null
        },
        expiresAt: new Date(expiresAt).toISOString(),
        notes: notes.trim() || null,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        advance: advance
          ? {
              method: advance.method,
              amount: Number(advance.amount),
              tenderedAmount: advance.method === "cash" && Number(advance.tenderedAmount) > 0
                ? Number(advance.tenderedAmount) : null,
              reference: advance.reference.trim() || null,
              evidencePath: null,
              receivedAt: null
            }
          : null
      });

      showToast(`Reserva ${reservation.reservationNumber} registrada ✓`);
      await resolveAssistantInteractions({ reservationId: reservation.id });
      clearDraft();
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo registrar la reserva.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Conversión de una reserva. El adelanto se traslada dentro de la propia
   * transacción conservando su fecha original, así que aquí solo se cobra el
   * saldo pendiente.
   */
  async function convertReservation(summary: ReservationSummary) {
    if (busyReservationId) return;
    setBusyReservationId(summary.id);
    try {
      const detail: Reservation = await adminApi.getReservation(summary.id);
      const balance = money(detail.balance);
      const method = window.prompt(
        `Saldo por cobrar de ${detail.reservationNumber}: ${formatSoles(balance)}.\n` +
        "Medio de cobro (cash, yape, plin, transfer, card):",
        "cash"
      );
      if (method === null) return;
      if (balance > 0 && !CHARGEABLE_METHODS.includes(method as PaymentMethod)) {
        showToast("Medio de cobro no válido.");
        return;
      }

      const sale = await adminApi.registerSale({
        branchId: detail.branchId,
        clientOperationId: crypto.randomUUID(),
        sourceChannel: "in_store",
        fulfillmentMethod: "in_store",
        sourceReference: detail.reservationNumber,
        customer: { name: detail.customerName, phone: detail.customerPhone, document: null, address: null },
        discountTotal: 0,
        notes: null,
        reservationId: detail.id,
        lines: detail.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        payments: balance > 0
          ? [{ method: method as PaymentMethod, amount: balance, tenderedAmount: null, reference: null, evidencePath: null, receivedAt: null }]
          : []
      });

      showToast(`Reserva convertida en la venta ${sale.saleNumber} ✓`);
      await Promise.all([loadSales(), loadReservations()]);
    } catch (error) {
      handleApiError(error, "No se pudo convertir la reserva.");
    } finally {
      setBusyReservationId(null);
    }
  }

  async function releaseReservation(summary: ReservationSummary) {
    if (busyReservationId) return;
    const reason = window.prompt(`Motivo para liberar ${summary.reservationNumber}:`, "La clienta desistió");
    if (!reason) return;

    setBusyReservationId(summary.id);
    try {
      await adminApi.releaseReservation(summary.id, reason);
      showToast(`${summary.reservationNumber} liberada ✓`);
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo liberar la reserva.");
    } finally {
      setBusyReservationId(null);
    }
  }

  async function openSaleDetail(summary: SaleSummary) {
    try {
      setOpenSale(await adminApi.getSale(summary.id));
    } catch (error) {
      handleApiError(error, "No se pudo abrir la venta.");
    }
  }

  const totalUnits = evaluation?.totalUnits ?? lines.reduce((sum, line) => sum + line.quantity, 0);
  const canRegister = !saving && !evaluating && lines.length > 0 && total !== null && missing === 0;

  return (
    <div className="form-page br-fade order-page">
      <div className="form-head order-head">
        <div>
          <div className="form-title">{reservationMode ? "Registrar reserva" : "Registrar venta"}</div>
          <div className="field-hint">
            Los precios, el descuento prorrateado y el costo los resuelve PostgreSQL. Esta pantalla no calcula importes.
          </div>
        </div>
        <div className="order-steps" aria-label="Flujo de la venta">
          <span><b>1</b> Buscar</span><span><b>2</b> Agregar</span><span><b>3</b> Cobrar</span>
        </div>
      </div>

      <div className="order-workspace">
        <section className="form-card order-catalog">
          <div className="order-section-title">1. Buscar productos</div>
          <input
            ref={searchRef}
            className="input order-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Enter agrega solo si el resultado es inequívoco. Con varios, no
              // se adivina: elegir por la vendedora es peor que no hacer nada.
              if (event.key === "Enter" && results.length === 1) {
                event.preventDefault();
                addFound(results[0]);
              }
              if (event.key === "Escape") setSearch("");
            }}
            placeholder="Producto, marca, tono, código o escanea…"
            autoFocus
          />

          {loadingProducts ? (
            <div className="order-loading"><span className="spinner spinner--pink" /> Buscando…</div>
          ) : search.trim().length === 0 ? (
            <div className="order-empty">Busca por producto, marca, tono, SKU o escanea el código.</div>
          ) : results.length === 0 ? (
            <div className="order-empty">Nada coincide con «{search.trim()}».</div>
          ) : (
            <div className="order-products">
              {results.map((item) => {
                const enVenta = lines.find((line) => line.variantId === item.variantId)?.quantity ?? 0;
                const agotado = item.availability === "sold_out"
                  || (item.tracksInventory && item.availableQuantity <= 0);
                return (
                  <div key={item.variantId} className="order-product">
                    <div className="order-variant">
                      <span
                        className="pos-swatch"
                        style={item.referenceColor ? { background: item.referenceColor } : undefined}
                        aria-hidden="true"
                      />
                      <div className="pos-result-main">
                        <span className="order-product-brand">{item.brandName}</span>
                        <strong>{item.productName}</strong>
                        <small>
                          {[
                            item.shadeName ?? item.variantName,
                            item.shadeCode,
                            item.presentation,
                            item.tracksInventory ? `${item.availableQuantity} disp.` : null
                          ].filter(Boolean).join(" · ")}
                        </small>
                      </div>
                      <div className="order-variant-action">
                        <span>{formatSoles(item.unitPrice)}</span>
                        <button type="button" disabled={agotado} onClick={() => addFound(item)}>
                          {agotado ? "Agotado" : enVenta ? `Agregar otra (${enVenta})` : "Agregar"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {selectedProduct ? (
            <div className="order-variants">
              <div className="order-variants-head">
                <div><b>{selectedProduct.name}</b><small>{selectedProduct.brand.name}</small></div>
                <button type="button" onClick={() => setSelectedProduct(null)}>Cerrar</button>
              </div>
              {selectedProduct.variants.map((variant) => {
                const inSale = lines.find((line) => line.variantId === variant.id)?.quantity ?? 0;
                return (
                  <div key={variant.id} className="order-variant">
                    <div>
                      <strong>{variant.name}</strong>
                      <small>
                        SKU {variant.sku} · {variant.availability === "available"
                          ? "Disponible"
                          : variant.availability === "sold_out" ? "Agotado" : "Precio por consultar"}
                      </small>
                    </div>
                    <div className="order-variant-action">
                      <span>{formatSoles(retailPrice(variant))}</span>
                      <button type="button" disabled={variant.availability === "sold_out"} onClick={() => addVariant(selectedProduct, variant)}>
                        {inSale ? `Agregar otra (${inSale})` : "Agregar"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="form-card order-draft">
          <div className="order-section-title">2. Venta actual</div>

          <label className="sale-field">
            <span>Sede</span>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              {branches.length === 0 ? <option value="">Sin sedes asignadas</option> : null}
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </label>

          {lines.length === 0 ? (
            <div className="order-empty order-empty--draft">
              La venta está vacía.<br /><small>Elige un producto y una presentación.</small>
            </div>
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
                      <span>{evaluated?.purchaseMode === "wholesale" ? "Precio mayorista aplicado" : formatSoles(unitPrice)}</span>
                    </div>
                    <div className="order-qty">
                      <button type="button" aria-label="Restar una unidad" onClick={() => changeQuantity(line.variantId, -1)}>−</button>
                      <b>{line.quantity}</b>
                      <button type="button" aria-label="Sumar una unidad" onClick={() => changeQuantity(line.variantId, 1)}>+</button>
                    </div>
                    <div className="order-line-total">{formatSoles(evaluated?.subtotal ?? null)}</div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="sale-totals">
            <div><span>Bruto</span><b>{formatSoles(gross)}</b></div>
            <div>
              <span>Descuento</span>
              <input
                className="input sale-inline-input"
                inputMode="decimal"
                value={discountTotal}
                onChange={(event) => setDiscountTotal(event.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="sale-totals-final"><span>Total</span><b>{formatSoles(total)}</b></div>
            <small>
              {evaluating
                ? "Recalculando…"
                : `${totalUnits} ${totalUnits === 1 ? "unidad" : "unidades"} · el descuento se prorratea entre las líneas en PostgreSQL.`}
            </small>
          </div>

          <div className="order-section-title order-customer-title">3. Cliente y canal</div>
          <div className="order-customer-fields">
            <label><span>Nombre{reservationMode ? " *" : ""}</span>
              <input className="input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Nombre de la clienta" />
            </label>
            <label><span>Teléfono</span>
              <input className="input" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="999 999 999" inputMode="tel" />
            </label>
            <label><span>Documento</span>
              <input className="input" value={customerDocument} onChange={(event) => setCustomerDocument(event.target.value)} placeholder="DNI o RUC" />
            </label>
            <label><span>Origen</span>
              <select className="input" value={sourceChannel} onChange={(event) => setSourceChannel(event.target.value as SaleSourceChannel)}>
                {CHANNELS.map((channel) => <option key={channel} value={channel}>{SOURCE_CHANNEL_LABELS[channel]}</option>)}
              </select>
            </label>
            <label><span>Entrega</span>
              <select className="input" value={fulfillmentMethod} onChange={(event) => setFulfillmentMethod(event.target.value as FulfillmentMethod)}>
                {FULFILLMENTS.map((method) => <option key={method} value={method}>{FULFILLMENT_LABELS[method]}</option>)}
              </select>
            </label>
            {fulfillmentMethod === "delivery" ? (
              <label><span>Dirección</span>
                <input className="input" value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="Dirección o distrito" />
              </label>
            ) : null}
          </div>

          <textarea className="input textarea order-note" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Observación (opcional)" />

          <div className="order-section-title order-customer-title">
            {reservationMode ? "4. Adelanto" : "4. Cobro"}
          </div>
          {singleMethod ? (
            // Un solo medio: se asigna el 100% del total. Elegir el medio NO
            // confirma nada — siempre queda el último clic consciente abajo.
            <div className="sale-payments">
              <div className="sale-payment sale-payment--single">
                <div className="pay-methods">
                  {CHARGEABLE_METHODS.map((method) => (
                    <button
                      key={method}
                      type="button"
                      className={payments[0].method === method ? "pay-method pay-method--on" : "pay-method"}
                      onClick={() => updatePayment(payments[0].key, { method })}
                    >
                      {PAYMENT_METHOD_LABELS[method]}
                    </button>
                  ))}
                </div>

                {payments[0].method === "cash" ? (
                  <div className="pay-cash">
                    <label className="sale-field">
                      <span>Recibido</span>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={payments[0].tenderedAmount}
                        onChange={(event) => updatePayment(payments[0].key, { tenderedAmount: event.target.value })}
                        placeholder={total === null ? "" : String(total)}
                      />
                    </label>
                    <div className="pay-quick">
                      <button type="button" className="btn-ghost"
                        onClick={() => updatePayment(payments[0].key, { tenderedAmount: total === null ? "" : String(total) })}>
                        Exacto
                      </button>
                      {(total === null ? [] : cashSuggestions(total)).map((billete) => (
                        <button key={billete} type="button" className="btn-ghost"
                          onClick={() => updatePayment(payments[0].key, { tenderedAmount: String(billete) })}>
                          {formatSoles(billete)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <label className="sale-field">
                    <span>Referencia (opcional)</span>
                    <input className="input" type="text" value={payments[0].reference}
                      onChange={(event) => updatePayment(payments[0].key, { reference: event.target.value })} />
                  </label>
                )}
              </div>

              <button type="button" className="btn-soft" onClick={() => {
                setSplitPayment(true);
                // Al dividir, el primer medio arranca con lo que ya cubría.
                updatePayment(payments[0].key, { amount: total === null ? "" : String(total) });
              }}>
                Dividir pago
              </button>
            </div>
          ) : (
            <div className="sale-payments">
              {payments.map((payment) => (
                <div key={payment.key} className="sale-payment">
                  <select
                    className="input"
                    value={payment.method}
                    onChange={(event) => updatePayment(payment.key, { method: event.target.value as PaymentMethod })}
                  >
                    {CHARGEABLE_METHODS.map((method) => (
                      <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                    ))}
                  </select>
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={payment.amount}
                    onChange={(event) => assignAmount(payment.key, event.target.value)}
                    placeholder="Importe"
                  />
                  {payment.method === "cash" ? (
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={payment.tenderedAmount}
                      onChange={(event) => updatePayment(payment.key, { tenderedAmount: event.target.value })}
                      placeholder="Recibido"
                    />
                  ) : (
                    <input
                      className="input"
                      type="text"
                      value={payment.reference}
                      onChange={(event) => updatePayment(payment.key, { reference: event.target.value })}
                      placeholder="Referencia"
                    />
                  )}
                  <button type="button" className="btn-soft" onClick={() => coverRest(payment.key)} disabled={missing === null || missing <= 0}>
                    Completar
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label="Quitar el pago"
                    onClick={() => setPayments((current) => {
                      const rest = current.filter((item) => item.key !== payment.key);
                      if (rest.length === 0) return current;
                      if (rest.length === 1) setSplitPayment(false);
                      return rest;
                    })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {/* Al añadir un medio se PROPONE lo que falta: es la cifra que la
                  vendedora iba a teclear de todos modos. */}
              <button type="button" className="btn-soft" onClick={() => setPayments((current) =>
                [...current, newPayment("cash", missing !== null && missing > 0 ? String(missing) : "")]
              )}>
                Añadir otro medio de pago
              </button>
            </div>
          )}

          <div className="sale-balance">
            {singleMethod ? (
              // La confirmación de que está cubierto, sin pedir nada más.
              <span className={total === null ? "sale-balance--warn" : "sale-balance--ok"}>
                {total === null
                  ? "Sin total"
                  : `✓ ${PAYMENT_METHOD_LABELS[payments[0].method]} · ${formatSoles(total)}`}
              </span>
            ) : (
              <>
                <span>Cobrado <b>{formatSoles(paid)}</b></span>
                <span>Vuelto <b>{formatSoles(change)}</b></span>
                <span className={missing === 0 ? "sale-balance--ok" : "sale-balance--warn"}>
                  {missing === null ? "Sin total" : missing === 0 ? "Cuadra exacto" : missing > 0 ? `Faltan ${formatSoles(missing)}` : `Sobran ${formatSoles(-missing)}`}
                </span>
              </>
            )}
            {change > 0 ? <span className="pay-change">Vuelto <b>{formatSoles(change)}</b></span> : null}
          </div>

          {reservationMode ? (
            <label className="sale-field">
              <span>Vence el</span>
              <input className="input" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
            </label>
          ) : null}

          <div className="order-actions">
            <button type="button" className="btn-cancel" disabled={saving} onClick={clearDraft}>Limpiar</button>
            <button type="button" className="btn-soft" disabled={saving} onClick={() => setReservationMode((current) => !current)}>
              {reservationMode ? "Volver a venta" : "Guardar como reserva"}
            </button>
            {reservationMode ? (
              <button type="button" className="btn-save" disabled={saving || lines.length === 0 || !customerName.trim()} onClick={saveReservation}>
                {saving ? <span className="spinner" /> : null}{saving ? "Reservando…" : "Registrar reserva"}
              </button>
            ) : (
              <button type="button" className="btn-save" disabled={!canRegister} onClick={registerSale}>
                {saving ? <span className="spinner" /> : null}{saving ? "Registrando…" : "Registrar venta"}
              </button>
            )}
          </div>
        </section>
      </div>

      <section className="form-card order-history">
        <div className="order-history-head">
          <div>
            <div className="order-section-title">Reservas vigentes</div>
            <div className="field-hint">Una reserva compromete existencias sin descontarlas.</div>
          </div>
          <button type="button" className="btn-soft" onClick={loadReservations} disabled={loadingReservations}>Actualizar</button>
        </div>
        {loadingReservations ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando reservas…</div>
        ) : reservations.length === 0 ? (
          <div className="order-empty">No hay reservas vigentes.</div>
        ) : (
          <div className="order-history-list">
            {reservations.map((reservation) => (
              <div key={reservation.id} className="sale-reservation">
                <span><b>{reservation.reservationNumber}</b><small>{reservation.customerName}</small></span>
                <span><small>Vence</small>{saleDate(reservation.expiresAt)}</span>
                <span className="order-history-total">{formatSoles(reservation.total)}</span>
                <span className="sale-reservation-actions">
                  <button type="button" className="btn-save" disabled={busyReservationId === reservation.id} onClick={() => convertReservation(reservation)}>
                    Convertir en venta
                  </button>
                  <button type="button" className="btn-soft" disabled={busyReservationId === reservation.id} onClick={() => releaseReservation(reservation)}>
                    Liberar
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="form-card order-history">
        <div className="order-history-head">
          <div>
            <div className="order-section-title">Ventas recientes</div>
            <div className="field-hint">Últimas ventas de tus sedes.</div>
          </div>
          <button type="button" className="btn-soft" onClick={loadSales} disabled={loadingSales}>Actualizar</button>
        </div>
        {loadingSales ? (
          <div className="order-loading"><span className="spinner spinner--pink" /> Cargando ventas…</div>
        ) : sales.length === 0 ? (
          <div className="order-empty">Aún no hay ventas registradas.</div>
        ) : (
          <div className="order-history-list">
            {sales.map((sale) => (
              <details
                key={sale.id}
                className="order-history-item"
                onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) openSaleDetail(sale); }}
              >
                <summary>
                  <span className="order-history-code"><b>{sale.saleNumber}</b><small>{saleDate(sale.issuedAt)}</small></span>
                  <span className="order-history-customer">
                    <b>{sale.customerName ?? "Sin cliente"}</b>
                    <small>{SOURCE_CHANNEL_LABELS[sale.sourceChannel]} · {FULFILLMENT_LABELS[sale.fulfillmentMethod]}</small>
                  </span>
                  <span className="order-history-total">{formatSoles(sale.total)}</span>
                  <span className={`order-status order-status--${sale.status === "confirmed" ? "confirmed" : "cancelled"}`}>
                    {sale.status === "confirmed" ? "Confirmada" : "Anulada"}
                  </span>
                </summary>
                <div className="order-history-detail">
                  {openSale?.id === sale.id ? (
                    <>
                      <div className="order-history-lines">
                        {openSale.lines.map((line) => (
                          <div key={line.id}>
                            <span>{line.quantity} × {line.productName} · {line.variantName}</span>
                            <b>{formatSoles(line.subtotal)}</b>
                          </div>
                        ))}
                      </div>
                      <div className="order-history-meta">
                        {openSale.payments.map((payment) => (
                          <span key={payment.id}>
                            {PAYMENT_METHOD_LABELS[payment.method]}: {formatSoles(payment.amount)}
                            {payment.change ? ` (vuelto ${formatSoles(payment.change)})` : ""}
                            {payment.fromReservation ? " · adelanto trasladado" : ""}
                          </span>
                        ))}
                        {openSale.discountTotal > 0 ? <span>Descuento: {formatSoles(openSale.discountTotal)}</span> : null}
                        {openSale.sellerLabel ? <span>Atendió: {openSale.sellerLabel}</span> : null}
                      </div>
                    </>
                  ) : (
                    <div className="order-loading"><span className="spinner spinner--pink" /> Cargando…</div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
