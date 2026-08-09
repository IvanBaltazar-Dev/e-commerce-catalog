"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, publicAssetUrl, type OperableBranch, type ReservationSummary, type SaleSummary } from "@/lib/admin/api";
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
import type { CartEvaluation } from "@/lib/catalog/contracts";
import { formatSoles, publicApi } from "@/lib/public/catalog";
import { ToneSheet } from "@/components/admin/ToneSheet";
import {
  availabilityLabel,
  isSellable,
  priceRangeLabel,
  toneTint,
  type PosProductGroup,
  type PosTone,
  type PosToneSheet,
  type PosVariant
} from "@/lib/admin/pos";

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

/**
 * Cuántas coincidencias del mismo producto dejan de ser filas útiles y pasan a
 * ser una tarjeta con «N tonos → abrir». Por debajo, verlas sueltas es más
 * rápido; por encima, inundan el buscador y tapan los demás productos.
 */
const MAX_FILAS_POR_PRODUCTO = 3;

/**
 * Qué distingue a ESTA variante de su producto.
 *
 * En el catálogo real, un producto sin tonos llama a su única variante igual
 * que a sí mismo, y a veces la presentación repite lo mismo otra vez. Concatenar
 * los tres campos a ciegas produce «Base Ajos y Limon · Base Ajos y Limon», que
 * no informa de nada y ocupa la línea donde debería ir el dato útil.
 */
