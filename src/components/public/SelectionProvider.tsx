"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CartLine } from "@/lib/catalog/contracts";

const STORAGE_KEY = "bellaroshe_seleccion";
const STORAGE_VERSION = 2;

type Delivery = "envio" | "recojo";

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
};

const SelectionContext = createContext<SelectionState | null>(null);

export function useSelection() {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useSelection debe usarse dentro de SelectionProvider.");
  return value;
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([]);
  const [delivery, setDeliveryState] = useState<Delivery>("envio");
  const [district, setDistrictState] = useState("");
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
        version?: number;
        items?: CartLine[];
        delivery?: Delivery;
        district?: string;
      } | null;

      if (saved?.version === STORAGE_VERSION && Array.isArray(saved.items)) {
        setItems(
          saved.items.filter(
            (item) => item?.variantId && item?.productId && item.quantity > 0 && item.sku
          )
        );
      }

      if (saved?.delivery === "envio" || saved?.delivery === "recojo") {
        setDeliveryState(saved.delivery);
      }

      if (typeof saved?.district === "string") setDistrictState(saved.district);
    } catch {
      // Estado V1 o corrupto: no puede migrarse sin variantId y se ignora de forma segura.
    }
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

  const showToast = useCallback((message: string) => {
    clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => setToast(""), 2600);
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
        return next;
      });
    },
    [persist]
  );

  const updateQty = useCallback(
    (index: number, delta: number) => {
      setItems((current) => {
        const next = [...current];
        const quantity = next[index].quantity + delta;

        if (quantity <= 0) next.splice(index, 1);
        else next[index] = { ...next[index], quantity };

        persist({ items: next });
        return next;
      });
    },
    [persist]
  );

  const removeItem = useCallback(
    (index: number) => {
      setItems((current) => {
        const next = current.filter((_, itemIndex) => itemIndex !== index);
        persist({ items: next });
        return next;
      });
    },
    [persist]
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
    showToast
  }), [items, delivery, district, addItem, updateQty, removeItem, setDelivery, setDistrict, toast, showToast]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
      {toast ? <div className="toast toast--public">{toast}</div> : null}
    </SelectionContext.Provider>
  );
}
