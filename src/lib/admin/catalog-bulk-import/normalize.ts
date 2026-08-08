// Etapas puras del importador masivo: normalización de texto, clasificación por
// familia, extracción de ejes, agrupamiento producto/variante y deduplicación
// dentro del lote. Sin acceso a BD: recibe filas, devuelve registros
// normalizados + issues. La resolución contra la BD vive en el servicio.

import { createHash } from "node:crypto";
import { slugify } from "@/lib/catalog/slug";
import {
  AROMA_LEXICON,
  COLOR_LEXICON,
  NOISE_PATTERNS,
  PRESENTATION_PATTERN,
  PRODUCT_NOUNS,
  SHAPE_LEXICON,
  SIZE_LEXICON
} from "@/lib/admin/catalog-bulk-import/lexicons";
import { bulkFamilyConfig, bulkFamilyCategoryPath, type BulkFamilyConfig } from "@/lib/admin/catalog-bulk-import/family-map";
import type {
  BulkAxisValue,
  BulkColorInfo,
  BulkListingRow,
  BulkNormalizedRecord,
  BulkRowIssue
} from "@/lib/admin/catalog-bulk-import/types";

const LISTING_SHEET = "Catálogo organizado";
const LISTING_HEADERS: Array<{ key: keyof Omit<BulkListingRow, "row">; header: string }> = [
  { key: "categoria", header: "Categoría propuesta" },
  { key: "familia", header: "Familia propuesta" },
  { key: "estado", header: "Estado de revisión" },
  { key: "codigo", header: "Código" },
  { key: "marca", header: "Marca o línea" },
  { key: "descripcion", header: "Descripción original" },
  { key: "categoriaOriginal", header: "Categoría original" },
  { key: "codigoProveedor", header: "Código proveedor" },
  { key: "proveedor", header: "Proveedor" }
];

const SUPPLIER_CODE_SENTINELS = new Set(["S/C", "SC", "S-C", "SIN CODIGO", "SIN CÓDIGO", "-"]);
const GENERIC_BRAND_SENTINELS = new Set(["OTROS", "OTRO", "VARIOS", "GENERICO", "GENÉRICO", "SIN MARCA", "S/M"]);

const COLOR_BY_TOKEN = new Map(COLOR_LEXICON.map((entry) => [entry.token, entry]));
const AROMA_PHRASES = [...AROMA_LEXICON].sort((a, b) => b.length - a.length);

export type BulkListingSheet = { name: string; rows: Array<{ row: number; cells: Array<string | number | boolean | null> }> };

export function mapListingRows(sheets: Record<string, BulkListingSheet["rows"]>): { rows: BulkListingRow[]; issues: BulkRowIssue[] } {
  const issues: BulkRowIssue[] = [];
  const sheet = sheets[LISTING_SHEET];
  if (!sheet || !sheet.length) {
    throw new Error(`El archivo no contiene la hoja «${LISTING_SHEET}» con datos.`);
  }
  const headerRow = sheet[0];
  const columnByKey = new Map<keyof Omit<BulkListingRow, "row">, number>();
  for (const { key, header } of LISTING_HEADERS) {
    const index = headerRow.cells.findIndex((cell) => typeof cell === "string" && cell.trim().toLowerCase() === header.toLowerCase());
    if (index < 0) {
      throw new Error(`La hoja «${LISTING_SHEET}» no tiene la columna «${header}».`);
    }
    columnByKey.set(key, index);
  }
  const rows: BulkListingRow[] = [];
  for (const raw of sheet.slice(1)) {
    const value = (key: keyof Omit<BulkListingRow, "row">) => {
      const cell = raw.cells[columnByKey.get(key)!];
      if (cell === null || cell === undefined) return null;
      const text = String(cell).trim();
      return text.length ? text : null;
    };
    rows.push({
      row: raw.row,
      categoria: value("categoria"),
      familia: value("familia"),
      estado: value("estado"),
      codigo: value("codigo"),
      marca: value("marca"),
      descripcion: value("descripcion"),
      categoriaOriginal: value("categoriaOriginal"),
      codigoProveedor: value("codigoProveedor"),
      proveedor: value("proveedor")
    });
  }
  return { rows, issues };
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  let text = value;
  for (const [pattern, replacement] of NOISE_PATTERNS) text = text.replace(pattern, replacement);
  text = text.trim();
  return text.length ? text : null;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .map((word) => (word.length > 2 || !/^(de|del|la|el|en|con|para|y|o|a)$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ")
    .replace(/\bp\/([a-z])/g, (_, letter: string) => `para ${letter}`)
    .replace(/\bc\/([a-z])/g, (_, letter: string) => `con ${letter}`);
}

function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 6).toUpperCase();
}

