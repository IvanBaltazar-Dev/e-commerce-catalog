import "server-only";

import { notFound } from "next/navigation";
import { HttpError } from "@/lib/api/http";
import { requireDeveloper } from "@/lib/auth/admin";
import { serverEnv } from "@/lib/env/server";

export function catalogImportsEnabled() {
  return serverEnv.ENABLE_CATALOG_IMPORTS === "true";
}

export async function requireCatalogImportDeveloper() {
  if (!catalogImportsEnabled()) {
    throw new HttpError(404, "catalog_imports_disabled", "El cargador de catálogo no está habilitado.");
  }
  return requireDeveloper();
}

export async function requireCatalogImportPage() {
  if (!catalogImportsEnabled()) notFound();
  try {
    return await requireDeveloper();
  } catch {
    notFound();
  }
}
