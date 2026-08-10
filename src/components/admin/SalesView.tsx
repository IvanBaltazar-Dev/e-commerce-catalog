"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, type OperableBranch, type PersonMatch } from "@/lib/admin/api";
import { ASSISTANT_HANDOFF_KEY, type AssistantHandoff } from "@/components/admin/AssistantView";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_STATUS_LABELS,
  TAX_DOCUMENT_LABELS,
  canFailDelivery,
  PAYMENT_METHOD_LABELS,
  fulfillmentGapMessage,
  fulfillmentGaps,
  nextFulfillmentStep,
  paymentReferenceLabel,
  requiresOperationNumber,
  roleForMethod,
  type FulfillmentMethod,
  type FulfillmentRequirement,
  type PaymentMethod,
  type PendingOperations,
  type PendingSale,
  type Reservation,
  type Sale,
  type SalePartyInput,
  type SaleSourceChannel
} from "@/lib/admin/sales";
import type { CartEvaluation } from "@/lib/catalog/contracts";
import { formatSoles, publicApi } from "@/lib/public/catalog";
import { ToneSheet } from "@/components/admin/ToneSheet";
import { TaxDocumentSheet } from "@/components/admin/TaxDocumentSheet";
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


const FULFILLMENTS: FulfillmentMethod[] = ["in_store", "pickup", "local_delivery", "shipping"];

/**
 * Quién cumple el rol de la entrega. No es una pregunta de identidad: es una
 * pregunta de logística, y por eso arranca en «la clienta» —que es el caso
 * abrumadoramente normal— y solo se abre cuando de verdad recibe otra persona.
 */
type RecipientMode = "buyer" | "other";

/** Los filtros de la hoja de pendientes. «all» es el estado normal: al abrirla,
 *  lo que se quiere ver es todo lo que queda por hacer. */
type PendingFilter = "all" | "delivery" | "payment" | "reservations";

const PENDING_FILTERS: Array<{ value: PendingFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "delivery", label: "Por entregar" },
  { value: "payment", label: "Por cobrar" },
  { value: "reservations", label: "Reservas" }
];

/** «Rosa Díaz» → «RD». Dos letras bastan para reconocer de un vistazo. */
const initialsOf = (name: string) =>
  name.trim().split(/\s+/).map((word) => word[0] ?? "").slice(0, 2).join("").toUpperCase() || "?";

/**
 * «51999111222» → «999 111 222». Se guarda con el 51 para que converjan las
 * distintas formas de teclearlo, pero nadie dicta su número así: se muestra
 * como se dice.
 */
function phoneLabel(phone: string) {
  const d = phone.replace(/\D/g, "").replace(/^51(?=\d{9}$)/, "");
  return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : phone;
}

/**
 * Un número suelto no identifica a nadie: hay que decir QUÉ es. El RUC peruano
 * tiene 11 dígitos y empieza por 10 o 20; el DNI, 8. Con eso se nombra solo, y
 * si no encaja en ninguno se dice «Doc.» en vez de adivinar mal.
 */
function documentLabel(document: string) {
  const d = document.replace(/\D/g, "");
  if (d.length === 11 && /^(10|15|17|20)/.test(d)) return `RUC ${d}`;
  if (d.length === 8) return `DNI ${d}`;
  return `Doc. ${document}`;
}

// Los cinco medios del prototipo y nada más. `reservation_advance` lo crea la
// conversión de una reserva, no esta pantalla. `store_credit` estaba aquí
// heredado de la lista del enum: no existe saldo a favor en el negocio, así que
// ofrecerlo era inventar un medio de pago.
const CHARGEABLE_METHODS: PaymentMethod[] = ["cash", "yape", "plin", "transfer", "card"];

/**
 * El campo del número de operación. UNO solo, usado por el pago único, por el
 * dividido y por el cobro del saldo.
 *
 * Existe porque las tres pantallas lo escribían por separado y ya habían
 * derivado: en pago único se llamaba «N.º de operación» y era obligatorio, en
 * dividido se llamaba «Referencia» —sonando opcional— y la base lo rechazaba
 * igual. Compartiendo el componente no pueden volver a discrepar.
 */
