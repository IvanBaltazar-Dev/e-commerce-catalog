"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { EvaluatedCartLine } from "@/lib/catalog/contracts";

const STORAGE_KEY = "bellaroshe_seleccion";
const STORAGE_VERSION = 2;

type ServerCartDetail = {
  publicToken: string;
  status: string;
  evaluation: { lines: EvaluatedCartLine[] };
};

/**
 * Adopta un carrito compartido: el POST fija la cookie del token, el estado
 * local se reescribe con las líneas REEVALUADAS por el servidor y la
 * navegación completa arranca /seleccion desde esa verdad.
 */
export function CartRecoveryView({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const recover = async () => {
      try {
        const response = await fetch("/api/catalog/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicToken: token })
        });

        if (!response.ok) {
          setError("El enlace ya no es válido o la selección venció.");
          return;
        }

        const body = (await response.json()) as { data: ServerCartDetail };
        const lines = body.data.evaluation?.lines ?? [];

        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: STORAGE_VERSION,
            items: lines.map((line) => ({
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
            })),
            delivery: "envio",
            district: ""
          })
        );

        window.location.replace("/seleccion");
      } catch {
        setError("No pudimos recuperar la selección. Inténtalo de nuevo.");
      }
    };

    void recover();
  }, [token]);

  return (
    <div className="pub-recovery">
      {error ? (
        <>
          <p>{error}</p>
          <Link href="/seleccion" className="pub-recovery-link">Ir a mi selección →</Link>
        </>
      ) : (
        <p>Recuperando tu selección…</p>
      )}
    </div>
  );
}
