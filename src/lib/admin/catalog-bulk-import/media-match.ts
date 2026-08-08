// Conciliación de imágenes del lote: fila → producto → variante → archivo.
// La prioridad y la confianza siguen la regla del bloque: archivo dirigido por
// convención (exact) → código interno (exact) → código proveedor (high) →
// marca+modelo (high) → marca+nombre exacto (review). Nunca se asocia una
// imagen «porque se parece», y cada asociación registra su mecanismo.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/catalog/slug";
import { COLOR_LEXICON } from "@/lib/admin/catalog-bulk-import/lexicons";
import type { BulkMediaMatch, BulkNormalizedRecord } from "@/lib/admin/catalog-bulk-import/types";

const BUCKET = "catalog-assets";
const LIST_PAGE = 100;
const MAX_DEPTH = 3;

export type BulkMediaIndex = {
  /** Rutas completas de archivos WebP/PDF bajo productos/. */
  paths: string[];
  /** slug del nombre de archivo (sin extensión) → rutas. */
  byFileSlug: Map<string, string[]>;
  /** carpeta de primer nivel bajo productos/ → rutas. */
  byFolder: Map<string, string[]>;
};

async function listFolder(supabase: SupabaseClient, prefix: string, depth: number, into: string[]) {
  if (depth > MAX_DEPTH) return;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`No se pudo listar ${BUCKET}/${prefix}: ${error.message}`);
    if (!data?.length) return;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Storage marca las carpetas con id nulo.
      if ((entry as { id: string | null }).id === null) {
        await listFolder(supabase, path, depth + 1, into);
      } else if (/\.(webp|pdf)$/i.test(entry.name)) {
        into.push(path);
      }
    }
    if (data.length < LIST_PAGE) return;
    offset += data.length;
  }
}

export async function indexCatalogAssets(supabase: SupabaseClient): Promise<BulkMediaIndex> {
  const paths: string[] = [];
  await listFolder(supabase, "productos", 1, paths);
  // Los assets ya registrados en BD también cuentan (p. ej. subidos por el ZIP).
  const { data: assets, error } = await supabase
    .from("media_assets")
    .select("storage_path")
    .eq("bucket", BUCKET)
    .like("storage_path", "productos/%");
  if (error) throw new Error(`No se pudo leer media_assets: ${error.message}`);
  for (const asset of assets ?? []) {
    if (!paths.includes(asset.storage_path)) paths.push(asset.storage_path);
  }

  const byFileSlug = new Map<string, string[]>();
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const segments = path.split("/");
    const fileName = segments[segments.length - 1].replace(/\.(webp|pdf)$/i, "");
    const fileSlug = slugify(fileName);
    byFileSlug.set(fileSlug, [...(byFileSlug.get(fileSlug) ?? []), path]);
    if (segments.length >= 2) {
      const folder = segments[1];
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
    }
  }
  return { paths, byFileSlug, byFolder };
}

function isImage(path: string) {
  return path.toLowerCase().endsWith(".webp");
}

/**
 * Busca medios para las filas de un clúster de producto. Muta record.media de
 * cada fila con sus coincidencias + estado + deuda (color_fallback/pending).
 */
export function matchClusterMedia(records: BulkNormalizedRecord[], index: BulkMediaIndex) {
  if (!records.length) return;
  const head = records[0];
  const productCode = head.grouping.productCode;
  const productFolder = index.byFolder.get(productCode) ?? [];

  // --- Producto: main / carta por convención de carpeta ----------------------
  const productMatches: BulkMediaMatch[] = [];
  const mainPath = productFolder.find((path) => /\/main\.webp$/i.test(path));
  if (mainPath) {
    productMatches.push({ storagePath: mainPath, mechanism: "package_direct", confidence: "exact", target: "product", role: "main" });
  }
  for (const path of productFolder.filter((entry) => /carta/i.test(entry))) {
    productMatches.push({ storagePath: path, mechanism: "package_direct", confidence: "exact", target: "product", role: "gallery" });
  }

  for (const record of records) {
    const matches: BulkMediaMatch[] = [];
    if (record.action === "create_product") matches.push(...productMatches);

    const tone = record.grouping.axes.find((axis) => axis.code === "tone");
    const visualAxis = record.grouping.axes.find((axis) => axis.code === "tone" || axis.code === "color");

    // 1. Convención dirigida: productos/<code>/tonos/<tono>.webp
    if (tone) {
      const tonePath = productFolder.find((path) => new RegExp(`/tonos/${tone.value}\\.webp$`, "i").test(path));
      if (tonePath) {
        matches.push({ storagePath: tonePath, mechanism: "package_direct", confidence: "exact", target: "variant", role: "swatch" });
      }
    }
    // 2. Código interno como nombre de archivo o carpeta.
    if (record.identity.internalCode) {
      const codeSlug = slugify(record.identity.internalCode);
      for (const path of index.byFileSlug.get(codeSlug) ?? []) {
        if (isImage(path)) matches.push({ storagePath: path, mechanism: "internal_code", confidence: "exact", target: "variant", role: "main" });
      }
      const codeFolder = index.byFolder.get(record.identity.internalCode) ?? index.byFolder.get(codeSlug.toUpperCase()) ?? [];
      const codeMain = codeFolder.find((path) => /\/main\.webp$/i.test(path));
      if (codeMain) matches.push({ storagePath: codeMain, mechanism: "internal_code", confidence: "exact", target: "variant", role: "main" });
    }
    // 3. Código de proveedor.
    if (record.identity.supplierCode && record.identity.supplierCode.length >= 4) {
      for (const path of index.byFileSlug.get(slugify(record.identity.supplierCode)) ?? []) {
        if (isImage(path)) matches.push({ storagePath: path, mechanism: "supplier_code", confidence: "high", target: "variant", role: "main" });
      }
    }
    // 4. Marca + nombre exacto normalizado (revisión, nunca automático).
    if (!matches.some((match) => match.target === "variant") && record.naming.normalizedName) {
      const nameSlug = slugify(`${record.identity.brandSlug}-${record.naming.normalizedName}`);
      for (const path of index.byFileSlug.get(nameSlug) ?? []) {
        if (isImage(path)) matches.push({ storagePath: path, mechanism: "brand_exact_name", confidence: "review", target: "variant", role: "main" });
      }
    }

    const variantMatch = matches.find((match) => match.target === "variant" && match.confidence !== "review");
    const reviewMatch = matches.find((match) => match.target === "variant" && match.confidence === "review");

    record.media.matches = matches;
    if (variantMatch) {
      record.media.status = variantMatch.confidence === "exact" ? "exact" : "high";
      record.media.backfill = null;
    } else if (reviewMatch) {
      record.media.status = "review";
      record.media.backfill = null;
    } else if (visualAxis) {
      // Variante visual sin imagen: swatch honesto solo con color conocido —
      // sea tono con hex (shade) o eje de color con palabra del léxico.
      const colorAxisHex = visualAxis.code === "color"
        ? COLOR_LEXICON.find((entry) => slugify(entry.label) === visualAxis.value)?.hex ?? null
        : null;
      if (record.color?.referenceColor || colorAxisHex) {
        record.media.status = "color_fallback";
        record.media.backfill = "color";
      } else {
        record.media.status = "missing";
        record.media.backfill = "pending";
      }
    } else {
      record.media.status = "missing";
      record.media.backfill = record.action === "create_product" && !mainPath ? "pending" : null;
    }
  }
}
