"use client";

import type { ApiProduct } from "@/lib/admin/types";

export type PublicTaxonomy = {
  brands: { id: string; name: string; slug: string; sort_order: number }[];
  categories: { id: string; name: string; slug: string; sort_order: number }[];
  contact: {
    business_name: string;
    whatsapp_number: string;
    stock_notice: string;
  } | null;
};

export type ToneMode = "surtidos" | "set" | "codigos" | "confirmar";

export type SelectionItem = {
  productId: string;
  slug: string;
  brand: string;
  name: string;
  presentation: string;
  unitPrice: number;
  wholesalePrice: number;
  wholesaleMin: number;
  imagePath: string | null;
  qty: number;
  mode: ToneMode;
  codes: string;
};

export const MODE_LABEL: Record<ToneMode, string> = {
  surtidos: "Tonos surtidos",
  set: "Set completo",
  codigos: "Códigos de la carta",
  confirmar: "Tonos por confirmar con asesor"
};

const FALLBACK_WHATSAPP = "51963463550";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: { message?: string } }
    | null;

  if (!response.ok || !body?.data) {
    throw new Error(body?.error?.message ?? `La solicitud falló (${response.status}).`);
  }

  return body.data;
}

export const publicApi = {
  listProducts: () =>
    getJson<{ items: ApiProduct[] }>("/api/catalog?limit=100").then((r) => r.items),
  getProduct: (slug: string) => getJson<ApiProduct>(`/api/catalog/${slug}`),
  taxonomy: () => getJson<PublicTaxonomy>("/api/catalog/taxonomy")
};

export function waNumber(taxonomy: PublicTaxonomy | null) {
  const raw = taxonomy?.contact?.whatsapp_number ?? FALLBACK_WHATSAPP;
  return raw.replace(/\D/g, "");
}

export function waLink(number: string, message: string) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function formatSoles(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return `S/ ${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)}`;
}

export function appliedPrice(item: Pick<SelectionItem, "unitPrice" | "wholesalePrice" | "wholesaleMin">, qty: number) {
  return qty >= item.wholesaleMin ? item.wholesalePrice : item.unitPrice;
}

export function lampShort(product: ApiProduct) {
  const lamp = product.lamp_type ?? (product.requires_lamp ? "Sí" : "No");

  if (lamp === "No") {
    return "Sin lámpara";
  }

  return lamp === "UV/LED" ? "Lámpara UV/LED" : "Requiere lámpara";
}

export function lampText(product: ApiProduct) {
  const lamp = product.lamp_type ?? (product.requires_lamp ? "Sí" : "No");

  if (lamp === "No") {
    return "No requiere lámpara";
  }

  return lamp === "UV/LED" ? "Requiere lámpara UV/LED" : "Requiere lámpara";
}

export function productCategory(product: ApiProduct) {
  if (product.product_type === "Esmalte tradicional") {
    return "Tradicional";
  }

  if (product.product_type === "Efecto gel sin lámpara") {
    return "Gel sin lámpara";
  }

  return "Semipermanente";
}

export function codesSummary(codes: string) {
  const parts = String(codes || "")
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let units = 0;

  for (const part of parts) {
    const match = part.match(/x\s*(\d+)/i);
    units += match ? Number.parseInt(match[1], 10) : 1;
  }

  return { count: parts.length, units };
}

export function orderLines(items: SelectionItem[]) {
  return items.map((item) => {
    let tail = "tonos por confirmar";

    if (item.mode === "codigos" && item.codes) {
      tail = `códigos: ${item.codes}`;
    } else if (item.mode === "set") {
      tail = "set completo";
    } else if (item.mode === "surtidos") {
      tail = "tonos surtidos";
    }

    return `• ${item.brand} ${item.name} ${item.presentation} ×${item.qty} — ${tail}`;
  });
}

export function orderMessage(
  prefix: string,
  items: SelectionItem[],
  delivery: "envio" | "recojo",
  district: string
) {
  const units = items.reduce((acc, item) => acc + item.qty, 0);
  const total = items.reduce((acc, item) => acc + item.qty * appliedPrice(item, item.qty), 0);
  const entrega =
    delivery === "envio" ? `envío${district ? ` a ${district}` : ""}` : "recojo en tienda";

  return [prefix]
    .concat(orderLines(items))
    .concat([`Entrega: ${entrega}`, `Total: ${units} unidades · Referencial: ${formatSoles(total)}`])
    .join("\n");
}
