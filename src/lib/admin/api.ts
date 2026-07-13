"use client";

import { publicEnv } from "@/lib/env/public";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { ApiPdfExport, ApiProduct, ApiTaxonomy, ProductPayload } from "@/lib/admin/types";

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });

  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    // Sin cuerpo JSON (p. ej. 204).
  }

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new AdminApiError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? `La solicitud falló (${response.status}).`
    );
  }

  return (body as { data: T }).data;
}

export const adminApi = {
  listProducts: () =>
    request<{ items: ApiProduct[] }>("/api/admin/products?limit=100").then((r) => r.items),
  getProduct: (id: string) => request<ApiProduct>(`/api/admin/products/${id}`),
  createProduct: (payload: ProductPayload) =>
    request<ApiProduct>("/api/admin/products", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateProduct: (id: string, payload: Partial<ProductPayload>) =>
    request<ApiProduct>(`/api/admin/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  listBrands: () => request<{ items: ApiTaxonomy[] }>("/api/admin/brands").then((r) => r.items),
  createBrand: (name: string) =>
    request<ApiTaxonomy>("/api/admin/brands", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  listCategories: () =>
    request<{ items: ApiTaxonomy[] }>("/api/admin/categories").then((r) => r.items),
  createCategory: (name: string) =>
    request<ApiTaxonomy>("/api/admin/categories", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  pdfStatus: () =>
    request<{ catalogUpdatedAt: string | null; items: ApiPdfExport[] }>("/api/admin/pdf"),
  pdfGenerate: () => request<ApiPdfExport>("/api/admin/pdf/generate", { method: "POST" }),
  pdfDownloadUrl: (id: string) =>
    request<{ downloadUrl: string; expiresInSeconds: number }>(`/api/admin/pdf/${id}/download`),
  createUploadUrl: (kind: "product-image" | "color-chart", fileName: string, contentType: string) =>
    request<{ bucket: string; path: string; signedUrl: string; token: string }>(
      "/api/admin/assets/upload-url",
      {
        method: "POST",
        body: JSON.stringify({ kind, fileName, contentType })
      }
    )
};

export async function uploadCatalogImage(kind: "product-image" | "color-chart", file: File) {
  const target = await adminApi.createUploadUrl(kind, file.name, file.type);
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.storage
    .from(target.bucket)
    .uploadToSignedUrl(target.path, target.token, file, { contentType: file.type });

  if (error) {
    throw new AdminApiError(400, "upload_failed", error.message);
  }

  return target.path;
}

export function publicAssetUrl(path: string) {
  return `${publicEnv.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/catalog-assets/${path}`;
}

export function formatPrice(value: number) {
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `S/ ${fixed}`;
}

export function formatDateTime(iso: string | null) {
  if (!iso) {
    return "—";
  }

  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
