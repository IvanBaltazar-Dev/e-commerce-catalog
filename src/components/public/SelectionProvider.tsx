"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SelectionItem } from "@/lib/public/catalog";

const STORAGE_KEY = "bellaroshe_seleccion";

type Delivery = "envio" | "recojo";

type SelectionState = {
  items: SelectionItem[];
  delivery: Delivery;
  district: string;
  units: number;
  addItem: (item: SelectionItem) => void;
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

  if (!value) {
    throw new Error("useSelection debe usarse dentro de SelectionProvider.");
  }

  return value;
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<SelectionItem[]>([]);
  const [delivery, setDeliveryState] = useState<Delivery>("envio");
  const [district, setDistrictState] = useState("");
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
        items?: SelectionItem[];
        delivery?: Delivery;
        district?: string;
      } | null;

      if (saved?.items && Array.isArray(saved.items)) {
        setItems(saved.items.filter((item) => item && item.productId && item.qty > 0));
      }

      if (saved?.delivery === "envio" || saved?.delivery === "recojo") {
        setDeliveryState(saved.delivery);
      }

      if (typeof saved?.district === "string") {
        setDistrictState(saved.district);
      }
    } catch {
      // Selección corrupta: se ignora.
    }
  }, []);

  const persist = useCallback(
    (next: { items?: SelectionItem[]; delivery?: Delivery; district?: string }) => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            items: next.items ?? items,
            delivery: next.delivery ?? delivery,
            district: next.district ?? district
          })
        );
      } catch {
        // Sin almacenamiento disponible.
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
    (item: SelectionItem) => {
      setItems((current) => {
        const index = current.findIndex(
          (existing) => existing.productId === item.productId && existing.mode === item.mode
        );
        let next: SelectionItem[];

        if (index >= 0) {
          const merged = { ...current[index] };
          merged.qty += item.qty;

          if (item.codes) {
            merged.codes = [merged.codes, item.codes].filter(Boolean).join(", ");
          }

          next = current.map((existing, i) => (i === index ? merged : existing));
        } else {
          next = [...current, item];
        }

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
        const qty = next[index].qty + delta;

        if (qty <= 0) {
          next.splice(index, 1);
        } else {
          next[index] = { ...next[index], qty };
        }

        persist({ items: next });
        return next;
      });
    },
    [persist]
  );

  const removeItem = useCallback(
    (index: number) => {
      setItems((current) => {
        const next = current.filter((_, i) => i !== index);
        persist({ items: next });
        return next;
      });
    },
    [persist]
  );

  const setDelivery = useCallback(
    (next: Delivery) => {
      setDeliveryState(next);
      persist({ delivery: next });
    },
    [persist]
  );

  const setDistrict = useCallback(
    (next: string) => {
      setDistrictState(next);
      persist({ district: next });
    },
    [persist]
  );

  const value = useMemo<SelectionState>(
    () => ({
      items,
      delivery,
      district,
      units: items.reduce((acc, item) => acc + item.qty, 0),
      addItem,
      updateQty,
      removeItem,
      setDelivery,
      setDistrict,
      toast,
      showToast
    }),
    [items, delivery, district, addItem, updateQty, removeItem, setDelivery, setDistrict, toast, showToast]
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
      {toast ? <div className="toast toast--public">{toast}</div> : null}
    </SelectionContext.Provider>
  );
}