function codePrefix(value: string, fallback: string): string {
  const clean = value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (clean || fallback).slice(0, 3).padEnd(3, "X");
}

type TokenClassification =
  | { kind: "color"; entry: (typeof COLOR_LEXICON)[number]; consumed: number }
  | { kind: "size"; value: string; label: string; consumed: number }
  | { kind: "shape"; value: string; label: string; consumed: number }
  | { kind: "aroma"; phrase: string; consumed: number }
  | { kind: "tone_number"; value: string; consumed: number }
  | { kind: "mm_length"; value: string; consumed: number }
  | { kind: "presentation"; value: string; consumed: number }
  | null;

function normalizeToken(token: string): string {
  return token.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

function classifyAt(tokens: string[], index: number, config: BulkFamilyConfig): TokenClassification {
  const token = tokens[index];
  const upper = normalizeToken(token);

  if (config.axes.includes("aroma")) {
    for (const phrase of AROMA_PHRASES) {
      const words = phrase.split(" ");
      const slice = tokens.slice(index, index + words.length).map(normalizeToken).join(" ");
      if (slice === normalizeToken(phrase)) return { kind: "aroma", phrase, consumed: words.length };
    }
  }
  if (config.axes.includes("color") || config.axes.includes("tone")) {
    const entry = COLOR_BY_TOKEN.get(upper) ?? COLOR_BY_TOKEN.get(token.toUpperCase());
    if (entry) return { kind: "color", entry, consumed: 1 };
  }
  if (config.axes.includes("size_label")) {
    const size = SIZE_LEXICON.get(upper);
    if (size) return { kind: "size", ...size, consumed: 1 };
  }
  if (config.axes.includes("shape")) {
    const shape = SHAPE_LEXICON.get(upper);
    if (shape) return { kind: "shape", ...shape, consumed: 1 };
  }
  if (config.axes.includes("tone")) {
    const match = /^#?(\d{1,4})$/.exec(upper.replace(/^N[°º]?/, ""));
    if ((upper.startsWith("#") || /^N[°º]?\d/.test(upper)) && match) {
      return { kind: "tone_number", value: match[1], consumed: 1 };
    }
  }
  if (config.axes.includes("lash_length")) {
    const match = /^(\d{1,2})MM$/.exec(upper);
    if (match) return { kind: "mm_length", value: match[1], consumed: 1 };
  }
  if (config.axes.includes("presentation")) {
    PRESENTATION_PATTERN.lastIndex = 0;
    if (PRESENTATION_PATTERN.test(upper) && normalizeToken(upper).length <= 12) {
      return { kind: "presentation", value: upper.replace(/\.$/, ""), consumed: 1 };
    }
  }
  return null;
}

function hasProductNoun(tokens: string[]): boolean {
  const nouns = new Set(PRODUCT_NOUNS.map(normalizeToken));
  return tokens.some((token) => nouns.has(normalizeToken(token).replace(/[.,]$/, "")));
}

type ExtractedRow = {
  row: BulkListingRow;
  config: BulkFamilyConfig | null;
  cleanedDescription: string | null;
  baseTokens: string[];
  baseKey: string;
  axes: BulkAxisValue[];
  presentation: string | null;
  isBareTone: boolean;
  review: string[];
};

function extractAxes(row: BulkListingRow, config: BulkFamilyConfig | null): ExtractedRow {
  const review: string[] = [];
  const cleaned = cleanText(row.descripcion);
  if (!config || !cleaned) {
    return {
      row, config, cleanedDescription: cleaned,
      baseTokens: cleaned ? cleaned.split(" ") : [],
      baseKey: cleaned ? normalizeToken(cleaned) : `fila-${row.row}`,
      axes: [], presentation: null, isBareTone: false, review
    };
  }
  const tokens = cleaned.split(" ").filter(Boolean);

  if (config.bareDescriptionIsTone && !hasProductNoun(tokens)) {
    // Patrón ADMISS: la descripción entera es el nombre del tono.
    return {
      row, config, cleanedDescription: cleaned,
      baseTokens: [config.productNoun ?? "Producto"],
      baseKey: normalizeToken(config.productNoun ?? "PRODUCTO"),
      axes: [{ code: "tone", value: slugify(cleaned), label: titleCase(cleaned), confidence: "high" }],
      presentation: null, isBareTone: true, review
    };
  }

  const axes: BulkAxisValue[] = [];
  const base: string[] = [];
  let presentation: string | null = null;
  let index = 0;
  while (index < tokens.length) {
    const classified = classifyAt(tokens, index, config);
    if (!classified) {
      base.push(tokens[index]);
      index += 1;
      continue;
    }
    if (classified.kind === "color") {
      const axisCode = config.axes.includes("color") ? "color" : "tone";
      axes.push({ code: axisCode, value: slugify(classified.entry.label), label: classified.entry.label, confidence: "high" });
    } else if (classified.kind === "size") {
      axes.push({ code: "size_label", value: classified.value, label: classified.label, confidence: "high" });
    } else if (classified.kind === "shape") {
      axes.push({ code: "shape", value: classified.value, label: classified.label, confidence: "high" });
    } else if (classified.kind === "aroma") {
      axes.push({ code: "aroma", value: slugify(classified.phrase), label: titleCase(classified.phrase), confidence: "high" });
    } else if (classified.kind === "tone_number") {
      axes.push({ code: "tone", value: `n-${classified.value}`, label: `N.º ${classified.value}`, confidence: "high" });
    } else if (classified.kind === "mm_length") {
      axes.push({ code: "lash_length", value: `${classified.value}mm`, label: `${classified.value} mm`, confidence: "high" });
    } else if (classified.kind === "presentation") {
      presentation = presentation ? `${presentation} ${classified.value}` : classified.value;
    }
    index += classified.consumed;
  }

  if (presentation) {
    axes.push({ code: "presentation", value: slugify(presentation), label: presentation, confidence: "high" });
  }

  return {
    row, config, cleanedDescription: cleaned,
    baseTokens: base.length ? base : tokens,
    baseKey: normalizeToken((base.length ? base : tokens).join(" ")),
    axes, presentation, isBareTone: false, review
  };
}

function brandKey(row: BulkListingRow): { name: string | null; isGeneric: boolean } {
  const cleaned = cleanText(row.marca);
  if (!cleaned || GENERIC_BRAND_SENTINELS.has(normalizeToken(cleaned))) {
    return { name: null, isGeneric: true };
  }
  return { name: cleaned, isGeneric: false };
}

function supplierInfo(row: BulkListingRow): { name: string | null; supplierSku: string | null } {
  const name = cleanText(row.proveedor);
  const rawCode = cleanText(row.codigoProveedor);
  const supplierSku = rawCode && !SUPPLIER_CODE_SENTINELS.has(normalizeToken(rawCode)) ? rawCode : null;
  return { name, supplierSku };
}

function colorInfoFromAxes(axes: BulkAxisValue[], cleanedDescription: string | null, isBareTone: boolean): BulkColorInfo | null {
  const tone = axes.find((axis) => axis.code === "tone");
  if (!tone) return null;
  const colorEntry = COLOR_LEXICON.find((entry) => slugify(entry.label) === tone.value || normalizeToken(entry.label) === normalizeToken(tone.label));
  if (colorEntry) {
    return {
      shadeName: colorEntry.label,
      shadeCode: tone.value,
      colorFamilyValue: colorEntry.colorFamilyValue,
      referenceColor: colorEntry.hex
    };
  }
  // Tono con nombre propio (fantasía) o numérico: se registra sin inventar color.
  return {
    shadeName: isBareTone && cleanedDescription ? titleCase(cleanedDescription) : tone.label,
    shadeCode: tone.value,
    colorFamilyValue: "por-clasificar",
    referenceColor: null
  };
}

export type NormalizeListingResult = {
  records: BulkNormalizedRecord[];
  issues: BulkRowIssue[];
};

/**
 * Convierte filas del listado en registros normalizados con agrupamiento
 * producto/variante y deduplicación intra-lote. Determinista: el mismo Excel
 * produce exactamente los mismos códigos, claves y acciones.
 */
export function normalizeListing(rows: BulkListingRow[]): NormalizeListingResult {
  const issues: BulkRowIssue[] = [];
  const extracted: ExtractedRow[] = [];

  for (const row of rows) {
    const config = bulkFamilyConfig(row.familia);
    const item = extractAxes(row, config);
    if (!config) {
      item.review.push(`Familia sin mapa: ${row.familia ?? "(vacía)"}`);
      issues.push({ row: row.row, severity: "error", code: "family_unmapped", field: "familia", message: `La familia «${row.familia ?? "(vacía)"}» no tiene categoría/plantilla asignada; la fila queda en revisión manual.` });
    }
    if (!item.cleanedDescription) {
      item.review.push("Descripción vacía");
      issues.push({ row: row.row, severity: "blocking", code: "empty_description", field: "descripcion", message: "La fila no tiene descripción; no se puede proponer producto." });
    }
    if (row.estado && row.estado.toLowerCase() !== "clasificado") {
      item.review.push(`Estado de revisión del Excel: ${row.estado}`);
      issues.push({ row: row.row, severity: "warning", code: "source_pending", field: "estado", message: `La fila llegó marcada «${row.estado}» en el Excel original.` });
    }
    extracted.push(item);
  }

  // --- Agrupamiento por (marca | familia | nombre base) ---------------------
  const clusters = new Map<string, ExtractedRow[]>();
  for (const item of extracted) {
    const brand = brandKey(item.row);
    const clusterKey = [
      brand.isGeneric ? "~generic" : normalizeToken(brand.name!),
      item.config ? item.config.familia : "~sin-familia",
      item.baseKey
    ].join("|");
    clusters.set(clusterKey, [...(clusters.get(clusterKey) ?? []), item]);
  }

  // Segunda pasada set_name: singles que comparten prefijo largo dentro de la
  // misma marca+familia y cuya cola no clasifica en ningún léxico.
  const singles = [...clusters.entries()].filter(([, list]) => list.length === 1 && list[0].config?.axes.includes("set_name"));
  const byPrefix = new Map<string, Array<{ clusterKey: string; item: ExtractedRow; suffix: string[] }>>();
  for (const [clusterKey, [item]] of singles) {
    if (item.isBareTone || item.baseTokens.length < 3) continue;
    const brand = brandKey(item.row);
    for (let cut = item.baseTokens.length - 1; cut >= 2; cut -= 1) {
      const prefix = [
        brand.isGeneric ? "~generic" : normalizeToken(brand.name!),
        item.config!.familia,
        normalizeToken(item.baseTokens.slice(0, cut).join(" "))
      ].join("|");
      const suffix = item.baseTokens.slice(cut);
      if (!suffix.length || hasProductNoun(suffix)) continue;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), { clusterKey, item, suffix }]);
    }
  }
  for (const [prefix, members] of byPrefix) {
    const uniqueClusters = new Set(members.map((member) => member.clusterKey));
    if (uniqueClusters.size < 2) continue;
    // Solo el corte más largo compartido por ≥2 filas distintas se aplica.
    const chosen = new Map<string, { clusterKey: string; item: ExtractedRow; suffix: string[] }>();
    for (const member of members) {
      const existing = chosen.get(member.clusterKey);
      if (!existing || member.suffix.length < existing.suffix.length) chosen.set(member.clusterKey, member);
    }
    if (chosen.size < 2) continue;
    const baseTokens = prefix.split("|")[2].split(" ");
    for (const { clusterKey, item, suffix } of chosen.values()) {
      if (!clusters.has(clusterKey)) continue;
      clusters.delete(clusterKey);
      item.baseTokens = baseTokens;
      item.baseKey = normalizeToken(baseTokens.join(" "));
      item.axes.push({ code: "set_name", value: slugify(suffix.join(" ")), label: titleCase(suffix.join(" ")), confidence: "review" });
      item.review.push(`Agrupada como variante por colección/set «${suffix.join(" ")}» — confirmar`);
      const brand = brandKey(item.row);
      const newKey = [brand.isGeneric ? "~generic" : normalizeToken(brand.name!), item.config!.familia, item.baseKey].join("|");
      clusters.set(newKey, [...(clusters.get(newKey) ?? []), item]);
    }
  }

  // --- Registros normalizados por clúster -----------------------------------
  const records: BulkNormalizedRecord[] = [];
  for (const [, members] of [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = members[0];
    const config = first.config;
    const brand = brandKey(first.row);
    const brandName = brand.isGeneric ? "Genérica / sin marca" : brand.name!;
    const brandSlug = brand.isGeneric ? "generica-sin-marca" : slugify(brand.name!);
    const familiaKey = config?.familia ?? "sin-familia";
    const baseName = first.isBareTone
      ? `${config?.productNoun ?? "Producto"} ${brandName}`
      : titleCase(first.baseTokens.join(" "));
    const hash = shortHash(brandSlug, familiaKey, first.baseKey);
    const productCode = `${codePrefix(brandSlug, "GEN")}-${codePrefix(config?.categorySlug ?? "XXX", "XXX")}-${hash}`;
    const productName = baseName;
    const productKey = `${brandSlug}|${familiaKey}|${first.baseKey}`;
    const productSlug = slugify(`${brandSlug}-${baseName}-${hash}`);

    const seenVariantKeys = new Map<string, BulkNormalizedRecord>();
    const sortedMembers = [...members].sort((a, b) => a.row.row - b.row.row);

    for (const [memberIndex, member] of sortedMembers.entries()) {
      const supplier = supplierInfo(member.row);
      const axisOrder: Record<string, number> = { tone: 1, color: 2, aroma: 3, size_label: 4, shape: 5, lash_length: 6, set_name: 7, presentation: 8 };
      const axes = [...member.axes].sort((a, b) => (axisOrder[a.code] ?? 99) - (axisOrder[b.code] ?? 99));
      const variantKey = axes.length ? axes.map((axis) => `${axis.code}:${axis.value}`).join("|") : "unica";
      const variantName = axes.length ? axes.map((axis) => axis.label).join(" · ") : "Única";
      const internalCode = cleanText(member.row.codigo);
      const groupingConfidence: BulkNormalizedRecord["grouping"]["confidence"] =
        axes.some((axis) => axis.confidence === "review") ? "review" : "high";

      const review = [...member.review];
      let action: BulkNormalizedRecord["action"];
      const duplicate = seenVariantKeys.get(variantKey);
      if (!member.cleanedDescription || !config) {
        action = "skip";
      } else if (!duplicate) {
        action = memberIndex === 0 ? "create_product" : "create_variant";
      } else {
        const duplicateSupplier = duplicate.supplier?.name ?? null;
        const sameSupplier = (supplier.name ?? null) === duplicateSupplier;
        const bothCoded = internalCode && duplicate.identity.internalCode;
        if (bothCoded && internalCode !== duplicate.identity.internalCode) {
          action = "merge";
          review.push(`Misma variante propuesta con códigos internos distintos (${duplicate.identity.internalCode} vs ${internalCode})`);
          issues.push({ row: member.row.row, severity: "error", code: "conflicting_internal_codes", field: "codigo", message: `La fila coincide con la fila ${duplicate.source.row} pero con otro código interno; decidir manualmente.` });
        } else if (sameSupplier) {
          action = "skip";
          review.push(`Duplicado exacto de la fila ${duplicate.source.row} (mismo proveedor)`);
          issues.push({ row: member.row.row, severity: "warning", code: "duplicate_row_skipped", field: null, message: `Repite descripción, marca y proveedor de la fila ${duplicate.source.row}; se omite para no duplicar.` });
        } else {
          action = "update_variant";
          review.push(`Segunda oferta de proveedor para la variante de la fila ${duplicate.source.row}`);
        }
      }

      const color = colorInfoFromAxes(axes, member.cleanedDescription, member.isBareTone);
      const attributes: BulkNormalizedRecord["attributes"] = [];
      for (const axis of axes) {
        if (axis.code === "presentation") continue;
        attributes.push({ code: axis.code === "tone" ? "tone" : axis.code, value: axis.value, source: "description" });
      }
      if (member.presentation) attributes.push({ code: "presentation", value: member.presentation, source: "description" });

      const record: BulkNormalizedRecord = {
        source: {
          sheet: LISTING_SHEET,
          row: member.row.row,
          estado: member.row.estado,
          categoriaOriginal: member.row.categoriaOriginal
        },
        classification: {
          familia: member.row.familia,
          categoryPath: config ? bulkFamilyCategoryPath(config) : null,
          templateCode: config?.templateCode ?? null,
          confidence: config ? "high" : "review"
        },
        identity: {
          internalCode,
          supplierCode: supplier.supplierSku,
          supplierName: supplier.name,
          brandName,
          brandSlug,
          brandIsGeneric: brand.isGeneric
        },
        naming: {
          originalDescription: member.row.descripcion,
          normalizedName: member.cleanedDescription ? titleCase(member.cleanedDescription) : "",
          baseName,
          presentation: member.presentation
        },
        grouping: {
          productKey,
          productCode,
          productName,
          productSlug,
          variantKey,
          variantName,
          axes,
          confidence: groupingConfidence
        },
        attributes,
        color,
        supplier: supplier.name ? { name: supplier.name, supplierSku: supplier.supplierSku } : null,
        media: { matches: [], status: "missing", backfill: null },
        action,
        review
      };
      if (!duplicate) seenVariantKeys.set(variantKey, record);
      if (groupingConfidence === "review" && action !== "skip") {
        issues.push({ row: member.row.row, severity: "warning", code: "grouping_needs_confirmation", field: null, message: `Agrupación propuesta con confianza baja (${variantName}); confirmar en revisión.` });
      }
      records.push(record);
    }
  }

  records.sort((a, b) => a.source.row - b.source.row);
  return { records, issues };
}
