"use client";

import type {
  CartEvaluation,
  CatalogListResponse,
  CatalogProductDetail,
  PurchasableVariant
} from "@/lib/catalog/contracts";

export type PublicTaxonomy = {
  brands: { id: string; name: string; slug: string; sort_order: number }[];
  categories: {
    id: string;
    parent_id: string | null;
    template_id: string | null;
    name: string;
    slug: string;
    path: string;
    depth: number;
    sort_order: number;
  }[];
  contact: {
    business_name: string;
    whatsapp_number: string;
    stock_notice: string;
  } | null;
};

type CatalogListParameters = {
  page?: number;
  pageSize?: number;
  search?: string;
  brand?: string;
  category?: string;
  availability?: "available" | "sold_out" | "consult";
  attributes?: Record<string, string[]>;
  sort?: "featured" | "name_asc" | "name_desc" | "price_asc" | "price_desc";
};

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: { message?: string } }
    | null;

  if (!response.ok || body?.data === undefined) {
    throw new Error(body?.error?.message ?? `La solicitud falló (${response.status}).`);
  }

  return body.data;
}

export const publicApi = {
  listProducts: (parameters: CatalogListParameters = {}) => {
    const query = new URLSearchParams();

    if (parameters.page) query.set("page", String(parameters.page));
    if (parameters.pageSize) query.set("page_size", String(parameters.pageSize));
    if (parameters.search) query.set("search", parameters.search);
    if (parameters.brand) query.set("brand", parameters.brand);
    if (parameters.category) query.set("category", parameters.category);
    if (parameters.availability) query.set("availability", parameters.availability);
    if (parameters.attributes) query.set("attributes", JSON.stringify(parameters.attributes));
    if (parameters.sort) query.set("sort", parameters.sort);

    return getJson<CatalogListResponse>(`/api/catalog?${query.toString()}`);
  },
  getProduct: (slug: string) => getJson<CatalogProductDetail>(`/api/catalog/${slug}`),
  taxonomy: () => getJson<PublicTaxonomy>("/api/catalog/taxonomy"),
  evaluateCart: (lines: { variantId: string; quantity: number }[]) =>
    getJson<CartEvaluation>("/api/catalog/cart/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines })
    }),
  whatsapp: (input: {
    lines: { variantId: string; quantity: number }[];
    intent: "order" | "advice";
    deliveryMethod?: "shipping" | "pickup";
    customerNote?: string;
  }) =>
    getJson<{ url: string; text: string; evaluation: CartEvaluation }>("/api/catalog/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
};

export function waNumber(taxonomy: PublicTaxonomy | null) {
  return (taxonomy?.contact?.whatsapp_number ?? "51963463550").replace(/\D/g, "");
}

export function waLink(number: string, message: string) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function formatSoles(value: number | null) {
  if (value === null) return "Consultar";
  const rounded = Math.round(value * 100) / 100;
  return `S/ ${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)}`;
}

export function retailPrice(variant: PurchasableVariant) {
  return variant.prices.find((price) => price.type === "retail")?.amount ?? null;
}

export function variantImage(variant: PurchasableVariant) {
  return variant.media.find((media) => media.isPrimary)?.path ?? variant.media[0]?.path ?? null;
}