function variantSubtitle(item: PosVariant) {
  const nombre = item.shadeName ?? item.variantName;
  const vistos = new Set([item.productName.toLowerCase()]);
  const partes: string[] = [];
  for (const parte of [nombre, item.shadeCode, item.presentation]) {
    const limpio = parte?.trim();
    if (!limpio) continue;
    const clave = limpio.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    partes.push(limpio);
  }
  return partes;
}

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
  const [groups, setGroups] = useState<PosProductGroup[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLElement>(null);
  const [loadingProducts, setLoadingProducts] = useState(true);
  /** Tercera velocidad: el producto cuya carta de tonos está abierta. */
  const [openTones, setOpenTones] = useState<string | null>(null);

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
  const [confirmClear, setConfirmClear] = useState(false);
  /** La venta recién registrada: el cierre del circuito, no el historial. */
  const [justSold, setJustSold] = useState<Sale | null>(null);

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

  // Esc cierra el panel que esté abierto antes que nada: si hay un detalle de
  // venta encima, cerrarlo es lo que la vendedora quiere, no vaciar su búsqueda.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // La carta de tonos cierra sola: si estuviera abierta, vaciar aquí la
      // búsqueda le quitaría el suelo al volver.
      if (openTones) return;
      if (openSale) { setOpenSale(null); return; }
      if (search) setSearch("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSale, openTones, search]);

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
      setGroups([]);
      setLoadingProducts(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setLoadingProducts(true);
      try {
        const payload = await adminApi.searchPos(branchId, term);
        if (!cancelled) {
          setResults(payload.items ?? []);
          setGroups(payload.products ?? []);
        }
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
  /** Suma una unidad de una variante ya resuelta, venga de donde venga. */
  function addUnit(entry: {
    variantId: string;
    sku: string | null;
    productName: string;
    variantName: string;
    unitPrice: number | null;
  }) {
    setLines((current) => {
      const existing = current.find((line) => line.variantId === entry.variantId);
      if (existing) {
        return current.map((line) =>
          line.variantId === entry.variantId ? { ...line, quantity: line.quantity + 1 } : line);
      }
      return [...current, {
        variantId: entry.variantId,
        sku: entry.sku ?? "",
        productName: entry.productName,
        variantName: entry.variantName,
        quantity: 1,
        referencePrice: entry.unitPrice
      }];
    });
  }

  function addFound(item: PosVariant) {
    // Un tono sin precio vigente no se agrega en silencio: la venta saldría en
    // S/ 0.00 y nadie sabría por qué. Se dice qué falta y quién lo arregla.
    if (item.availability === "consult" || item.unitPrice === null) {
      showToast(`${item.productName} todavía no tiene precio: la dueña debe ponérselo antes de venderlo.`);
      return;
    }
    if (item.availability === "sold_out") return;
    addUnit({
      variantId: item.variantId,
      sku: item.sku,
      productName: item.productName,
      variantName: item.shadeName ?? item.variantName,
      unitPrice: item.unitPrice
    });
    showToast(`${item.productName} · ${item.shadeName ?? item.variantName} agregado`);
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  /**
   * Un toque en la carta de tonos ES el agregar. No hay un segundo botón
   * porque entonces vender un esmalte serían cuatro pasos y el máximo son tres.
   */
  function addTone(tone: PosTone, sheet: PosToneSheet) {
    if (!isSellable(tone)) return;
    addUnit({
      variantId: tone.variantId,
      sku: tone.sku,
      productName: sheet.product?.name ?? "",
      variantName: tone.shadeName ?? tone.variantName,
      unitPrice: tone.unitPrice
    });
  }

  /** «Limpiar selección»: deshace lo que esta apertura de la carta agregó. */
  function removeVariants(variantIds: string[]) {
    const quitar = new Set(variantIds);
    setLines((current) => current.filter((line) => !quitar.has(line.variantId)));
  }

  /** Un tono destacado de la tarjeta ya trae todo lo que hace falta. */
  function addHighlight(group: PosProductGroup, highlight: PosProductGroup["highlights"][number]) {
    if (group.priceFrom === null) {
      showToast(`${group.productName} todavía no tiene precio.`);
      return;
    }
    addUnit({
      variantId: highlight.variantId,
      sku: null,
      productName: group.productName,
      variantName: highlight.shadeName ?? highlight.variantName,
      unitPrice: group.priceFrom
    });
    showToast(`${group.productName} · ${highlight.shadeName ?? highlight.variantName} agregado`);
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
    setSplitPayment(false);
    setOpenTones(null);
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
      // El circuito no termina al cobrar: termina cuando la clienta se lleva su
      // nota y la vendedora puede empezar la siguiente. Esa pantalla es el
      // cierre, y desde ella se vuelve a vender de un toque.
      setJustSold(sale);
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

  /** Lo que la venta ya lleva, por variante. Es el único dueño de ese número:
   *  la carta de tonos lo lee, no lo guarda. */
  const counts = useMemo(
    () => new Map(lines.map((line) => [line.variantId, line.quantity])),
    [lines]
  );

  /**
   * Los productos que se ofrecen como tarjeta, y las filas sueltas que quedan.
   * Un esmalte con 164 tonos coincidentes no puede ocupar 164 filas: se
   * convierte en «164 tonos · 34 disponibles → Ver los tonos».
   */
  const { cards, rows } = useMemo(() => {
    const agrupados = groups.filter((group) => group.matchedVariants > MAX_FILAS_POR_PRODUCTO);
    const tapados = new Set(agrupados.map((group) => group.productId));
    return {
      cards: agrupados,
      rows: results.filter((item) => !tapados.has(item.productId))
    };
  }, [groups, results]);

  /**
   * Precio mayorista: se gana POR PRODUCTO sumando sus variantes, así que una
   * línea de 2 unidades puede llevarlo. Marcar esa línea con «MAYORISTA» a
   * secas parece un precio mal puesto; el motivo se explica una sola vez,
   * agrupado, con las unidades reales y el mínimo del producto.
   */
  const wholesaleNotes = useMemo(() => {
    if (!evaluation) return [];
    const porProducto = new Map<string, { name: string; units: number; minimum: number }>();
    for (const line of evaluation.lines) {
      if (line.purchaseMode !== "wholesale") continue;
      const actual = porProducto.get(line.productId);
      if (actual) {
        actual.units += line.quantity;
      } else {
        porProducto.set(line.productId, {
          name: line.productName,
          units: line.productQuantity || line.quantity,
          minimum: line.wholesaleRule?.minimumQuantity ?? 0
        });
      }
    }
    return [...porProducto.values()];
  }, [evaluation]);

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
              // Enter agrega solo si el resultado es inequívoco —el caso del
              // escáner—. Con varios no se adivina: elegir por la vendedora es
              // peor que no hacer nada.
              if (event.key === "Enter" && results.length === 1 && cards.length === 0) {
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
          ) : rows.length === 0 && cards.length === 0 ? (
            <div className="order-empty">Nada coincide con «{search.trim()}».</div>
          ) : (
            <div className="order-products">
              {/* Tercera velocidad: la clienta quiere elegir. Un esmalte con
                  164 tonos se ofrece como carta, no como 164 filas. */}
              {cards.map((group) => (
                <div key={group.productId} className="pos-card">
                  <div className="pos-card-head">
                    <div className="pos-result-main">
                      <span className="order-product-brand">{group.brandName}</span>
                      <strong>{group.productName}</strong>
                      <small>
                        {[
                          `${group.toneCount} tonos`,
                          `${group.availableCount} disponibles`,
                          group.presentation
                        ].filter(Boolean).join(" · ")}
                      </small>
                    </div>
                    <div className="pos-card-price">{priceRangeLabel(group)}</div>
                  </div>

                  {/* Tres tonos relevantes: lo que ESTA vendedora despachó hace
                      poco y, si no, lo que más sale. Nunca los tres primeros
                      alfabéticamente, que no le sirven a nadie. */}
                  {group.highlights.length > 0 ? (
                    <div className="pos-card-tones">
                      {group.highlights.map((highlight) => (
                        <button
                          key={highlight.variantId}
                          type="button"
                          className="pos-card-tone"
                          onClick={() => addHighlight(group, highlight)}
                          title={`${highlight.shadeName ?? highlight.variantName}${highlight.reason === "reciente" ? " · lo despachaste hace poco" : " · de los más vendidos"}`}
                        >
                          {highlight.swatchPath ? (
                            <img src={publicAssetUrl(highlight.swatchPath)} alt="" loading="lazy" />
                          ) : (
                            <span
                              className="pos-card-tone-flat"
                              style={{ background: toneTint({ referenceColor: highlight.referenceColor, familyValue: null }) ?? undefined }}
                            />
                          )}
                          <span>{highlight.shadeName ?? highlight.variantName}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="pos-card-open"
                    onClick={() => setOpenTones(group.productId)}
                  >
                    Ver los {group.toneCount} tonos →
                  </button>
                </div>
              ))}

              {rows.map((item) => {
                const enVenta = counts.get(item.variantId) ?? 0;
                const vendible = isSellable(item);
                return (
                  <div key={item.variantId} className="order-product">
                    <div className="order-variant">
                      <span
                        className="pos-swatch"
                        style={{ background: toneTint({ referenceColor: item.referenceColor, familyValue: null }) ?? undefined }}
                        aria-hidden="true"
                      />
                      <div className="pos-result-main">
                        <span className="order-product-brand">{item.brandName}</span>
                        <strong>{item.productName}</strong>
                        <small>
                          {[
                            ...variantSubtitle(item),
                            item.tracksInventory && vendible ? `${item.availableQuantity} disp.` : null
                          ].filter(Boolean).join(" · ")}
                        </small>
                      </div>
                      {/* Cuando no se puede vender, el motivo se dice UNA vez.
                          Un precio «Sin precio» junto a un botón «Sin precio»
                          es el mismo dato ocupando dos sitios. */}
                      {vendible ? (
                        <div className="order-variant-action">
                          <span>{formatSoles(item.unitPrice)}</span>
                          <button type="button" onClick={() => addFound(item)}>
                            {enVenta ? `Agregar otra (${enVenta})` : "Agregar"}
                          </button>
                        </div>
                      ) : (
                        <span className="pos-blocked">{availabilityLabel(item)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="form-card order-draft" ref={draftRef}>
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
                      <small>{line.variantName}</small>
                      {/* Solo un asterisco: el motivo del mayorista se explica
                          una vez, abajo, con las unidades reales. Marcar aquí
                          «MAYORISTA» sobre 2 unidades parece un precio mal
                          puesto, porque el motivo (2+1 del mismo producto) no
                          se ve desde la línea. */}
                      <span>
                        {formatSoles(unitPrice)}
                        {evaluated?.purchaseMode === "wholesale" ? <b className="order-line-star"> *</b> : null}
                      </span>
                    </div>
                    <div className="order-qty">
                      <button type="button" aria-label="Restar una unidad" onClick={() => changeQuantity(line.variantId, -1)}>−</button>
                      <b>{line.quantity}</b>
                      <button type="button" aria-label="Sumar una unidad" onClick={() => changeQuantity(line.variantId, 1)}>+</button>
                    </div>
                    <div className="order-line-total">{formatSoles(evaluated?.subtotal ?? null)}</div>
                    {/* Quitar una línea es inmediato: no se confirma lo que se
                        deshace volviendo a tocar el tono. */}
                    <button
                      type="button"
                      className="order-line-remove"
                      aria-label={`Quitar ${line.productName} ${line.variantName}`}
                      onClick={() => removeVariants([line.variantId])}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {wholesaleNotes.length > 0 ? (
            <div className="order-wholesale">
              {wholesaleNotes.map((nota) => (
                <span key={nota.name}>
                  * Precio mayorista aplicado: {nota.name} — {nota.units} unid.
                  {nota.minimum > 0 ? ` (mín. ${nota.minimum})` : ""}
                </span>
              ))}
            </div>
          ) : null}

          <div className="sale-totals">
            {/* Sin líneas no hay importe que consultar: es cero venta, no un
                precio desconocido. `formatSoles(null)` dice «Consultar», que
                aquí sería mentir sobre por qué no hay cifra. */}
            <div><span>Bruto</span><b>{lines.length === 0 ? "—" : formatSoles(gross)}</b></div>
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
            <div className="sale-totals-final"><span>Total</span><b>{lines.length === 0 ? "—" : formatSoles(total)}</b></div>
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

          {/* Vaciar la venta sí se confirma, y la confirmación dice qué se
              pierde: es lo único de esta pantalla que no se deshace tocando
              otra vez. */}
          {confirmClear ? (
            <div className="order-confirm">
              <p>
                Se quitan {totalUnits} {totalUnits === 1 ? "unidad" : "unidades"} y los datos de la clienta.
                <br />
                <small>No se cancela ninguna reserva ni se anula ninguna venta ya registrada.</small>
              </p>
              <div className="order-confirm-actions">
                <button type="button" className="btn-soft" onClick={() => setConfirmClear(false)}>Seguir con la venta</button>
                <button type="button" className="btn-cancel" onClick={() => { clearDraft(); setConfirmClear(false); }}>
                  Vaciar venta
                </button>
              </div>
            </div>
          ) : null}

          <div className="order-actions">
            <button
              type="button"
              className="btn-cancel"
              disabled={saving || lines.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              Vaciar venta
            </button>
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

      {/* En móvil el carrito queda debajo de los productos, así que el total
          dejaría de verse justo cuando más se mira. Esta barra lo mantiene a la
          vista y lleva a la venta de un toque. Solo aparece con algo dentro:
          una barra vacía es ruido fijo en pantalla. */}
      {/* Cierre del circuito: cobrada la venta, lo único que queda por decidir
          es si se imprime la nota o se sigue vendiendo. Nada más. */}
      {justSold ? createPortal(
        <div className="tone-backdrop" role="dialog" aria-modal="true" aria-label="Venta registrada">
          <section className="sale-done">
            <div className="sale-done-mark" aria-hidden="true">✓</div>
            <div className="sale-done-title">Venta {justSold.saleNumber} registrada</div>
            <div className="sale-done-total">{formatSoles(justSold.total)}</div>
            <div className="sale-done-detail">
              {justSold.lines.reduce((sum, line) => sum + line.quantity, 0)} unidades ·{" "}
              {justSold.payments.map((pago) => PAYMENT_METHOD_LABELS[pago.method]).join(" + ") || "sin cobro"}
              {justSold.payments.some((pago) => (pago.change ?? 0) > 0)
                ? ` · vuelto ${formatSoles(justSold.payments.reduce((sum, pago) => sum + (pago.change ?? 0), 0))}`
                : ""}
            </div>
            <div className="sale-done-actions">
              <a className="btn-save" href={`/admin/ventas/${justSold.id}/nota`} target="_blank" rel="noopener">
                Nota de venta
              </a>
              <button
                type="button"
                className="btn-soft"
                onClick={() => { setJustSold(null); searchRef.current?.focus(); }}
              >
                Nueva venta
              </button>
            </div>
          </section>
        </div>,
        document.body
      ) : null}

      {openTones && branchId ? (
        <ToneSheet
          branchId={branchId}
          productId={openTones}
          counts={counts}
          onPick={addTone}
          onClearPicked={removeVariants}
          onClose={() => {
            setOpenTones(null);
            searchRef.current?.focus();
          }}
        />
      ) : null}

      {lines.length > 0 ? (
        <div className="pos-cartbar">
          <span className="pos-cartbar-count">
            {totalUnits} {totalUnits === 1 ? "producto" : "productos"}
          </span>
          <b className="pos-cartbar-total">{total === null ? "—" : formatSoles(total)}</b>
          <button
            type="button"
            className="btn-save"
            onClick={() => draftRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Ver venta →
          </button>
        </div>
      ) : null}
    </div>
  );
}
