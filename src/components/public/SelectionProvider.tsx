"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CartLine, EvaluatedCartLine } from "@/lib/catalog/contracts";

const STORAGE_KEY = "bellaroshe_seleccion";
const STORAGE_VERSION = 2;
const SESSION_FLAG = "bellaroshe_session_touched";

type Delivery = "envio" | "recojo";

type ServerCartDetail = {
  id: string;
  publicToken: string;
  status: string;
  rowVersion: number;
  evaluation: { lines: EvaluatedCartLine[]; totalUnits: number };
};

type SelectionState = {
  items: CartLine[];
  delivery: Delivery;
  district: string;
  units: number;
  addItem: (item: CartLine) => void;
  updateQty: (index: number, delta: number) => void;
  removeItem: (index: number) => void;
  setDelivery: (delivery: Delivery) => void;
  setDistrict: (district: string) => void;
  toast: string;
  showToast: (message: string) => void;
  /** Enlace compartible de la selección persistida; nulo hasta sincronizar. */
  shareUrl: string | null;
};

const SelectionContext = createContext<SelectionState | null>(null);

export function useSelection() {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useSelection debe usarse dentro de SelectionProvider.");
  return value;
}

function toCartLine(line: EvaluatedCartLine): CartLine {
  return {
    productId: line.productId,
    variantId: line.variantId,
    sku: line.sku,
    productName: line.productName,
    variantName: line.variantName,
    slug: line.slug,
    imagePath: line.imagePath,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    purchaseMode: line.purchaseMode,
    availability: line.availability
  };
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([]);
  const [delivery, setDeliveryState] = useState<Delivery>("envio");
  const [district, setDistrictState] = useState("");
  const [toast, setToast] = useState("");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Versión del carrito en el servidor: toda mutación la declara, y el 409 se
  // resuelve refrescando — nunca pisando lo que otro dispositivo escribió.
  const serverVersion = useRef<number | null>(null);
  const syncing = useRef(false);

  const showToast = useCallback((message: string) => {
    clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  const persist = useCallback(
    (next: { items?: CartLine[]; delivery?: Delivery; district?: string }) => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: STORAGE_VERSION,
            items: next.items ?? items,
            delivery: next.delivery ?? delivery,
            district: next.district ?? district
          })
        );
      } catch {
        // El carrito sigue operativo durante la sesión si storage no está disponible.
      }
    },
    [items, delivery, district]
  );

  const adoptServerCart = useCallback((detail: ServerCartDetail | null) => {
    if (!detail) return;
    serverVersion.current = detail.rowVersion;
    setShareToken(detail.publicToken);

    const serverLines = (detail.evaluation?.lines ?? []).map(toCartLine);
    if (serverLines.length > 0) {
      setItems(serverLines);
      persist({ items: serverLines });
    }
  }, [persist]);

  const refreshFromServer = useCallback(async () => {
    try {
      const response = await fetch("/api/catalog/cart", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { data: ServerCartDetail | null };
      adoptServerCart(body.data);
    } catch {
      // Sin red, el estado local sigue mandando hasta la próxima.
    }
  }, [adoptServerCart]);

  /** Empuja la cantidad ABSOLUTA de una variante; el conflicto refresca. */
  const pushItem = useCallback(async (variantId: string, quantity: number) => {
    try {
      const response = await fetch("/api/catalog/cart/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variantId,
          quantity,
          expectedVersion: serverVersion.current
        })
      });

      if (response.status === 409) {
        await refreshFromServer();
        showToast("Tu selección cambió en otro dispositivo: la actualizamos.");
        return;
      }

      if (!response.ok) return;

      const body = (await response.json()) as { data: ServerCartDetail };
      serverVersion.current = body.data.rowVersion;
      setShareToken(body.data.publicToken);
    } catch {
      // Sin red: el localStorage conserva el cambio y la próxima sincronización
      // lo reconcilia con la regla determinista del servidor.
    }
  }, [refreshFromServer, showToast]);

  useEffect(() => {
    let localItems: CartLine[] = [];

    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
        version?: number;
        items?: CartLine[];
        delivery?: Delivery;
        district?: string;
      } | null;

      if (saved?.version === STORAGE_VERSION && Array.isArray(saved.items)) {
        localItems = saved.items.filter(
          (item) => item?.variantId && item?.productId && item.quantity > 0 && item.sku
        );
        setItems(localItems);
      }

      if (saved?.delivery === "envio" || saved?.delivery === "recojo") {
        setDeliveryState(saved.delivery);
      }

      if (typeof saved?.district === "string") setDistrictState(saved.district);
    } catch {
      // Estado V1 o corrupto: no puede migrarse sin variantId y se ignora de forma segura.
    }

    // Identidad y atribución: una vez por sesión de navegador, con los UTM y el
    // referrer de la PRIMERA página. El first-touch lo congela la base.
    const boot = async () => {
      if (syncing.current) return;
      syncing.current = true;

      try {
        if (!window.sessionStorage.getItem(SESSION_FLAG)) {
          const url = new URL(window.location.href);
          await fetch("/api/catalog/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              landingPath: url.pathname,
              referrer: document.referrer || null,
              source: url.searchParams.get("source"),
              campaign: url.searchParams.get("campaign"),
              utm: {
                source: url.searchParams.get("utm_source"),
                medium: url.searchParams.get("utm_medium"),
                campaign: url.searchParams.get("utm_campaign"),
                content: url.searchParams.get("utm_content"),
                term: url.searchParams.get("utm_term")
              }
            })
          });
          window.sessionStorage.setItem(SESSION_FLAG, "1");
        }

        // Migración silenciosa localStorage → servidor. El servidor pasa a ser
        // la fuente principal; lo local queda como caché de arranque.
        const response = await fetch("/api/catalog/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lines: localItems.map((item) => ({ variantId: item.variantId, quantity: item.quantity }))
          })
        });

        if (response.ok) {
          const body = (await response.json()) as { data: ServerCartDetail };
          adoptServerCart(body.data);
        }
      } catch {
        // Sin servidor la selección local sigue funcionando: nada se pierde.
      } finally {
        syncing.current = false;
      }
    };

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addItem = useCallback(
    (item: CartLine) => {
      setItems((current) => {
        const index = current.findIndex(
          (existing) =>
            existing.variantId === item.variantId && existing.purchaseMode === item.purchaseMode
        );
        const next = index >= 0
          ? current.map((existing, itemIndex) =>
              itemIndex === index
                ? { ...existing, quantity: existing.quantity + item.quantity }
                : existing
            )
          : [...current, item];

        persist({ items: next });

        const total = next
          .filter((line) => line.variantId === item.variantId)
          .reduce((sum, line) => sum + line.quantity, 0);
        void pushItem(item.variantId, total);

        return next;
      });
    },
    [persist, pushItem]
  );

  const updateQty = useCallback(
    (index: number, delta: number) => {
      setItems((current) => {
        const next = [...current];
        const quantity = next[index].quantity + delta;
        const variantId = next[index].variantId;

        if (quantity <= 0) next.splice(index, 1);
        else next[index] = { ...next[index], quantity };

        persist({ items: next });

        const total = next
          .filter((line) => line.variantId === variantId)
          .reduce((sum, line) => sum + line.quantity, 0);
        void pushItem(variantId, total);

        return next;
      });
    },
    [persist, pushItem]
  );

  const removeItem = useCallback(
    (index: number) => {
      setItems((current) => {
        const variantId = current[index]?.variantId;
        const next = current.filter((_, itemIndex) => itemIndex !== index);
        persist({ items: next });

        if (variantId) {
          const total = next
            .filter((line) => line.variantId === variantId)
            .reduce((sum, line) => sum + line.quantity, 0);
          void pushItem(variantId, total);
        }

        return next;
      });
    },
    [persist, pushItem]
  );

  const setDelivery = useCallback((next: Delivery) => {
    setDeliveryState(next);
    persist({ delivery: next });
  }, [persist]);

  const setDistrict = useCallback((next: string) => {
    setDistrictState(next);
    persist({ district: next });
  }, [persist]);

  const value = useMemo<SelectionState>(() => ({
    items,
    delivery,
    district,
    units: items.reduce((total, item) => total + item.quantity, 0),
    addItem,
    updateQty,
    removeItem,
    setDelivery,
    setDistrict,
    toast,
    showToast,
    shareUrl: shareToken && typeof window !== "undefined"
      ? `${window.location.origin}/seleccion/${shareToken}`
      : null
  }), [items, delivery, district, addItem, updateQty, removeItem, setDelivery, setDistrict, toast, showToast, shareToken]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
      {toast ? <div className="toast toast--public">{toast}</div> : null}
    </SelectionContext.Provider>
  );
}