function OperationNumberField({
  method, value, onChange, autoFocus = false
}: {
  method: PaymentMethod;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const required = requiresOperationNumber(method);
  return (
    <label className="sale-field">
      <span>{paymentReferenceLabel(method)}</span>
      <input
        className={required && value.trim() === "" ? "input input--falta" : "input"}
        type="text"
        inputMode={required ? "numeric" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={required ? `Código de ${PAYMENT_METHOD_LABELS[method]}` : "Opcional"}
        aria-required={required}
        // Es lo único que queda por hacer al llegar aquí: el cursor ya está
        // puesto. El día que se lea solo de la captura de Yape, este campo se
        // rellena y ya está.
        autoFocus={autoFocus}
      />
    </label>
  );
}

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

  // Quién recibe o recoge. Arranca en «la clienta»: obligar a decidirlo en cada
  // venta convertiría el caso normal en una pregunta.
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("buyer");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientDocument, setRecipientDocument] = useState("");
  // Qué exige cada método. Se lee de la base al abrir la pantalla: es la misma
  // regla que después impide cerrar la venta, no una copia escrita aquí.
  const [requirements, setRequirements] = useState<FulfillmentRequirement[]>([]);
  // Contra entrega: se adelanta ahora y el saldo se cobra cuando la clienta
  // recibe el pedido. Arranca apagado — la venta normal se cobra entera.
  const [onDelivery, setOnDelivery] = useState(false);
  // `sourceChannel` ya no se elige en pantalla: la columna sigue existiendo y
  // se manda su valor por defecto. El origen REAL lo resuelve PostgreSQL.
  const [sourceChannel] = useState<SaleSourceChannel>("in_store");
  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("in_store");
  const [notes, setNotes] = useState("");

  // Clienta asociada. `null` no es un hueco por rellenar: es el estado normal
  // de una venta de mostrador.
  const [person, setPerson] = useState<PersonMatch | null>(null);
  const [clientOpen, setClientOpen] = useState(false);
  /** Posibles duplicados detectados mientras se registra. No es un buscador. */
  const [clientResults, setClientResults] = useState<PersonMatch[]>([]);
  const [clientSearching, setClientSearching] = useState(false);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientDocument, setNewClientDocument] = useState("");

  // Cobrar es una ventana: primero CUÁNTO, después CÓMO. Mezclar el importe
  // con los medios de pago en el carrito obliga a leer las dos cosas a la vez.
  const [payOpen, setPayOpen] = useState(false);
  // La ventana tiene dos pantallas, como el prototipo: primero se ELIGE el
  // medio, y solo después aparece lo que ese medio necesita (el vuelto del
  // efectivo, el código de Yape). Mostrarlo todo a la vez obliga a leer cinco
  // botones y tres campos para una decisión que es una sola.
  const [payMode, setPayMode] = useState<"pick" | "pay">("pick");
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
  /** La venta para la que se está pidiendo boleta o factura, si hay alguna. */
  const [taxFor, setTaxFor] = useState<Sale | null>(null);

  // Propuesta llegada del Asistente (Bloque 4). Se guarda quiénes fueron las
  // interacciones para CERRAR el ciclo con honestidad: al registrar la venta,
  // cada asistencia queda confirmada y enlazada a la venta que la persona
  // ejecutó aquí — la IA propuso, el humano vendió (regla 9).
  const assistantInteractionsRef = useRef<string[]>([]);

  // Pendientes: lo que queda por hacer, sea del tipo que sea. Reservas vivas,
  // pedidos por entregar y ventas por cobrar en una sola lectura — el saldo
  // llega resuelto de PostgreSQL, aquí no se resta nada.
  const [pending, setPending] = useState<PendingOperations>({ sales: [], reservations: [] });
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
  /** La venta cuyo saldo se está cobrando, si hay alguna. */
  const [settleFor, setSettleFor] = useState<PendingSale | null>(null);
  const [settleMethod, setSettleMethod] = useState<PaymentMethod | null>(null);
  const [settleReference, setSettleReference] = useState("");
  const [busySaleId, setBusySaleId] = useState<string | null>(null);
  const [loadingReservations, setLoadingReservations] = useState(false);
  const [busyReservationId, setBusyReservationId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);

  // Esc cierra el panel que esté abierto antes que nada: si hay un detalle de
  // venta encima, cerrarlo es lo que la vendedora quiere, no vaciar su búsqueda.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // La carta de tonos cierra sola: si estuviera abierta, vaciar aquí la
      // búsqueda le quitaría el suelo al volver.
      if (openTones) return;
      if (pendingOpen) { setPendingOpen(false); return; }
      if (search) setSearch("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingOpen, openTones, search]);

  const loadBranches = useCallback(async () => {
    try {
      const items = await adminApi.listOperableBranches();
      setBranches(items);
      setBranchId((current) => current || items.find((item) => item.isDefault)?.id || items[0]?.id || "");
    } catch (error) {
      handleApiError(error, "No se pudieron cargar las sedes en las que puedes operar.");
    }
  }, [handleApiError]);

  const loadReservations = useCallback(async () => {
    setLoadingReservations(true);
    try {
      setPending(await adminApi.listPendingOperations());
    } catch (error) {
      handleApiError(error, "No se pudieron cargar los pendientes.");
    } finally {
      setLoadingReservations(false);
    }
  }, [handleApiError]);

  /** Abre la ventana Y pide los datos: no se cargan «por si acaso». */
  const openPending = useCallback(() => {
    setPendingOpen(true);
    void loadReservations();
  }, [loadReservations]);

  const openClient = useCallback(() => {
    setClientOpen(true);
    setClientResults([]);
    setNewClientName("");
    setNewClientPhone("");
    setNewClientDocument("");
  }, []);

  /** Quitar la clienta no toca la venta: los productos y el total siguen. */
  const clearClient = useCallback(() => {
    setPerson(null);
    setCustomerName("");
    setCustomerPhone("");
    setCustomerDocument("");
  }, []);

  const pickPerson = useCallback((match: PersonMatch) => {
    setPerson(match);
    setCustomerName(match.fullName);
    setCustomerPhone(match.phone ?? "");
    setCustomerDocument(match.document ?? "");
    setClientOpen(false);
  }, []);

  /**
   * Alta desde la venta. Los tres campos que el sistema realmente usa: el
   * nombre sale impreso en la nota, el celular une su WhatsApp y le lleva esa
   * nota, y el documento es lo que exige una boleta. Email y notas existen en
   * `persons` pero se completan en su ficha: aquí estorbarían.
   */
  const createPerson = useCallback(async () => {
    const nombre = newClientName.trim();
    if (nombre.length < 2) { showToast("Escribe el nombre de la clienta."); return; }
    setCreatingPerson(true);
    try {
      pickPerson(await adminApi.createPerson({
        fullName: nombre,
        phone: newClientPhone.trim() || null,
        document: newClientDocument.trim() || null
      }));
      showToast(`${nombre} queda asociada a esta venta ✓`);
    } catch (error) {
      handleApiError(error, "No se pudo registrar la clienta.");
    } finally {
      setCreatingPerson(false);
    }
  }, [handleApiError, newClientDocument, newClientName, newClientPhone, pickPerson, showToast]);

  // Detección de duplicados MIENTRAS se registra, no un buscador aparte.
  //
  // Se dispara con el celular si ya hay tres dígitos —es el dato que de verdad
  // identifica— y si no, con el nombre. A partir de tres caracteres: con dos,
  // media agenda coincide y el aviso se convierte en ruido que se aprende a
  // ignorar, que es peor que no avisar.
  useEffect(() => {
    if (!clientOpen) return;
    const termino = (newClientPhone.trim().length >= 3 ? newClientPhone : newClientName).trim();
    if (termino.length < 3) { setClientResults([]); return; }
    let vigente = true;
    setClientSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const found = await adminApi.searchPersons(termino);
        if (vigente) setClientResults(found);
      } catch {
        if (vigente) setClientResults([]);
      } finally {
        if (vigente) setClientSearching(false);
      }
    }, 250);
    return () => { vigente = false; window.clearTimeout(id); };
  }, [clientOpen, newClientName, newClientPhone]);

  // Al abrir la pantalla solo se carga lo que hace falta para vender. El
  // historial y las reservas se piden cuando se abren, no antes: eran dos
  // peticiones en el camino crítico alimentando paneles que nadie mira al
  // empezar una venta, y la vendedora las esperaba con la clienta delante.
  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  // Los requisitos de entrega SÍ entran en el camino crítico: sin ellos la
  // pantalla no sabe qué preguntar, y preguntarlo después de cobrar es tarde.
  // Es una lectura de cuatro filas.
  useEffect(() => {
    let vigente = true;
    adminApi.listFulfillmentRequirements()
      .then((items) => { if (vigente) setRequirements(items); })
      // Un fallo aquí no puede impedir vender de mostrador, que no exige nada:
      // la base sigue siendo la que impide entregar sin datos.
      .catch(() => undefined);
    return () => { vigente = false; };
  }, []);

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

    // Con la caja vacía SÍ se pregunta: desde 0056 el servidor devuelve los más
    // vendidos de la sede. Una pantalla de venta que abre sin proponer nada
    // obliga a saber de antemano qué teclear.
    if (!branchId) {
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
  /**
   * El descuento no puede pasarse del bruto. Sin este tope, teclear 20000 sobre
   * una venta de 100 daba un total de S/ -19,900: una venta en negativo que la
   * pantalla ofrecía cobrar. Se recorta al bruto en vez de rechazarlo, para no
   * bloquear a quien está tecleando; lo que se aplica es siempre lo recortado.
   */
  const discountTyped = money(Math.max(0, Number(discountTotal) || 0));
  const discount = gross === null ? discountTyped : Math.min(discountTyped, gross);
  const discountCapped = discountTyped > discount;
  const total = gross === null ? null : money(gross - discount);
  // Con un solo medio no se pregunta el importe: es el total. El campo existía
  // para que la vendedora tecleara un número que la pantalla ya conocía.
  const singleMethod = !splitPayment && payments.length === 1;

  /** Solo delivery y envío admiten contra entrega: lo dice la base, no esto. Si
   *  se cambia a un método que no la admite, la modalidad se cae sola en vez de
   *  quedarse encendida y hacer fallar el cobro sin explicar por qué. */
  const allowsOnDelivery = requirements
    .find((item) => item.method === fulfillmentMethod)?.allowsOnDelivery === true;
  const chargingOnDelivery = onDelivery && allowsOnDelivery;

  const paid = useMemo(() => {
    // Contra entrega el importe NO se autocompleta: lo que se cobra ahora es el
    // adelanto, y cuánto es lo decide quien vende, no la pantalla.
    if (singleMethod && total !== null && !chargingOnDelivery) return total;
    return money(payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
  }, [payments, singleMethod, total, chargingOnDelivery]);

  const change = useMemo(
    () => money(payments.reduce((sum, payment) => {
      if (payment.method !== "cash") return sum;
      const tendered = toNumber(payment.tenderedAmount);
      const asignado = singleMethod && total !== null && !chargingOnDelivery
        ? total : toNumber(payment.amount);
      return sum + (tendered > asignado ? tendered - asignado : 0);
    }, 0)),
    [payments, singleMethod, total, chargingOnDelivery]
  );
  const missing = total === null ? null : money(total - paid);
  /** Lo que quedará por cobrar cuando la clienta reciba el pedido. */
  const pendingBalance = chargingOnDelivery ? missing : null;

  /** Los pendientes que pasan el filtro, ordenados por lo más antiguo: lo que
   *  lleva más tiempo esperando es lo que más urge. */
  const visiblePending = useMemo(() => {
    const ventas = pending.sales.filter((sale) =>
      pendingFilter === "all" ? true
      : pendingFilter === "delivery" ? sale.needsDelivery
      : pendingFilter === "payment" ? sale.needsPayment
      : false);
    const reservas = pendingFilter === "all" || pendingFilter === "reservations"
      ? pending.reservations : [];
    return [...ventas, ...reservas].sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));
  }, [pending, pendingFilter]);

  // ---------------------------------------------------------------------------
  // La entrega
  // ---------------------------------------------------------------------------
  const requirement = useMemo(
    () => requirements.find((item) => item.method === fulfillmentMethod) ?? null,
    [requirements, fulfillmentMethod]
  );
  /** El método no pide a nadie: no hay sección que mostrar. */
  const needsParty = requirement?.requiresRecipient === true;
  const partyRole = roleForMethod(fulfillmentMethod);
  /** Se sabe quién compra: hay ficha asociada o al menos un nombre escrito. */
  const buyerKnown = Boolean(person) || customerName.trim() !== "";
  /** Sin compradora conocida no hay a qué apuntar: se piden los datos y ya está.
   *  Obligar a crear una clienta para poder entregar es la fricción que sobra. */
  const effectiveMode: RecipientMode = buyerKnown ? recipientMode : "other";

  const partyDraft = useMemo<SalePartyInput | null>(() => {
    if (!needsParty) return null;
    if (effectiveMode === "buyer") {
      // No se copia un solo dato: `isBuyer` es lo que permite decir «recibe la
      // clienta» sin duplicar su nombre en la entrega.
      return {
        role: partyRole,
        isBuyer: true,
        personId: person?.id ?? null,
        fullName: null,
        phone: null,
        documentNumber: null,
        address: deliveryAddress.trim() || null,
        notes: null
      };
    }
    return {
      role: partyRole,
      isBuyer: false,
      personId: null,
      fullName: recipientName.trim() || null,
      phone: recipientPhone.trim() || null,
      documentNumber: recipientDocument.trim() || null,
      address: deliveryAddress.trim() || null,
      notes: null
    };
  }, [needsParty, effectiveMode, partyRole, person, deliveryAddress, recipientName, recipientPhone, recipientDocument]);

  /** Lo que falta para poder entregar, según la MISMA regla que aplica la base. */
  const deliveryGaps = useMemo(
    () => fulfillmentGaps({
      requirement,
      party: partyDraft,
      buyer: {
        name: customerName,
        phone: customerPhone,
        document: customerDocument,
        address: deliveryAddress
      }
    }),
    [requirement, partyDraft, customerName, customerPhone, customerDocument, deliveryAddress]
  );
  const deliveryMessage = fulfillmentGapMessage(deliveryGaps);

  /**
   * Agrega la variante que el buscador ya resolvió y devuelve el foco al
   * buscador: en mostrador se encadenan productos, y obligar a volver con el
   * ratón entre uno y otro rompe el ritmo de la venta.
   */
  /** Suma una unidad de una variante ya resuelta, venga de donde venga. */
  /**
   * Agrega UNA unidad, sin pasar del stock de esa variante en esta sede.
   *
   * El tope va aquí y no en cada sitio que llama, porque hay tres puertas de
   * entrada —la carta de tonos, los tonos destacados de la tarjeta y las filas
   * del buscador— y la que se olvide es por donde se sobrevende. PostgreSQL
   * volvería a rechazarlo al registrar, pero para entonces la clienta ya
   * escuchó un precio que incluía unidades que no existen.
   */
  function addUnit(entry: {
    variantId: string;
    sku: string | null;
    productName: string;
    variantName: string;
    unitPrice: number | null;
    available?: number;
    tracksInventory?: boolean;
  }) {
    // El tope se comprueba ANTES de `setLines`, no dentro del updater: React
    // ejecuta el updater en fase de render, y avisar desde ahí actualiza el
    // ToastProvider mientras SalesView se está renderizando.
    const tope = entry.tracksInventory === false ? null : entry.available ?? null;
    const yaLleva = lines.find((line) => line.variantId === entry.variantId)?.quantity ?? 0;

    if (tope !== null && yaLleva + 1 > tope) {
      showToast(
        tope === 0
          ? `${entry.variantName} está agotado.`
          : `Solo quedan ${tope} de ${entry.variantName}.`
      );
      return;
    }

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
      unitPrice: item.unitPrice,
      available: item.availableQuantity,
      tracksInventory: item.tracksInventory
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
      unitPrice: tone.unitPrice,
      available: tone.availableQuantity,
      tracksInventory: tone.tracksInventory
    });
  }

  /** Quita una unidad desde la carta de tonos; si llega a cero, quita la línea. */
  function removeTone(tone: PosTone) {
    setLines((current) =>
      current.flatMap((line) => {
        if (line.variantId !== tone.variantId) return [line];
        return line.quantity > 1 ? [{ ...line, quantity: line.quantity - 1 }] : [];
      })
    );
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
      unitPrice: group.priceFrom,
      available: highlight.availableQuantity,
      tracksInventory: highlight.tracksInventory
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
    setPerson(null);
    setFulfillmentMethod("in_store");
    setRecipientMode("buyer");
    setRecipientName("");
    setRecipientPhone("");
    setRecipientDocument("");
    setOnDelivery(false);
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
    // Se dice qué falta ANTES de cobrar. La base lo impediría igual, pero
    // enterarse después de haber cobrado es la peor manera de enterarse.
    if (deliveryMessage) { showToast(deliveryMessage); registeringRef.current = false; return; }

    setSaving(true);
    try {
      const sale = await adminApi.registerSale({
        branchId,
        clientOperationId: operationId,
        sourceChannel,
        fulfillmentMethod,
        entryMode: "store_quick",
        personId: person?.id ?? null,
        sourceReference: null,
        // La instantánea de la COMPRADORA. La dirección NO va aquí: pertenece a
        // la entrega —la misma clienta puede pedir a su casa hoy y a su trabajo
        // mañana— y viaja con el rol que la recibe.
        customer: {
          name: customerName.trim() || null,
          phone: customerPhone.trim() || null,
          document: customerDocument.trim() || null,
          address: null
        },
        parties: partyDraft ? [partyDraft] : [],
        paymentTerms: chargingOnDelivery ? "on_delivery" : "immediate",
        discountTotal: discount,
        notes: notes.trim() || null,
        reservationId: null,
        lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        // Con un solo medio el importe es el total: la pantalla no se lo
        // pregunta a la vendedora y tampoco se lo inventa aquí.
        payments: payments
          .map((payment) => ({
            payment,
            // Contra entrega lo que se cobra es el adelanto que se tecleó, no el
            // total: autocompletarlo cobraría de más y dejaría sin sentido la
            // modalidad entera.
            amount: singleMethod && total !== null && !chargingOnDelivery
              ? total : toNumber(payment.amount)
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
      setPayOpen(false);
      setJustSold(sale);
      // Ya no se refresca nada aquí: el historial vive en su propia pantalla y
      // las reservas se releen al abrir su ventana. Cobrar no debe esperar a
      // dos peticiones que alimentan paneles que ya no están.
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
    // No basta con decir que falta: hay que llevar a donde se arregla. Un botón
    // que no responde y un aviso que no lleva a ningún sitio son el mismo
    // problema visto desde dos lados.
    if (lines.length === 0) {
      showToast("Agrega al menos una presentación para reservarla.");
      searchRef.current?.focus();
      return;
    }
    if (!customerName.trim() && !person) {
      showToast("Una reserva se guarda a nombre de alguien: dime quién.");
      setClientOpen(true);
      return;
    }

    const advance = payments.find((payment) => Number(payment.amount) > 0);

    setSaving(true);
    try {
      const reservation = await adminApi.createReservation({
        branchId,
        clientOperationId: operationId,
        // Se conserva la clienta enlazada. Perderla aquí era volver a partir su
        // historial justo en la operación que más habla de que va a volver.
        personId: person?.id ?? null,
        customer: {
          name: customerName.trim() || person?.fullName || "",
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
  /**
   * Mover el pedido al siguiente paso de su entrega. Qué transiciones valen lo
   * decide PostgreSQL; aquí solo se ofrece la que toca.
   */
  async function advanceFulfillment(sale: PendingSale) {
    const step = nextFulfillmentStep(sale.fulfillmentStatus, sale.fulfillmentMethod);
    if (!step || busySaleId) return;
    setBusySaleId(sale.id);
    try {
      await adminApi.markSaleFulfillment(sale.id, { status: step.status, note: null });
      showToast(`${sale.number} · ${step.label.toLowerCase()} ✓`);
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo mover la entrega.");
    } finally {
      setBusySaleId(null);
    }
  }

  /**
   * Marcar que no se pudo entregar. El motivo NO es opcional y lo exige también
   * PostgreSQL: de él depende qué se hace mañana —reintentar, anular, devolver—
   * y «no se pudo entregar» a secas no sirve para decidir ninguna de las tres.
   */
  async function failFulfillment(sale: PendingSale) {
    if (busySaleId) return;
    const motivo = window.prompt(
      `¿Por qué no se pudo entregar ${sale.number}?\n` +
      "Nadie contestó, el número no responde, la dirección no existe, se arrepintió…",
      ""
    );
    if (motivo === null) return;
    if (motivo.trim() === "") {
      showToast("Sin el motivo no se puede decidir qué hacer mañana con este pedido.");
      return;
    }
    setBusySaleId(sale.id);
    try {
      await adminApi.markSaleFulfillment(sale.id, { status: "failed", note: motivo.trim() });
      showToast(`${sale.number} · no se pudo entregar`);
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo registrar el intento fallido.");
    } finally {
      setBusySaleId(null);
    }
  }

  /**
   * Cobrar el saldo. El importe NO se pregunta: el saldo se cobra entero al
   * entregar, así que la pantalla ya lo sabe y hacer que se teclee sería pedir
   * un número que está escrito dos centímetros más arriba.
   */
  async function settleBalance() {
    if (!settleFor || !settleMethod || busySaleId) return;
    if (requiresOperationNumber(settleMethod) && settleReference.trim() === "") {
      showToast("Falta el N.º de operación.");
      return;
    }
    setBusySaleId(settleFor.id);
    try {
      const sale = await adminApi.settleSaleBalance(settleFor.id, {
        clientOperationId: crypto.randomUUID(),
        payments: [{
          method: settleMethod,
          amount: settleFor.balance,
          tenderedAmount: null,
          reference: settleReference.trim() || null,
          evidencePath: null,
          receivedAt: null
        }]
      });
      showToast(`Saldo de ${sale.saleNumber} cobrado ✓`);
      setSettleFor(null);
      setSettleMethod(null);
      setSettleReference("");
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo cobrar el saldo.");
    } finally {
      setBusySaleId(null);
    }
  }

  async function convertReservation(summary: { id: string; reservationNumber: string }) {
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
        // La venta nace de una reserva: su origen lo hereda de la cadena de esa
        // reserva, no de lo que se elija aquí.
        entryMode: "reservation",
        sourceReference: detail.reservationNumber,
        customer: { name: detail.customerName, phone: detail.customerPhone, document: null, address: null },
        // Una reserva se convierte y se entrega en el mostrador: quien viene a
        // pagar el saldo se lleva su pedido. Si algún día se convierte con
        // delivery, la entrega se pedirá aquí como en cualquier otra venta.
        parties: [],
        // Convertir una reserva es cobrar su saldo en el mostrador: se paga
        // entero en el acto. Contra entrega es la modalidad contraria y se
        // decide al tomar el pedido, no al convertirlo.
        paymentTerms: "immediate",
        discountTotal: 0,
        notes: null,
        reservationId: detail.id,
        lines: detail.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
        payments: balance > 0
          ? [{ method: method as PaymentMethod, amount: balance, tenderedAmount: null, reference: null, evidencePath: null, receivedAt: null }]
          : []
      });

      showToast(`Reserva convertida en la venta ${sale.saleNumber} ✓`);
      setPendingOpen(false);
      await loadReservations();
    } catch (error) {
      handleApiError(error, "No se pudo convertir la reserva.");
    } finally {
      setBusyReservationId(null);
    }
  }

  async function releaseReservation(summary: { id: string; reservationNumber: string }) {
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

  const totalUnits = evaluation?.totalUnits ?? lines.reduce((sum, line) => sum + line.quantity, 0);
  /** Yape, Plin, transferencia y tarjeta sin código no se pueden confirmar. Se
   *  guarda CUÁL falta: con el pago dividido, «falta el N.º de operación» sin
   *  decir de cuál de los dos medios obliga a buscarlo a ojo. */
  const missingReferenceFor = payments.find(
    (payment) => requiresOperationNumber(payment.method) && payment.reference.trim() === ""
  ) ?? null;
  const missingReference = missingReferenceFor !== null;
  // Contra entrega no tiene que cuadrar hoy: tiene que haber adelanto y no
  // pasarse del total. Lo que falte se cobra al entregar, y esa es la modalidad,
  // no un error.
  const paymentSettled = chargingOnDelivery
    ? paid > 0 && missing !== null && missing >= 0
    : missing === 0;
  const canRegister =
    !saving && !evaluating && lines.length > 0 && total !== null && paymentSettled && !missingReference;

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
            Busca el tono por su nombre, escanea el código o abre la carta. El precio y el mayoreo los calcula el sistema.
          </div>
        </div>
        <div className="order-steps" aria-label="Flujo de la venta">
          <span><b>1</b> Buscar</span><span><b>2</b> Agregar</span><span><b>3</b> Cobrar</span>
        </div>
      </div>

      <div className="order-workspace">
        <section className="form-card order-catalog">
          <div className="order-section-title">
            1. Buscar productos
            {/* Lo que se está mirando se nombra: sin esto, las tarjetas de los
                más vendidos parecen un resultado de búsqueda vacío. */}
            {search.trim().length === 0 && cards.length > 0 ? (
              <span className="order-section-note">Los más vendidos</span>
            ) : null}
          </div>
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
          ) : search.trim().length === 0 && cards.length === 0 ? (
            <div className="order-empty">Busca por producto, marca, tono, SKU o escanea el código.</div>
          ) : rows.length === 0 && cards.length === 0 ? (
            // Sin resultados no basta con decir que no hay: se ofrece por dónde
            // seguir. Los atajos son los ejes reales del catálogo, no ejemplos.
            <div className="order-empty order-empty--nohit">
              <b>No encontramos «{search.trim()}»</b>
              <span>Prueba con el nombre del tono, la marca o el código. También puedes escanear.</span>
              <span className="order-suggestions">
                {["Masglo", "Gel", "Pestañas", "Acrílico"].map((atajo) => (
                  <button key={atajo} type="button" className="order-suggestion" onClick={() => setSearch(atajo)}>
                    {atajo}
                  </button>
                ))}
              </span>
            </div>
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
                    <div className="pos-card-price">
                      {priceRangeLabel(group)}
                      {/* El mayoreo se anuncia ANTES de activarse. El umbral es
                          del producto y lo configura la dueña: nunca «desde 3»
                          como constante. */}
                      {group.wholesalePrice !== null
                        && group.wholesaleMinQuantity !== null
                        && group.priceFrom !== null
                        && group.wholesalePrice < group.priceFrom ? (
                        <small className="pos-card-wholesale">
                          {formatSoles(group.wholesalePrice)} desde {group.wholesaleMinQuantity}
                        </small>
                      ) : null}
                    </div>
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
                          {/* Color plano, nunca la foto: las que hay son del
                              envase entero y en 15px devuelven la tapa, no el
                              esmalte. Misma regla que la carta de tonos. */}
                          <span
                            className="pos-card-tone-flat"
                            style={{ background: toneTint({ referenceColor: highlight.referenceColor, familyValue: null }) ?? undefined }}
                          />
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
          <div className="order-cart-head">
            <div className="order-section-title">2. Venta actual</div>
            <span className="order-cart-meta">
              {totalUnits > 0 ? `${totalUnits} ${totalUnits === 1 ? "unidad" : "unidades"}` : null}
              {/* En color de advertencia y siempre legible: es la única acción
                  de esta pantalla que no se deshace tocando otra vez. */}
              {lines.length > 0 ? (
                <button type="button" className="btn-empty-sale" disabled={saving} onClick={() => setConfirmClear(true)}>
                  Vaciar venta
                </button>
              ) : null}
            </span>
          </div>

          {/* La sede solo se pregunta cuando hay algo que preguntar. Con una
              sola asignada la respuesta es siempre la misma, y un desplegable
              de una opción no informa: invita a tocarlo y a dudar. */}
          {branches.length > 1 ? (
            <label className="sale-field">
              <span>Sede</span>
              <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
          ) : null}

          {/* La clienta va ARRIBA, antes de los productos: es a quién se le
              vende, no un dato que se rellena al final. Cobrar no exige
              saberlo — «Venta rápida · Sin identificar» es el estado normal. */}
          <div className={person ? "clientrow clientrow--has" : "clientrow"}>
            <span className="clientrow-mark" aria-hidden="true">
              {person ? initialsOf(person.fullName) : "?"}
            </span>
            <span className="clientrow-body">
              <p className="clientrow-name">{person?.fullName ?? "Venta rápida"}</p>
              <p className="clientrow-sub">
                {person
                  ? [
                      person.phone ? `WhatsApp ${phoneLabel(person.phone)}` : null,
                      person.document ? documentLabel(person.document) : null
                    ].filter(Boolean).join(" · ") || "Clienta registrada"
                  : "Sin identificar"}
              </p>
            </span>
            <button type="button" className="clientrow-action" onClick={person ? clearClient : openClient}>
              {/* «Asociar» es palabra de sistema, no de mostrador. Quien vende
                  agrega a la clienta, no la asocia a un registro. */}
              {person ? "Quitar" : "Agregar clienta"}
            </button>
          </div>

          {/* Las reservas no viven en esta pantalla: se traen cuando se
              necesitan. Un panel permanente de reservas convierte la pantalla
              de vender en un tablero de consulta. */}
          <button type="button" className="order-pending-open" onClick={openPending}>
            <span aria-hidden="true">🕘</span> Cargar reserva o carrito pendiente
          </button>

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
            {/* Se dice lo que de verdad se va a aplicar. Recortar en silencio
                dejaría a la vendedora creyendo que descontó lo que tecleó. */}
            {discountCapped ? (
              <small className="sale-discount-capped">
                El descuento no puede pasar del bruto: se aplica {formatSoles(discount)}.
              </small>
            ) : null}
            <div className="sale-totals-final"><span>Total</span><b>{lines.length === 0 ? "—" : formatSoles(total)}</b></div>
            <small>
              {evaluating
                ? "Recalculando…"
                : `${totalUnits} ${totalUnits === 1 ? "unidad" : "unidades"} · el descuento se reparte entre las líneas.`}
            </small>
          </div>


          <textarea className="input textarea order-note" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Observación (opcional)" />

          {/* Un solo botón. Elegir medio, contar el vuelto y confirmar pasan
              a su ventana: en el carrito solo queda la decisión, no el
              procedimiento. */}
          <button
            type="button"
            className="cta-charge"
            disabled={saving || lines.length === 0 || total === null}
            onClick={() => { setPayMode("pick"); setPayOpen(true); }}
          >
            {reservationMode ? "Guardar reserva" : `Cobrar ${lines.length === 0 || total === null ? "" : formatSoles(total)}`}
          </button>

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

          {/* Reservar es la otra salida de esta pantalla, y va callada: la
              acción principal es cobrar. Confirmar el cobro vive en su
              ventana, no aquí. */}
          <div className="order-actions order-actions--secondary">
            <button type="button" className="btn-soft" disabled={saving} onClick={() => setReservationMode((current) => !current)}>
              {reservationMode ? "Volver a venta" : "Guardar como reserva"}
            </button>
            {/* El botón solo se deshabilita mientras se está guardando. Si falta
                algo, responde igual y `saveReservation` dice qué falta y abre el
                sitio donde se arregla: un botón muerto no explica nada, y quien
                vende se queda mirándolo con la clienta delante. */}
            {reservationMode ? (
              <button type="button" className="btn-save" disabled={saving} onClick={saveReservation}>
                {saving ? <span className="spinner" /> : null}{saving ? "Reservando…" : "Registrar reserva"}
              </button>
            ) : null}
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------------------
          Cobrar: ventana, no sección. Primero CUÁNTO, después CÓMO.
          ------------------------------------------------------------------ */}
      {payOpen ? (
        <div
          className="ov on"
          role="dialog"
          aria-modal="true"
          aria-label="Cobrar"
          onClick={(event) => { if (event.target === event.currentTarget) setPayOpen(false); }}
        >
          <div className="sheet">
            <div className="shead">
              <h2>Cobrar</h2>
              <button type="button" className="xbtn" onClick={() => setPayOpen(false)} aria-label="Volver a la venta">×</button>
            </div>
            <div className="sbody">
              {/* El importe manda: es lo primero que mira quien cobra y lo que
                  la clienta pregunta. */}
              <div className="amtbig">
                <div className="k">Total a cobrar</div>
                <div className="v">{total === null ? "—" : formatSoles(total)}</div>
              </div>

              {payMode === "pick" ? (
                <>
                  <div className="paygrid">
                    {CHARGEABLE_METHODS.map((method) => (
                      <button
                        key={method}
                        type="button"
                        className="paym"
                        onClick={() => {
                          setSplitPayment(false);
                          updatePayment(payments[0].key, { method });
                          setPayMode("pay");
                        }}
                      >
                        {PAYMENT_METHOD_LABELS[method]}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="linkline"
                    onClick={() => { setSplitPayment(true); setPayMode("pay"); }}
                  >
                    Dividir pago entre varios medios
                  </button>
                </>
              ) : (
                <>
                  {/* Lo elegido se confirma en verde y con su importe: quien
                      cobra tiene que poder verificar de un vistazo que va a
                      cobrar lo que cree, por donde cree. */}
                  <div className="chosen">
                    <span className="ck" aria-hidden="true">✓</span>
                    <span className="cm">
                      {splitPayment ? "Pago dividido" : PAYMENT_METHOD_LABELS[payments[0].method]}
                    </span>
                    <span className="ca">{total === null ? "—" : formatSoles(total)}</span>
                  </div>

          {/* La entrega va DESPUÉS del medio de pago y su código. Lo que
              bloquea el cobro tiene que estar pegado a lo que lo desbloquea;
              la entrega es una excepción que casi nunca se toca —arranca en
              «Entrega en tienda»— y no debe interponerse. */}
          <div className="order-fulfillment order-fulfillment--after">
            {FULFILLMENTS.map((method) => (
              <button
                key={method}
                type="button"
                className={fulfillmentMethod === method ? "order-fulfillment-pick order-fulfillment-pick--on" : "order-fulfillment-pick"}
                onClick={() => setFulfillmentMethod(method)}
              >
                {FULFILLMENT_LABELS[method]}
              </button>
            ))}
          </div>
          {/* Datos de entrega. No aparece en mostrador —donde se le da la bolsa
              a quien está delante— ni pide un solo campo que el método no
              necesite: qué pide cada uno lo dice la base, no esta pantalla. */}
          {needsParty && requirement ? (
            <div className="entrega">
              <div className="entrega-quien">
                <span className="entrega-k">
                  {partyRole === "pickup_authorized" ? "Recoge" : "Recibe"}
                </span>
                {buyerKnown ? (
                  <div className="entrega-opts" role="group" aria-label="Quién recibe el pedido">
                    <button
                      type="button"
                      className={effectiveMode === "buyer" ? "entrega-opt entrega-opt--on" : "entrega-opt"}
                      aria-pressed={effectiveMode === "buyer"}
                      onClick={() => setRecipientMode("buyer")}
                    >
                      La clienta
                    </button>
                    <button
                      type="button"
                      className={effectiveMode === "other" ? "entrega-opt entrega-opt--on" : "entrega-opt"}
                      aria-pressed={effectiveMode === "other"}
                      onClick={() => setRecipientMode("other")}
                    >
                      Otra persona
                    </button>
                  </div>
                ) : (
                  <span className="entrega-nota">Se piden solo los datos de esta entrega.</span>
                )}
              </div>

              {effectiveMode === "buyer" ? (
                <>
                  {/* Su nombre no se vuelve a pedir ni se copia: ya se sabe. */}
                  <div className="entrega-clienta">
                    {person?.fullName ?? customerName.trim()}
                  </div>
                  {requirement.requiresPhone ? (
                    <label className="sale-field">
                      <span>Teléfono de contacto</span>
                      <input
                        className="input"
                        value={customerPhone}
                        onChange={(event) => setCustomerPhone(event.target.value)}
                        placeholder="Para avisar cuando llegue"
                        inputMode="tel"
                      />
                    </label>
                  ) : null}
                  {requirement.requiresDocument ? (
                    <label className="sale-field">
                      <span>Documento</span>
                      <input
                        className="input"
                        value={customerDocument}
                        onChange={(event) => setCustomerDocument(event.target.value)}
                        placeholder="La agencia lo pide para entregar"
                      />
                    </label>
                  ) : null}
                </>
              ) : (
                <>
                  {/* Datos de ESTA entrega. No completan ni modifican la ficha
                      de la clienta: quien recibe es otra persona. */}
                  <label className="sale-field">
                    <span>{partyRole === "pickup_authorized" ? "Quién lo recoge" : "Quién lo recibe"}</span>
                    <input
                      className="input"
                      value={recipientName}
                      onChange={(event) => setRecipientName(event.target.value)}
                      placeholder="Nombre y apellido"
                    />
                  </label>
                  {requirement.requiresPhone ? (
                    <label className="sale-field">
                      <span>Su teléfono</span>
                      <input
                        className="input"
                        value={recipientPhone}
                        onChange={(event) => setRecipientPhone(event.target.value)}
                        placeholder="Para avisar cuando llegue"
                        inputMode="tel"
                      />
                    </label>
                  ) : null}
                  {requirement.requiresDocument ? (
                    <label className="sale-field">
                      <span>Su documento</span>
                      <input
                        className="input"
                        value={recipientDocument}
                        onChange={(event) => setRecipientDocument(event.target.value)}
                        placeholder="La agencia lo pide para entregar"
                      />
                    </label>
                  ) : null}
                </>
              )}

              {requirement.requiresAddress ? (
                <label className="sale-field">
                  <span>Dirección de entrega</span>
                  <input
                    className="input"
                    value={deliveryAddress}
                    onChange={(event) => setDeliveryAddress(event.target.value)}
                    placeholder="Calle, número y distrito"
                  />
                </label>
              ) : null}

              {/* Se dice qué falta mientras se puede corregir, no al cobrar. */}
              {deliveryMessage ? (
                <p className="entrega-falta" role="status">{deliveryMessage}</p>
              ) : null}

              {/* Contra entrega. Vive aquí y no junto a los medios de pago
                  porque es una decisión sobre la ENTREGA: solo existe cuando hay
                  algo que llevar, y desaparece si se cambia a mostrador. */}
              {allowsOnDelivery ? (
                <>
                  <div className="entrega-quien entrega-quien--pago">
                    <span className="entrega-k">Cobro</span>
                    <div className="entrega-opts" role="group" aria-label="Cuándo se cobra">
                      <button
                        type="button"
                        className={chargingOnDelivery ? "entrega-opt" : "entrega-opt entrega-opt--on"}
                        aria-pressed={!chargingOnDelivery}
                        onClick={() => setOnDelivery(false)}
                      >
                        Todo ahora
                      </button>
                      <button
                        type="button"
                        className={chargingOnDelivery ? "entrega-opt entrega-opt--on" : "entrega-opt"}
                        aria-pressed={chargingOnDelivery}
                        onClick={() => setOnDelivery(true)}
                      >
                        Adelanto y saldo al entregar
                      </button>
                    </div>
                  </div>
                  {chargingOnDelivery ? (
                    <div className="entrega-saldo">
                      <span>Total {total === null ? "—" : formatSoles(total)}</span>
                      <span>Adelanto {formatSoles(paid)}</span>
                      <b>Queda {pendingBalance === null ? "—" : formatSoles(pendingBalance)}</b>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {singleMethod ? (
            // Un solo medio: se asigna el 100% del total. Elegir el medio NO
            // confirma nada — siempre queda el último clic consciente abajo.
            <div className="sale-payments">
              <div className="sale-payment sale-payment--single">
                {/* La botonera de medios NO se repite aquí: ya la eligió en la
                    pantalla anterior, la fila verde lo confirma y «Cambiar
                    medio» permite volver. Repetirla dejaba el medio nombrado
                    tres veces y el N.º de operación perdido entre medias. */}
                {/* Contra entrega el importe se pregunta, porque es el adelanto
                    y la pantalla no lo conoce. En una venta normal no aparece:
                    ahí el importe es el total y preguntarlo era pedirle a quien
                    vende que teclee un número que ya está en la pantalla. */}
                {chargingOnDelivery ? (
                  <label className="sale-field">
                    <span>Adelanto que se cobra ahora</span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={payments[0].amount}
                      onChange={(event) => assignAmount(payments[0].key, event.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                ) : null}
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
                  // Sin el código no se puede rastrear el movimiento cuando la
                  // caja no cuadra: queda la palabra de quien cobró contra el
                  // extracto del banco. La base lo exige (0057, unificada en
                  // 0065); aquí solo se pide antes, para no fallar al confirmar.
                  <OperationNumberField
                    method={payments[0].method}
                    value={payments[0].reference}
                    onChange={(value) => updatePayment(payments[0].key, { reference: value })}
                    autoFocus
                  />
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
                    // El MISMO campo que en pago único. Antes aquí decía
                    // «Referencia» —opcional— para un dato que la base exige.
                    <OperationNumberField
                      method={payment.method}
                      value={payment.reference}
                      onChange={(value) => updatePayment(payment.key, { reference: value })}
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
              // Con un solo medio esta línea repetía lo que ya dice la fila
              // verde de arriba. Solo se conserva el caso sin total, que sí es
              // información nueva.
              total === null ? <span className="sale-balance--warn">Sin total</span> : null
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
                  {/* El botón NUNCA se apaga en silencio: dice qué falta, como
                      hace el prototipo con el efectivo («Faltan S/ 3.50»). Un
                      botón gris sin motivo obliga a buscar el problema por la
                      pantalla; este lo nombra. */}
                  <button
                    type="button"
                    className="btn-save btn-full pay-confirm"
                    disabled={!canRegister}
                    onClick={registerSale}
                  >
                    {saving ? <span className="spinner" /> : null}
                    {saving
                      ? "Registrando…"
                      : missingReferenceFor
                        // Con un solo medio la fila verde ya lo nombra; con el
                        // pago dividido hay que decir de cuál falta.
                        ? singleMethod
                          ? "Falta el N.º de operación"
                          : `Falta el N.º de operación de ${PAYMENT_METHOD_LABELS[missingReferenceFor.method]}`
                        : chargingOnDelivery
                          // Contra entrega no falta nada por cobrar hoy: lo que
                          // no se cobra ahora se cobra al entregar, y el botón
                          // dice exactamente lo que va a cobrar.
                          ? `Cobrar adelanto ${formatSoles(paid)}`
                          : missing !== null && missing > 0
                            ? `Faltan ${formatSoles(missing)}`
                            : `Confirmar cobro ${total === null ? "" : formatSoles(total)}`}
                  </button>
                  {/* Volver atrás sin perder la venta: equivocarse de medio no
                      puede costar rehacer el cobro. */}
                  <div className="payalt">
                    <button type="button" className="linkbtn2" onClick={() => setPayMode("pick")}>
                      Cambiar medio
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Asociar clienta: el formulario ES lo primero.
       *
       * Las clientas de mostrador no son frecuentes, así que lo normal al abrir
       * esto es REGISTRAR a alguien nueva, no buscar entre las que ya están.
       * Un buscador permanente delante obligaba a teclear un nombre que casi
       * nunca iba a encontrar, y respondía «escribe al menos dos letras» a un
       * registro que a veces está vacío.
       *
       * La búsqueda no desaparece: pasa a ser automática. Mientras se escribe
       * el nombre o el celular, si algo coincide la propia pantalla lo avisa
       * —«puede que ya esté registrada»— y se asocia de un toque. Orientar en
       * vez de preguntar. */}
      {clientOpen ? (
        <div
          className="tone-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Agregar clienta"
          onClick={(event) => { if (event.target === event.currentTarget) setClientOpen(false); }}
        >
          <div className="tone-sheet tone-sheet--pending">
            <div className="tone-head">
              <div className="tone-head-main">
                <div className="tone-title">Agregar clienta</div>
                <div className="tone-sub">La venta puede cobrarse sin identificar a la clienta.</div>
              </div>
              <button type="button" className="tone-close" onClick={() => setClientOpen(false)} aria-label="Cerrar">×</button>
            </div>
            <div className="tone-pending-body">
              <label className="sale-field">
                <span>Nombre</span>
                <input
                  className="input"
                  value={newClientName}
                  onChange={(event) => setNewClientName(event.target.value)}
                  placeholder="Nombre de la clienta"
                  autoFocus
                />
              </label>
              <label className="sale-field">
                <span>Celular <i>· para enviarle su nota y unir su WhatsApp</i></span>
                <input
                  className="input"
                  value={newClientPhone}
                  // Solo dígitos y como máximo 9: el +51 lo antepone la base al
                  // normalizar y la vendedora no tiene por qué saberlo. Filtrar
                  // al teclear evita el error en vez de reprocharlo después.
                  onChange={(event) => setNewClientPhone(event.target.value.replace(/\D/g, "").slice(0, 9))}
                  placeholder="999 999 999"
                  inputMode="numeric"
                  maxLength={9}
                />
              </label>
              <label className="sale-field">
                <span>DNI o RUC <i>· si va a pedir boleta o factura</i></span>
                <input
                  className="input"
                  value={newClientDocument}
                  // DNI son 8 dígitos y RUC 11: 11 es el tope real y no hay
                  // documento con letras en este negocio.
                  onChange={(event) => setNewClientDocument(event.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="DNI (8) o RUC (11)"
                  inputMode="numeric"
                  maxLength={11}
                />
              </label>

              {/* El aviso solo aparece cuando hay algo que avisar. Sin
                  coincidencias no ocupa sitio ni regaña. */}
              {clientResults.length > 0 ? (
                <div className="client-maybe">
                  <p className="client-maybe-title">
                    {clientSearching ? "Buscando…" : "¿Es alguna de estas clientas?"}
                  </p>
                  {/* Decir POR QUÉ importa, no solo que hay coincidencias: quien
                      vende no sabe qué se rompe al registrar dos veces. */}
                  <p className="client-maybe-why">
                    Si la registras otra vez, sus compras quedan partidas en dos fichas.
                  </p>
                  {clientResults.map((match) => (
                    <button key={match.id} type="button" className="client-maybe-hit" onClick={() => pickPerson(match)}>
                      <span className="clientrow-mark" aria-hidden="true">{initialsOf(match.fullName)}</span>
                      <span className="client-maybe-data">
                        <b>{match.fullName}</b>
                        {/* Cada dato dice qué es. «Rosa Prueba 999111222» no
                            identifica: podría ser teléfono, documento o pedido. */}
                        <small>
                          {[
                            match.phone ? `WhatsApp ${phoneLabel(match.phone)}` : null,
                            match.document ? documentLabel(match.document) : null
                          ].filter(Boolean).join(" · ") || "Sin datos de contacto"}
                        </small>
                      </span>
                      <span className="client-maybe-use">Seleccionar</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="newclient-actions">
                <button type="button" className="btn-soft" onClick={() => setClientOpen(false)}>Cancelar</button>
                <button
                  type="button"
                  className="btn-save"
                  disabled={creatingPerson || newClientName.trim().length < 2}
                  onClick={createPerson}
                >
                  {creatingPerson ? "Registrando…" : "Registrar y asociar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Reservas y carritos pendientes: una ventana que se abre de un clic,
          no un panel permanente. Al cargar una se traen sus productos, su
          clienta y el origen con el que llegó. */}
      {pendingOpen ? (
        <div
          className="tone-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Pendientes"
          onClick={(event) => { if (event.target === event.currentTarget) setPendingOpen(false); }}
        >
          <div className="tone-sheet tone-sheet--pending">
            <div className="tone-head">
              <div className="tone-head-main">
                <div className="tone-title">Pendientes</div>
                <div className="tone-sub">Lo que queda por entregar, por cobrar y las reservas vivas.</div>
              </div>
              <button type="button" className="tone-close" onClick={() => setPendingOpen(false)} aria-label="Cerrar">×</button>
            </div>

            {/* Los filtros no parten la hoja en cuatro pantallas: recortan la
                misma lista. Al abrirla se ve todo, que es lo que se quiere
                cuando la pregunta es «¿qué me falta?». */}
            <div className="pend-chips" role="group" aria-label="Filtrar pendientes">
              {PENDING_FILTERS.map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  className={pendingFilter === chip.value ? "pend-chip pend-chip--on" : "pend-chip"}
                  aria-pressed={pendingFilter === chip.value}
                  onClick={() => setPendingFilter(chip.value)}
                >
                  {chip.label}
                  <i>{
                    chip.value === "reservations" ? pending.reservations.length
                      : chip.value === "delivery" ? pending.sales.filter((s) => s.needsDelivery).length
                      : chip.value === "payment" ? pending.sales.filter((s) => s.needsPayment).length
                      : pending.sales.length + pending.reservations.length
                  }</i>
                </button>
              ))}
            </div>

            <div className="tone-pending-body">
              {loadingReservations ? (
                <div className="order-loading"><span className="spinner spinner--pink" /> Cargando pendientes…</div>
              ) : visiblePending.length === 0 ? (
                <div className="order-empty">
                  {pendingFilter === "all" ? "No queda nada pendiente." : "Nada en este filtro."}
                </div>
              ) : (
                <div className="pend-list">
                  {visiblePending.map((item) => item.kind === "reservation" ? (
                    <div key={item.id} className="pend-row">
                      <div className="pend-main">
                        <b>{item.customerName ?? "Sin identificar"}</b>
                        <span className="pend-meta">
                          Reserva {item.number} · vence {saleDate(item.expiresAt)}
                        </span>
                      </div>
                      <div className="pend-money">
                        <span className="pend-total">{formatSoles(item.total)}</span>
                        {item.paidTotal > 0 ? <small>Adelanto {formatSoles(item.paidTotal)}</small> : null}
                      </div>
                      <div className="pend-actions">
                        <button type="button" className="btn-save" disabled={busyReservationId === item.id}
                          onClick={() => convertReservation({ id: item.id, reservationNumber: item.number })}>
                          Cargar en venta
                        </button>
                        <button type="button" className="btn-soft" disabled={busyReservationId === item.id}
                          onClick={() => releaseReservation({ id: item.id, reservationNumber: item.number })}>
                          Liberar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={item.id} className="pend-row">
                      <div className="pend-main">
                        <b>{item.customerName ?? "Sin identificar"}</b>
                        <span className="pend-meta">
                          {FULFILLMENT_LABELS[item.fulfillmentMethod]} ·{" "}
                          {FULFILLMENT_STATUS_LABELS[item.fulfillmentStatus]}
                          {item.number ? ` · ${item.number}` : ""}
                        </span>
                      </div>
                      <div className="pend-money">
                        <span className="pend-total">{formatSoles(item.total)}</span>
                        {/* El saldo se dice solo cuando lo hay: repetir «S/ 0.00»
                            en cada fila entregada es ruido. */}
                        {item.needsPayment ? <small className="pend-debe">Debe {formatSoles(item.balance)}</small> : null}
                      </div>
                      <div className="pend-actions">
                        {/* Cada fila ofrece su siguiente paso, no un menú: el
                            sistema sabe qué toca. Una fila puede ofrecer los
                            dos, porque entregar y cobrar son independientes. */}
                        {item.needsDelivery ? (() => {
                          const step = nextFulfillmentStep(item.fulfillmentStatus, item.fulfillmentMethod);
                          return step ? (
                            <button type="button" className="btn-soft" disabled={busySaleId === item.id}
                              onClick={() => advanceFulfillment(item)}>
                              {step.label}
                            </button>
                          ) : null;
                        })() : null}
                        {/* «No se pudo entregar» solo aparece cuando el pedido
                            ya salió o está listo: marcarlo fallido antes de que
                            nadie lo intentara no describe nada. */}
                        {item.needsDelivery && canFailDelivery(item.fulfillmentStatus) ? (
                          <button type="button" className="btn-ghost" disabled={busySaleId === item.id}
                            onClick={() => failFulfillment(item)}>
                            No se pudo entregar
                          </button>
                        ) : null}
                        {item.needsPayment ? (
                          <button type="button" className="btn-save" disabled={busySaleId === item.id}
                            onClick={() => { setSettleFor(item); setSettleMethod(null); setSettleReference(""); }}>
                            Cobrar {formatSoles(item.balance)}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="field-hint">Una reserva compromete existencias sin descontarlas; un pedido despachado ya las descontó.</p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Cobrar el saldo. Reutiliza la misma botonera de medios que el cobro de
          la venta —no hay dos maneras de elegir cómo pagó— y el importe viene
          hecho: el saldo se cobra entero al entregar. */}
      {settleFor ? (
        <div
          className="tone-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Cobrar el saldo de ${settleFor.number}`}
          onClick={(event) => { if (event.target === event.currentTarget) setSettleFor(null); }}
        >
          <div className="sheet">
            <div className="shead">
              <h2>Cobrar saldo</h2>
              <button type="button" className="xbtn" onClick={() => setSettleFor(null)} aria-label="Volver">×</button>
            </div>
            <div className="sbody">
              <div className="amtbig">
                <div className="k">Saldo pendiente · {settleFor.customerName ?? settleFor.number}</div>
                <div className="v">{formatSoles(settleFor.balance)}</div>
              </div>

              {settleMethod === null ? (
                <div className="paygrid">
                  {CHARGEABLE_METHODS.map((method) => (
                    <button key={method} type="button" className="paym" onClick={() => setSettleMethod(method)}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="chosen">
                    <span className="ck" aria-hidden="true">✓</span>
                    <span className="cm">{PAYMENT_METHOD_LABELS[settleMethod]}</span>
                    <span className="ca">{formatSoles(settleFor.balance)}</span>
                  </div>

                  {/* Y el mismo campo también aquí: cobrar el saldo no es una
                      forma distinta de cobrar. */}
                  <OperationNumberField
                    method={settleMethod}
                    value={settleReference}
                    onChange={setSettleReference}
                    autoFocus
                  />

                  {/* El importe no se pregunta: el saldo se cobra entero al
                      entregar y la pantalla ya lo sabe. */}

                  <button
                    type="button"
                    className="btn-save btn-full pay-confirm"
                    disabled={busySaleId === settleFor.id}
                    onClick={settleBalance}
                  >
                    {busySaleId === settleFor.id ? <span className="spinner" /> : null}
                    {busySaleId === settleFor.id
                      ? "Cobrando…"
                      : requiresOperationNumber(settleMethod) && settleReference.trim() === ""
                        ? "Falta el N.º de operación"
                        : `Cobrar ${formatSoles(settleFor.balance)}`}
                  </button>
                  <button type="button" className="linkline" onClick={() => setSettleMethod(null)}>
                    Cambiar medio
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}


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
            {/* El comprobante se pide AQUÍ porque este es el momento en que la
                clienta está delante y lo dice. No condiciona nada: la venta ya
                está registrada, con comprobante o sin él. */}
            {justSold.taxDocument ? (
              <div className="sale-done-detail">
                {TAX_DOCUMENT_LABELS[justSold.taxDocument.kind]}
              </div>
            ) : null}
            <div className="sale-done-actions">
              <a className="btn-save" href={`/admin/ventas/${justSold.id}/nota`} target="_blank" rel="noopener">
                Nota de venta
              </a>
              <button type="button" className="btn-soft" onClick={() => setTaxFor(justSold)}>
                {justSold.taxDocument ? "Cambiar documento" : "Documento"}
              </button>
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

      {/* El MISMO componente que usa la nota de venta: pedir un comprobante no
          se hace de dos maneras distintas según desde dónde se entre. */}
      {taxFor ? (
        <TaxDocumentSheet
          sale={taxFor}
          onClose={() => setTaxFor(null)}
          onDone={(actualizada) => {
            setTaxFor(null);
            // Si es la venta que está en la pantalla de cierre, se refresca ahí
            // para que confirme lo que acaba de pedirse.
            setJustSold((current) => current?.id === actualizada.id ? actualizada : current);
          }}
        />
      ) : null}

      {openTones && branchId ? (
        <ToneSheet
          branchId={branchId}
          productId={openTones}
          counts={counts}
          onPick={addTone}
          onUnpick={removeTone}
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
