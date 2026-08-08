// Servicio del importador masivo: orquesta las etapas puras contra la BD usando
// el MISMO staging del sistema existente (import_batches/import_rows/import_issues)
// y el MISMO camino de escritura (saveCatalogV2Product, create_color_shade).
//
// Idempotencia, en tres anclas:
//   fila   → unique(batch_id, row_number) + filas committed nunca se reprocesan;
//   SKU    → el código interno del Excel es el SKU (índice único en BD);
//   código → el código de producto es determinista (marca|familia|nombre base).

import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import { getCatalogV2Bootstrap, getCatalogV2Product, saveCatalogV2Product } from "@/lib/admin/catalog-v2-service";
import type { AdminV2Bootstrap, AdminV2ProductInput } from "@/lib/admin/catalog-v2";
import type { CatalogRawWorkbook } from "@/lib/admin/catalog-import-xlsx";
import { mapListingRows, normalizeListing } from "@/lib/admin/catalog-bulk-import/normalize";
import { indexCatalogAssets, matchClusterMedia } from "@/lib/admin/catalog-bulk-import/media-match";
import { COLOR_LEXICON } from "@/lib/admin/catalog-bulk-import/lexicons";
import { slugify } from "@/lib/catalog/slug";
import type {
  BulkBatchCounts,
  BulkBatchPreview,
  BulkCommitReport,
  BulkListingRow,
  BulkMediaStatus,
  BulkNormalizedRecord,
  BulkProposedAction,
  BulkRowIssue
} from "@/lib/admin/catalog-bulk-import/types";

type Supabase = SupabaseClient;

const SOURCE_PREFIX = "bulk_catalog_v2";
const MAX_LOTE_ROWS = 400;
const OPEN_VOCABULARY_AXES = new Set(["aroma", "set_name", "size_label", "color", "shape", "lash_length", "strip_style"]);

function fail(code: string, message: string): never {
  throw new HttpError(400, code, message);
}

function chunked<T>(items: T[], size = 80): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) chunks.push(items.slice(offset, offset + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Etapa A+B+C+D+E: preparar el lote y dejarlo en staging (preview).
// ---------------------------------------------------------------------------

export type BulkLoteSpec = {
  /** Nombre estable del lote, p. ej. «piloto-01» o «unas-esmaltes-01». */
  name: string;
  /** Familias del Excel incluidas; vacío = todas (limitado por maxRows). */
  familias?: string[];
  /** Rango opcional de filas del Excel (inclusive) para partir familias grandes. */
  fromRow?: number;
  toRow?: number;
};

export async function stageBulkImportBatch(
  supabase: Supabase,
  userId: string,
  workbook: CatalogRawWorkbook,
  lote: BulkLoteSpec
): Promise<BulkBatchPreview> {
  if (!lote?.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lote.name)) {
    throw new HttpError(422, "bulk_lote_name_invalid", "El lote necesita un nombre en minúsculas con guiones, p. ej. «piloto-01».");
  }
  const sourceName = `${SOURCE_PREFIX}:${lote.name}`;

  const { rows: allRows } = mapListingRows(workbook.sheets);
  let rows: BulkListingRow[] = allRows;
  if (lote.familias?.length) {
    const wanted = new Set(lote.familias.map((familia) => familia.trim().toLowerCase()));
    rows = rows.filter((row) => row.familia && wanted.has(row.familia.trim().toLowerCase()));
  }
  if (lote.fromRow) rows = rows.filter((row) => row.row >= lote.fromRow!);
  if (lote.toRow) rows = rows.filter((row) => row.row <= lote.toRow!);
  if (!rows.length) throw new HttpError(422, "bulk_lote_empty", "El lote no seleccionó ninguna fila del Excel.");
  if (rows.length > MAX_LOTE_ROWS) {
    throw new HttpError(422, "bulk_lote_too_large", `El lote tiene ${rows.length} filas; el máximo por lote es ${MAX_LOTE_ROWS}. Divide la familia en rangos (fromRow/toRow).`);
  }

  const { records, issues } = normalizeListing(rows);

  // --- Identidad contra la BD (escalera: sku → proveedor+código → código) ---
  const internalCodes = [...new Set(records.map((record) => record.identity.internalCode).filter((code): code is string => Boolean(code)))];
  const productCodes = [...new Set(records.map((record) => record.grouping.productCode))];

  const existingSkus = new Map<string, { id: unknown; sku: unknown; product_id: unknown }>();
  for (const chunk of chunked(internalCodes)) {
    const result = await supabase.from("product_variants").select("id, sku, product_id").in("sku", chunk);
    if (result.error) fail("bulk_identity_lookup_failed", result.error.message);
    for (const variant of result.data ?? []) existingSkus.set(String(variant.sku).toLowerCase(), variant);
  }
  const existingProducts = new Map<string, { id: unknown; code: unknown }>();
  for (const chunk of chunked(productCodes)) {
    const result = await supabase.from("products").select("id, code").in("code", chunk);
    if (result.error) fail("bulk_identity_lookup_failed", result.error.message);
    for (const product of result.data ?? []) existingProducts.set(String(product.code), product);
  }
  const supplierLinks = await supabase.from("product_suppliers").select("variant_id, supplier_sku, suppliers!inner(trade_name)").eq("is_active", true);
  if (supplierLinks.error) fail("bulk_identity_lookup_failed", supplierLinks.error.message);
  const existingSupplierOffers = new Set(
    (supplierLinks.data ?? []).map((link) => `${String((link.suppliers as unknown as { trade_name: string }).trade_name).toLowerCase()}|${String(link.supplier_sku ?? "").toLowerCase()}`)
  );

  for (const record of records) {
    if (record.action === "skip" || record.action === "merge") continue;
    const sku = record.identity.internalCode;
    if (sku && existingSkus.has(sku.toLowerCase())) {
      const offerKey = `${(record.identity.supplierName ?? "").toLowerCase()}|${(record.identity.supplierCode ?? "").toLowerCase()}`;
      if (record.supplier && !existingSupplierOffers.has(offerKey)) {
        record.action = "update_variant";
        record.review.push(`El SKU ${sku} ya existe en la BD: solo se añadiría la oferta del proveedor ${record.supplier.name}.`);
      } else {
        record.action = "skip";
        record.review.push(`El SKU ${sku} ya está importado; la fila se omite (duplicado evitado).`);
      }
      continue;
    }
    if (record.action === "create_product" && existingProducts.has(record.grouping.productCode)) {
      record.action = "update_product";
      record.review.push(`El producto ${record.grouping.productCode} ya existe: las variantes nuevas se añadirían sobre él.`);
    }
  }

  // --- Conciliación de imágenes ---------------------------------------------
  const mediaIndex = await indexCatalogAssets(supabase);
  const byProduct = new Map<string, BulkNormalizedRecord[]>();
  for (const record of records) {
    byProduct.set(record.grouping.productKey, [...(byProduct.get(record.grouping.productKey) ?? []), record]);
  }
  for (const cluster of byProduct.values()) matchClusterMedia(cluster, mediaIndex);
  for (const record of records) {
    if (record.media.status === "missing" && record.media.backfill === "pending" && record.action !== "skip") {
      issues.push({
        row: record.source.row,
        severity: "info",
        code: "media_pending",
        field: null,
        message: record.grouping.axes.some((axis) => axis.code === "tone" || axis.code === "color")
          ? "Variante visual sin fotografía ni color confiable: queda como deuda media_pending."
          : "Sin imagen disponible: queda como deuda media_pending (no bloquea)."
      });
    }
    if (record.media.status === "review") {
      issues.push({ row: record.source.row, severity: "warning", code: "media_review", field: null, message: "Imagen encontrada por nombre exacto de marca: confirmar en revisión antes de asociar." });
    }
  }

  // --- Persistir staging (reemplaza lotes no confirmados del mismo nombre) --
  const startedAt = Date.now();
  const existingBatch = await supabase
    .from("import_batches")
    .select("id, status, file_sha256")
    .eq("source_name", sourceName)
    .neq("status", "committed")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingBatch.error) fail("bulk_batch_lookup_failed", existingBatch.error.message);

  let batchId: string;
  if (existingBatch.data) {
    batchId = String(existingBatch.data.id);
    const cleared = await supabase.from("import_rows").delete().eq("batch_id", batchId);
    if (cleared.error) fail("bulk_batch_reset_failed", cleared.error.message);
    const updated = await supabase.from("import_batches").update({
      status: "parsing",
      original_file_name: workbook.fileName,
      file_sha256: workbook.fileSha256,
      security_report: workbook.security,
      total_rows: records.length,
      processed_rows: 0,
      error_rows: 0,
      summary: { lote: lote.name, familias: lote.familias ?? [], fromRow: lote.fromRow ?? null, toRow: lote.toRow ?? null }
    }).eq("id", batchId);
    if (updated.error) fail("bulk_batch_update_failed", updated.error.message);
  } else {
    const inserted = await supabase.from("import_batches").insert({
      source_type: "xlsx",
      source_name: sourceName,
      original_file_name: workbook.fileName,
      status: "parsing",
      total_rows: records.length,
      created_by: userId,
      file_sha256: workbook.fileSha256,
      security_report: workbook.security,
      summary: { lote: lote.name, familias: lote.familias ?? [], fromRow: lote.fromRow ?? null, toRow: lote.toRow ?? null }
    }).select("id").single();
    if (inserted.error || !inserted.data) fail("bulk_batch_create_failed", inserted.error?.message ?? "No se pudo crear el lote.");
    batchId = String(inserted.data.id);
  }

  const issuesByRow = new Map<number, BulkRowIssue[]>();
  for (const issue of issues) issuesByRow.set(issue.row, [...(issuesByRow.get(issue.row) ?? []), issue]);

  const rowByNumber = new Map(rows.map((row) => [row.row, row]));
  const CHUNK = 200;
  const insertedRowIds = new Map<number, string>();
  for (let offset = 0; offset < records.length; offset += CHUNK) {
    const chunk = records.slice(offset, offset + CHUNK);
    const payload = chunk.map((record) => {
      const original = rowByNumber.get(record.source.row);
      const rowIssues = issuesByRow.get(record.source.row) ?? [];
      const blocking = rowIssues.some((issue) => issue.severity === "error" || issue.severity === "blocking");
      const status = record.action === "skip"
        ? "skipped"
        : blocking || record.review.length > 0 || record.action === "merge"
          ? "needs_review"
          : "normalized";
      return {
        batch_id: batchId,
        row_number: record.source.row,
        raw_data: { ...original },
        normalized_data: record as unknown as Record<string, unknown>,
        proposed_action: record.action === "merge" ? "merge" : record.action,
        status
      };
    });
    const insert = await supabase.from("import_rows").insert(payload).select("id, row_number");
    if (insert.error) fail("bulk_rows_insert_failed", insert.error.message);
    for (const row of insert.data ?? []) insertedRowIds.set(Number(row.row_number), String(row.id));
  }

  const issuePayload = issues
    .filter((issue) => insertedRowIds.has(issue.row))
    .map((issue) => ({
      import_row_id: insertedRowIds.get(issue.row)!,
      issue_code: issue.code,
      severity: issue.severity,
      field_name: issue.field,
      message: issue.message
    }));
  for (let offset = 0; offset < issuePayload.length; offset += CHUNK) {
    const insert = await supabase.from("import_issues").insert(issuePayload.slice(offset, offset + CHUNK));
    if (insert.error) fail("bulk_issues_insert_failed", insert.error.message);
  }

  const needsReview = records.some((record) => record.review.length > 0 || record.action === "merge");
  const finished = await supabase.from("import_batches").update({
    status: needsReview ? "needs_review" : "normalized",
    summary: {
      lote: lote.name,
      familias: lote.familias ?? [],
      fromRow: lote.fromRow ?? null,
      toRow: lote.toRow ?? null,
      normalizacionMs: Date.now() - startedAt
    }
  }).eq("id", batchId);
  if (finished.error) fail("bulk_batch_finish_failed", finished.error.message);

  return buildBulkPreview(supabase, batchId);
}

// ---------------------------------------------------------------------------
// Preview: el lote leído desde staging, con excepciones navegables.
// ---------------------------------------------------------------------------

export async function buildBulkPreview(supabase: Supabase, batchId: string): Promise<BulkBatchPreview> {
  const batch = await supabase.from("import_batches").select("id, source_name, original_file_name, file_sha256, status, total_rows, summary").eq("id", batchId).single();
  if (batch.error || !batch.data) fail("bulk_batch_not_found", batch.error?.message ?? "Lote no encontrado.");
  const rows = await supabase
    .from("import_rows")
    .select("id, row_number, status, proposed_action, normalized_data, import_issues(id, issue_code, severity, field_name, message, status)")
    .eq("batch_id", batchId)
    .order("row_number");
  if (rows.error) fail("bulk_rows_read_failed", rows.error.message);

  const porAccion: Record<BulkProposedAction, number> = { create_product: 0, create_variant: 0, update_product: 0, update_variant: 0, skip: 0, merge: 0 };
  const porEstadoFila: Record<string, number> = {};
  const productos = new Map<string, BulkBatchPreview["productos"][number]>();
  const excepciones: BulkBatchPreview["excepciones"] = [];
  let issuesAbiertos = 0;

  for (const row of rows.data ?? []) {
    const record = row.normalized_data as unknown as BulkNormalizedRecord;
    const action = (row.proposed_action ?? "skip") as BulkProposedAction;
    porAccion[action] = (porAccion[action] ?? 0) + 1;
    porEstadoFila[row.status] = (porEstadoFila[row.status] ?? 0) + 1;

    const key = record.grouping.productKey;
    const producto = productos.get(key) ?? {
      productCode: record.grouping.productCode,
      productName: record.grouping.productName,
      brand: record.identity.brandName ?? "—",
      familia: record.classification.familia,
      action,
      variantCount: 0,
      reviewCount: 0,
      mediaStatus: { exact: 0, high: 0, review: 0, missing: 0, color_fallback: 0 } as Record<BulkMediaStatus, number>
    };
    if (action === "create_product" || action === "update_product") producto.action = action;
    if (action !== "skip") producto.variantCount += 1;
    if (row.status === "needs_review") producto.reviewCount += 1;
    producto.mediaStatus[record.media.status] += 1;
    productos.set(key, producto);

    const openIssues = (row.import_issues ?? []).filter((issue) => issue.status === "open");
    issuesAbiertos += openIssues.length;
    if (row.status === "needs_review") {
      excepciones.push({
        importRowId: String(row.id),
        row: Number(row.row_number),
        productCode: record.grouping.productCode,
        variantKey: record.grouping.variantKey,
        description: record.naming.originalDescription,
        reasons: record.review,
        issues: openIssues.map((issue) => ({
          row: Number(row.row_number),
          severity: issue.severity as BulkRowIssue["severity"],
          code: issue.issue_code,
          field: issue.field_name,
          message: issue.message
        }))
      });
    }
  }

  const summary = (batch.data.summary ?? {}) as { lote?: string; familias?: string[] };
  return {
    batchId: String(batch.data.id),
    fileName: String(batch.data.original_file_name ?? ""),
    fileSha256: String(batch.data.file_sha256 ?? ""),
    loteName: summary.lote ?? String(batch.data.source_name).replace(`${SOURCE_PREFIX}:`, ""),
    familias: summary.familias ?? [],
    status: String(batch.data.status),
    totalRows: Number(batch.data.total_rows),
    productos: [...productos.values()].sort((a, b) => a.productCode.localeCompare(b.productCode)),
    porAccion,
    porEstadoFila,
    excepciones,
    issuesAbiertos,
    canCommit: (porEstadoFila["normalized"] ?? 0) + (porEstadoFila["approved"] ?? 0) > 0
  };
}

// ---------------------------------------------------------------------------
// Aprobación: individual o masiva; las excepciones con error/bloqueo no pasan.
// ---------------------------------------------------------------------------

export async function approveBulkBatch(
  supabase: Supabase,
  batchId: string,
  options: { includeReview?: boolean; rowNumbers?: number[]; skipRowNumbers?: number[] } = {}
) {
  const rows = await supabase
    .from("import_rows")
    .select("id, row_number, status, import_issues(id, severity, status)")
    .eq("batch_id", batchId)
    .in("status", ["normalized", "needs_review"]);
  if (rows.error) fail("bulk_approve_read_failed", rows.error.message);

  const toApprove: string[] = [];
  const toSkip: string[] = [];
  const resolvableIssues: string[] = [];
  const wantedRows = options.rowNumbers ? new Set(options.rowNumbers) : null;
  const skipRows = new Set(options.skipRowNumbers ?? []);
  let blockedByIssues = 0;

  for (const row of rows.data ?? []) {
    const rowNumber = Number(row.row_number);
    if (skipRows.has(rowNumber)) {
      toSkip.push(String(row.id));
      continue;
    }
    const isReview = row.status === "needs_review";
    const selected = wantedRows ? wantedRows.has(rowNumber) : (!isReview || options.includeReview === true);
    if (!selected) continue;
    const open = (row.import_issues ?? []).filter((issue) => issue.status === "open");
    if (open.some((issue) => issue.severity === "error" || issue.severity === "blocking")) {
      blockedByIssues += 1;
      continue;
    }
    toApprove.push(String(row.id));
    resolvableIssues.push(...open.map((issue) => String(issue.id)));
  }

  for (const chunk of chunked(toApprove)) {
    const update = await supabase.from("import_rows").update({ status: "approved" }).in("id", chunk);
    if (update.error) fail("bulk_approve_failed", update.error.message);
  }
  for (const chunk of chunked(toSkip)) {
    const update = await supabase.from("import_rows").update({ status: "skipped", proposed_action: "skip" }).in("id", chunk);
    if (update.error) fail("bulk_skip_failed", update.error.message);
  }
  for (const chunk of chunked(resolvableIssues)) {
    const update = await supabase.from("import_issues").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { via: "bulk_approve" } }).in("id", chunk);
    if (update.error) fail("bulk_issue_resolve_failed", update.error.message);
  }
  const status = await supabase.from("import_batches").update({ status: "approved" }).eq("id", batchId);
  if (status.error) fail("bulk_batch_approve_failed", status.error.message);

  return { approved: toApprove.length, skipped: toSkip.length, blockedByIssues };
}

// ---------------------------------------------------------------------------
// Commit: clúster por clúster, con el mismo camino de escritura del panel.
// ---------------------------------------------------------------------------

type StagedRow = {
  id: string;
  rowNumber: number;
  record: BulkNormalizedRecord;
};

async function ensureBrand(supabase: Supabase, bootstrap: AdminV2Bootstrap, record: BulkNormalizedRecord, created: Set<string>) {
  const existing = bootstrap.brands.find((brand) => brand.slug === record.identity.brandSlug);
  if (existing) return existing.id;
  const insert = await supabase.from("brands").insert({
    name: record.identity.brandName,
    slug: record.identity.brandSlug,
    is_active: true,
    is_generic: false
  }).select("id").single();
  if (insert.error || !insert.data) fail("bulk_brand_create_failed", insert.error?.message ?? "No se pudo crear la marca.");
  const id = String(insert.data.id);
  bootstrap.brands.push({ id, name: record.identity.brandName ?? "", slug: record.identity.brandSlug ?? "", isGeneric: false, templateIds: [] });
  created.add(record.identity.brandSlug ?? "");
  return id;
}

async function ensureBrandTemplate(supabase: Supabase, bootstrap: AdminV2Bootstrap, brandId: string, templateId: string) {
  const brand = bootstrap.brands.find((entry) => entry.id === brandId);
  if (!brand || brand.isGeneric || brand.templateIds.includes(templateId)) return;
  const insert = await supabase.from("brand_product_families").upsert({ brand_id: brandId, template_id: templateId }, { onConflict: "brand_id,template_id" });
  if (insert.error) fail("bulk_brand_family_failed", insert.error.message);
  brand.templateIds.push(templateId);
}

async function ensureSupplier(supabase: Supabase, cache: Map<string, string>, companyId: string, name: string) {
  const key = name.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const code = slugify(name).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40) || "PROVEEDOR";
  const existing = await supabase.from("suppliers").select("id").eq("company_id", companyId).eq("code", code).maybeSingle();
  if (existing.error) fail("bulk_supplier_lookup_failed", existing.error.message);
  if (existing.data) {
    cache.set(key, String(existing.data.id));
    return String(existing.data.id);
  }
  const insert = await supabase.from("suppliers").insert({
    company_id: companyId,
    code,
    legal_name: name,
    trade_name: name
  }).select("id").single();
  if (insert.error || !insert.data) fail("bulk_supplier_create_failed", insert.error?.message ?? `No se pudo crear el proveedor ${name}.`);
  cache.set(key, String(insert.data.id));
  return String(insert.data.id);
}

async function ensureAttributeOption(
  supabase: Supabase,
  bootstrap: AdminV2Bootstrap,
  attributeCode: string,
  value: string,
  label: string,
  createdOptions: string[]
) {
  const definition = bootstrap.attributes.find((attribute) => attribute.code === attributeCode);
  if (!definition) return null;
  const existing = definition.options.find((option) => option.value.toLowerCase() === value.toLowerCase());
  if (existing) return existing.id;
  if (!OPEN_VOCABULARY_AXES.has(attributeCode)) return null;
  // El hex del léxico viaja en metadata para que el swatch temporal (deuda
  // media_backfill=color) tenga de dónde pintarse sin inventar nada.
  const lexiconHex = attributeCode === "color"
    ? COLOR_LEXICON.find((entry) => slugify(entry.label) === value)?.hex ?? null
    : null;
  const insert = await supabase.from("attribute_options").insert({
    attribute_definition_id: definition.id,
    value,
    label,
    metadata: lexiconHex ? { hex: lexiconHex } : {},
    sort_order: 500 + definition.options.length
  }).select("id").single();
  if (insert.error || !insert.data) fail("bulk_option_create_failed", insert.error?.message ?? `No se pudo crear la opción ${value} de ${attributeCode}.`);
  const id = String(insert.data.id);
  definition.options.push({ id, value, label, sortOrder: 500 + definition.options.length, isActive: true } as (typeof definition.options)[number]);
  createdOptions.push(`${attributeCode}:${value}`);
  return id;
}

async function ensureColorShade(
  supabase: Supabase,
  bootstrap: AdminV2Bootstrap,
  brandId: string,
  record: BulkNormalizedRecord,
  createdShades: string[]
) {
  if (!record.color) return null;
  const code = record.color.shadeCode;
  const existing = bootstrap.colorShades.find(
    (shade) => shade.brandId === brandId && shade.productLineId === null && shade.code.toLowerCase() === code.toLowerCase()
  );
  if (existing) return existing;
  const familyDefinition = bootstrap.attributes.find((attribute) => attribute.code === "color_family");
  const familyOption = familyDefinition?.options.find((option) => option.value === record.color!.colorFamilyValue);
  if (!familyOption) return null;
  const result = await supabase.rpc("create_color_shade", {
    p_brand_id: brandId,
    p_product_line_id: null,
    p_name: record.color.shadeName,
    p_code: code,
    p_color_family_option_id: familyOption.id,
    p_reference_color: record.color.referenceColor
  });
  if (result.error) fail("bulk_shade_create_failed", `${record.color.shadeName}: ${result.error.message}`);
  const shadeId = String(result.data);
  const shadeRow = await supabase.from("color_shades").select("id, tone_option_id").eq("id", shadeId).single();
  if (shadeRow.error) fail("bulk_shade_read_failed", shadeRow.error.message);
  const shade = {
    id: shadeId,
    brandId,
    productLineId: null,
    name: record.color.shadeName,
    code,
    toneOptionId: String(shadeRow.data.tone_option_id),
    colorFamilyOptionId: familyOption.id,
    referenceColor: record.color.referenceColor
  };
  bootstrap.colorShades.push(shade);
  createdShades.push(`${record.identity.brandSlug}/${code}`);
  return shade;
}

function variantSkuFor(record: BulkNormalizedRecord): string {
  if (record.identity.internalCode) return record.identity.internalCode;
  // Determinista y sin colisiones: hash del eje completo, no su cola (todas las
  // claves de un clúster terminan igual — «presentation150gr» — y chocarían).
  const suffix = record.grouping.variantKey === "unica"
    ? "UNICA"
    : createHash("sha1").update(record.grouping.variantKey).digest("hex").slice(0, 6).toUpperCase();
  return `${record.grouping.productCode}-${suffix}`;
}

export async function commitBulkBatch(
  supabase: Supabase,
  userId: string,
  batchId: string,
  confirmation: string
): Promise<BulkCommitReport> {
  if (confirmation !== "IMPORTAR LOTE") {
    throw new HttpError(422, "bulk_commit_confirmation_required", "Escribe IMPORTAR LOTE para confirmar el commit.");
  }
  const startedAt = Date.now();
  const batch = await supabase.from("import_batches").select("id, source_name, status, summary, total_rows").eq("id", batchId).single();
  if (batch.error || !batch.data) fail("bulk_batch_not_found", batch.error?.message ?? "Lote no encontrado.");
  if (!["approved", "normalized", "needs_review", "committed", "failed"].includes(String(batch.data.status))) {
    throw new HttpError(422, "bulk_batch_not_committable", `El lote está en estado ${batch.data.status}.`);
  }

  const rowsResult = await supabase
    .from("import_rows")
    .select("id, row_number, status, proposed_action, normalized_data, import_issues(severity, status)")
    .eq("batch_id", batchId)
    .order("row_number");
  if (rowsResult.error) fail("bulk_commit_read_failed", rowsResult.error.message);

  const staged: StagedRow[] = [];
  const rechazadas: BulkCommitReport["rechazadas"] = [];
  let duplicadosEvitados = 0;
  for (const row of rowsResult.data ?? []) {
    const record = row.normalized_data as unknown as BulkNormalizedRecord;
    if (row.status === "committed") continue; // idempotencia: jamás reprocesar
    if (row.status === "skipped" || record.action === "skip") {
      duplicadosEvitados += 1;
      continue;
    }
    if (row.status !== "approved") {
      rechazadas.push({ row: Number(row.row_number), reason: `Fila en estado ${row.status}; solo se importan filas aprobadas.` });
      continue;
    }
    const openBlocking = (row.import_issues ?? []).some((issue) => issue.status === "open" && (issue.severity === "error" || issue.severity === "blocking"));
    if (openBlocking) {
      rechazadas.push({ row: Number(row.row_number), reason: "Tiene incidencias abiertas de severidad error/bloqueo." });
      continue;
    }
    staged.push({ id: String(row.id), rowNumber: Number(row.row_number), record });
  }
  if (!staged.length) {
    throw new HttpError(422, "bulk_commit_nothing_to_do", "El lote no tiene filas aprobadas pendientes de importar.");
  }

  const bootstrap = await getCatalogV2Bootstrap(supabase);
  const company = await supabase.from("companies").select("id").limit(1).single();
  if (company.error || !company.data) fail("bulk_company_missing", "No existe la empresa base para registrar proveedores.");
  const companyId = String(company.data.id);

  const supplierCache = new Map<string, string>();
  const createdBrands = new Set<string>();
  const createdOptions: string[] = [];
  const createdShades: string[] = [];
  const counts: BulkBatchCounts = {
    filasProcesadas: 0,
    productosNuevos: 0,
    productosReutilizados: 0,
    variantesCreadas: 0,
    duplicadosEvitados,
    imagenesExactas: 0,
    imagenesAltaConfianza: 0,
    imagenesEnRevision: 0,
    imagenesFaltantes: 0,
    variantesConColorRespaldo: 0,
    filasRechazadas: rechazadas.length,
    issues: 0,
    duracionMs: 0
  };
  const productosReporte: BulkCommitReport["productos"] = [];

  // Clústeres en orden de aparición.
  const clusters = new Map<string, StagedRow[]>();
  for (const item of staged) {
    clusters.set(item.record.grouping.productKey, [...(clusters.get(item.record.grouping.productKey) ?? []), item]);
  }

  await supabase.from("import_batches").update({ status: "parsing" }).eq("id", batchId);

  for (const [, members] of clusters) {
    const head = members[0].record;
    try {
      const template = bootstrap.templates.find((entry) => entry.code === head.classification.templateCode);
      const category = bootstrap.categories.find((entry) => entry.path === head.classification.categoryPath);
      if (!template || !category) {
        throw new Error(`Familia sin plantilla/categoría resuelta (${head.classification.familia ?? "sin familia"}).`);
      }
      const brandId = await ensureBrand(supabase, bootstrap, head, createdBrands);
      await ensureBrandTemplate(supabase, bootstrap, brandId, template.id);

      // Tonos y opciones de ejes antes de armar el producto.
      for (const member of members) {
        for (const axis of member.record.grouping.axes) {
          if (axis.code === "tone" || axis.code === "presentation") continue;
          await ensureAttributeOption(supabase, bootstrap, axis.code, axis.value, axis.label, createdOptions);
        }
        if (member.record.color) await ensureColorShade(supabase, bootstrap, brandId, member.record, createdShades);
      }

      const existingProduct = await supabase.from("products").select("id").eq("code", head.grouping.productCode).maybeSingle();
      if (existingProduct.error) fail("bulk_product_lookup_failed", existingProduct.error.message);

      const templateAxisIds = new Map(template.attributes.filter((attribute) => attribute.isVariantAxis || attribute.scope !== "product").map((attribute) => [attribute.code, attribute.id]));
      const buildVariant = (member: StagedRow, sortOrder: number, isDefault: boolean) => {
        const record = member.record;
        const attributes: AdminV2ProductInput["variants"][number]["attributes"] = [];
        let colorShadeId: string | null = null;
        for (const axis of record.grouping.axes) {
          if (axis.code === "presentation") continue;
          if (axis.code === "tone") {
            const shade = bootstrap.colorShades.find(
              (entry) => entry.brandId === brandId && entry.productLineId === null && entry.code.toLowerCase() === axis.value.toLowerCase()
            );
            if (shade) {
              colorShadeId = shade.id;
              const toneDefinitionId = templateAxisIds.get("tone");
              if (toneDefinitionId) attributes.push({ attributeDefinitionId: toneDefinitionId, optionId: shade.toneOptionId });
              const familyDefinitionId = templateAxisIds.get("color_family");
              if (familyDefinitionId) attributes.push({ attributeDefinitionId: familyDefinitionId, optionId: shade.colorFamilyOptionId });
            }
            continue;
          }
          const definition = bootstrap.attributes.find((attribute) => attribute.code === axis.code);
          const option = definition?.options.find((entry) => entry.value.toLowerCase() === axis.value.toLowerCase());
          if (definition && option && templateAxisIds.has(axis.code)) {
            attributes.push({ attributeDefinitionId: definition.id, optionId: option.id });
          }
        }
        const exactMedia = record.media.matches.find((match) => match.target === "variant" && match.confidence !== "review");
        return {
          sku: variantSkuFor(record),
          name: record.grouping.variantName === "Única" ? record.grouping.productName : record.grouping.variantName,
          variantKey: record.grouping.variantKey,
          availability: "consult" as const,
          isDefault,
          isActive: true,
          sortOrder,
          retailPrice: null,
          wholesalePrice: null,
          wholesaleMinimum: 3,
          attributes,
          colorShadeId,
          mediaPath: exactMedia?.storagePath ?? null
        };
      };

      let productId: string;
      let created = false;
      let variantsAdded = 0;

      // Un clúster puede traer la MISMA variante en varias filas (segunda oferta
      // de proveedor): la variante se crea una vez y las demás filas solo enlazan.
      const uniqueMembers: StagedRow[] = [];
      const seenKeys = new Set<string>();
      for (const member of members) {
        const key = member.record.grouping.variantKey.toLowerCase();
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueMembers.push(member);
      }

      if (existingProduct.data) {
        // Producto ya existente: solo variantes/ofertas nuevas sobre él.
        productId = String(existingProduct.data.id);
        const current = await getCatalogV2Product(supabase, productId);
        const currentKeys = new Set(current.variants.map((variant) => variant.variantKey.toLowerCase()));
        const currentSkus = new Set(current.variants.map((variant) => variant.sku.toLowerCase()));
        const additions = uniqueMembers.filter((member) => {
          const sku = variantSkuFor(member.record).toLowerCase();
          return !currentKeys.has(member.record.grouping.variantKey.toLowerCase()) && !currentSkus.has(sku);
        });
        if (additions.length) {
          const input: AdminV2ProductInput = {
            id: productId,
            code: current.code,
            slug: current.slug,
            brandId: current.brandId,
            productLineId: current.productLineId,
            categoryId: current.categoryId,
            templateId: current.templateId,
            name: current.name,
            shortDescription: current.shortDescription,
            description: current.description,
            editorialStatus: current.editorialStatus,
            isActive: current.isActive,
            isFeatured: current.isFeatured,
            productAttributes: current.productAttributes,
            variants: [
              ...current.variants,
              ...additions.map((member, index) => buildVariant(member, current.variants.length + index, false))
            ],
            media: current.media,
            relations: [],
            wholesaleMixingPolicy: current.wholesaleMixingPolicy
          };
          await saveCatalogV2Product(supabase, input, productId);
          variantsAdded = additions.length;
        }
        counts.productosReutilizados += 1;
      } else {
        const productMedia = head.media.matches
          .filter((match) => match.target === "product")
          .map((match, index) => ({
            path: match.storagePath,
            role: match.role === "main" ? ("main" as const) : ("gallery" as const),
            mimeType: match.storagePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/webp",
            altText: null,
            sortOrder: index,
            isPrimary: match.role === "main"
          }));
        const input: AdminV2ProductInput = {
          code: head.grouping.productCode,
          slug: head.grouping.productSlug,
          brandId,
          productLineId: null,
          categoryId: category.id,
          templateId: template.id,
          name: head.grouping.productName,
          shortDescription: null,
          description: head.naming.originalDescription,
          editorialStatus: "draft",
          isActive: true,
          isFeatured: false,
          productAttributes: [],
          variants: uniqueMembers.map((member, index) => buildVariant(member, index, index === 0)),
          media: productMedia,
          relations: [],
          wholesaleMixingPolicy: "same_product"
        };
        const product = await saveCatalogV2Product(supabase, input);
        productId = product.id;
        created = true;
        counts.productosNuevos += 1;
        variantsAdded = uniqueMembers.length;
      }

      // Vínculos de proveedor + marcadores de deuda de medios, por variante.
      const variantRows = await supabase.from("product_variants").select("id, sku, variant_key").eq("product_id", productId);
      if (variantRows.error) fail("bulk_variant_read_failed", variantRows.error.message);
      const variantBySku = new Map((variantRows.data ?? []).map((variant) => [String(variant.sku ?? "").toLowerCase(), variant]));
      const variantByKey = new Map((variantRows.data ?? []).map((variant) => [String(variant.variant_key).toLowerCase(), variant]));

      let productHasMainMedia = head.media.matches.some((match) => match.target === "product" && match.role === "main");
      if (!created) {
        const existingMedia = await supabase.from("product_media").select("id").eq("product_id", productId).limit(1);
        productHasMainMedia = productHasMainMedia || Boolean(existingMedia.data?.length);
      }
      if (!productHasMainMedia) {
        await supabase.from("products").update({ media_backfill: "pending" }).eq("id", productId).is("media_backfill", null);
      }

      for (const member of members) {
        const record = member.record;
        const variant = variantBySku.get(variantSkuFor(record).toLowerCase()) ?? variantByKey.get(record.grouping.variantKey.toLowerCase());
        if (!variant) {
          rechazadas.push({ row: member.rowNumber, reason: "La variante no quedó registrada tras el commit; revisar manualmente." });
          await supabase.from("import_rows").update({ status: "failed" }).eq("id", member.id);
          continue;
        }
        if (record.supplier?.name) {
          const supplierId = await ensureSupplier(supabase, supplierCache, companyId, record.supplier.name);
          const links = await supabase.from("product_suppliers").select("id, supplier_id, is_preferred").eq("variant_id", variant.id).eq("is_active", true);
          if (links.error) fail("bulk_supplier_link_lookup_failed", links.error.message);
          const already = (links.data ?? []).some((link) => String(link.supplier_id) === supplierId);
          if (!already) {
            // La regla de dominio exige un preferido cuando hay ofertas activas:
            // la primera oferta del lote queda como preferida.
            const hasPreferred = (links.data ?? []).some((link) => link.is_preferred);
            const insert = await supabase.from("product_suppliers").insert({
              supplier_id: supplierId,
              scope_type: "variant",
              variant_id: variant.id,
              supplier_sku: record.supplier.supplierSku,
              is_preferred: !hasPreferred
            });
            if (insert.error) fail("bulk_supplier_link_failed", insert.error.message);
          }
        }
        if (record.media.backfill) {
          await supabase.from("product_variants").update({ media_backfill: record.media.backfill }).eq("id", variant.id).is("media_backfill", null);
        }
        switch (record.media.status) {
          case "exact": counts.imagenesExactas += 1; break;
          case "high": counts.imagenesAltaConfianza += 1; break;
          case "review": counts.imagenesEnRevision += 1; break;
          case "color_fallback": counts.variantesConColorRespaldo += 1; break;
          default: counts.imagenesFaltantes += 1;
        }
        counts.filasProcesadas += 1;
        await supabase.from("import_rows").update({
          status: "committed",
          target_product_id: productId,
          target_variant_id: variant.id
        }).eq("id", member.id);
      }
      counts.variantesCreadas += variantsAdded;
      productosReporte.push({ id: productId, code: head.grouping.productCode, name: head.grouping.productName, created, variants: variantsAdded });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fallo desconocido al importar el clúster.";
      for (const member of members) {
        rechazadas.push({ row: member.rowNumber, reason: message });
        await supabase.from("import_rows").update({ status: "failed" }).eq("id", member.id);
        const issue = await supabase.from("import_issues").insert({
          import_row_id: member.id,
          issue_code: "bulk_commit_failed",
          severity: "error",
          message
        });
        if (issue.error) break;
      }
    }
  }

  counts.filasRechazadas = rechazadas.length;
  const openIssues = await supabase
    .from("import_issues")
    .select("id, import_rows!inner(batch_id)", { count: "exact", head: true })
    .eq("import_rows.batch_id", batchId)
    .eq("status", "open");
  counts.issues = openIssues.count ?? 0;
  counts.duracionMs = Date.now() - startedAt;

  const summary = {
    ...(batch.data.summary as Record<string, unknown>),
    reporte: counts,
    marcasCreadas: [...createdBrands],
    opcionesCreadas: createdOptions,
    tonosCreados: createdShades,
    commitPor: userId,
    commitAt: new Date().toISOString()
  };
  const failedRows = rechazadas.length;
  await supabase.from("import_batches").update({
    status: failedRows && !counts.filasProcesadas ? "failed" : "committed",
    processed_rows: counts.filasProcesadas,
    error_rows: failedRows,
    committed_at: new Date().toISOString(),
    summary
  }).eq("id", batchId);

  const loteName = ((batch.data.summary as { lote?: string })?.lote) ?? String(batch.data.source_name).replace(`${SOURCE_PREFIX}:`, "");
  return { batchId, loteName, counts, productos: productosReporte, rechazadas };
}

// ---------------------------------------------------------------------------
// Conciliación posterior de imágenes: un lote ya importado adopta los archivos
// que llegaron después (ZIP de medios), sin tocar productos ni variantes.
// Solo adopta coincidencias exact/high; las review siguen siendo humanas.
// ---------------------------------------------------------------------------

export async function syncBulkBatchMedia(supabase: Supabase, batchId: string) {
  const rowsResult = await supabase
    .from("import_rows")
    .select("id, row_number, status, normalized_data, target_product_id, target_variant_id")
    .eq("batch_id", batchId)
    .eq("status", "committed");
  if (rowsResult.error) fail("bulk_media_sync_read_failed", rowsResult.error.message);
  const rows = (rowsResult.data ?? []).filter((row) => row.target_product_id);
  if (!rows.length) {
    throw new HttpError(422, "bulk_media_sync_nothing", "El lote no tiene filas importadas sobre las que conciliar imágenes.");
  }

  const index = await indexCatalogAssets(supabase);
  const byProduct = new Map<string, Array<{ row: (typeof rows)[number]; record: BulkNormalizedRecord }>>();
  for (const row of rows) {
    const record = JSON.parse(JSON.stringify(row.normalized_data)) as BulkNormalizedRecord;
    byProduct.set(record.grouping.productKey, [...(byProduct.get(record.grouping.productKey) ?? []), { row, record }]);
  }

  const ensureAsset = async (storagePath: string) => {
    const upsert = await supabase.from("media_assets").upsert({
      bucket: "catalog-assets",
      storage_path: storagePath,
      file_name: storagePath.split("/").pop() ?? storagePath,
      mime_type: storagePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/webp"
    }, { onConflict: "bucket,storage_path" }).select("id").single();
    if (upsert.error || !upsert.data) fail("bulk_media_asset_failed", upsert.error?.message ?? storagePath);
    return String(upsert.data.id);
  };

  let variantesConImagen = 0;
  let productosConImagen = 0;
  let sinCambio = 0;

  for (const cluster of byProduct.values()) {
    matchClusterMedia(cluster.map((entry) => entry.record), index);
    const head = cluster[0];
    const productId = String(head.row.target_product_id);

    const productMain = head.record.media.matches.find((match) => match.target === "product" && match.role === "main");
    if (productMain) {
      const existing = await supabase.from("product_media").select("id").eq("product_id", productId).eq("media_role", "main").limit(1);
      if (existing.error) fail("bulk_media_sync_lookup_failed", existing.error.message);
      if (!existing.data?.length) {
        const assetId = await ensureAsset(productMain.storagePath);
        const insert = await supabase.from("product_media").insert({ product_id: productId, media_asset_id: assetId, media_role: "main", is_primary: true });
        if (insert.error) fail("bulk_media_sync_link_failed", insert.error.message);
        productosConImagen += 1;
      }
    }

    for (const { row, record } of cluster) {
      if (!row.target_variant_id) continue;
      const match = record.media.matches.find((entry) => entry.target === "variant" && entry.confidence !== "review");
      if (!match) {
        sinCambio += 1;
        continue;
      }
      const variantId = String(row.target_variant_id);
      const existing = await supabase.from("product_media").select("id").eq("variant_id", variantId).limit(1);
      if (existing.error) fail("bulk_media_sync_lookup_failed", existing.error.message);
      if (existing.data?.length) {
        sinCambio += 1;
        continue;
      }
      const assetId = await ensureAsset(match.storagePath);
      const insert = await supabase.from("product_media").insert({
        variant_id: variantId,
        media_asset_id: assetId,
        media_role: match.role === "swatch" ? "swatch" : "main",
        is_primary: true
      });
      if (insert.error) fail("bulk_media_sync_link_failed", insert.error.message);
      variantesConImagen += 1;
    }
  }

  const batch = await supabase.from("import_batches").select("summary").eq("id", batchId).single();
  if (!batch.error && batch.data) {
    await supabase.from("import_batches").update({
      summary: {
        ...(batch.data.summary as Record<string, unknown>),
        mediaSync: { variantesConImagen, productosConImagen, sinCambio, at: new Date().toISOString() }
      }
    }).eq("id", batchId);
  }
  return { variantesConImagen, productosConImagen, sinCambio };
}

// ---------------------------------------------------------------------------
// Reporte del lote: contadores + issues navegables hasta la fila original.
// ---------------------------------------------------------------------------

export async function bulkBatchReport(supabase: Supabase, batchId: string) {
  const batch = await supabase
    .from("import_batches")
    .select("id, source_name, original_file_name, status, total_rows, processed_rows, error_rows, committed_at, summary, created_at")
    .eq("id", batchId)
    .single();
  if (batch.error || !batch.data) fail("bulk_batch_not_found", batch.error?.message ?? "Lote no encontrado.");
  const issues = await supabase
    .from("import_issues")
    .select("id, issue_code, severity, field_name, message, status, import_rows!inner(id, batch_id, row_number, status, raw_data)")
    .eq("import_rows.batch_id", batchId)
    .order("created_at");
  if (issues.error) fail("bulk_report_issues_failed", issues.error.message);
  return {
    batch: batch.data,
    issues: (issues.data ?? []).map((issue) => ({
      id: String(issue.id),
      code: issue.issue_code,
      severity: issue.severity,
      field: issue.field_name,
      message: issue.message,
      status: issue.status,
      row: Number((issue.import_rows as unknown as { row_number: number }).row_number),
      rowStatus: (issue.import_rows as unknown as { status: string }).status,
      original: (issue.import_rows as unknown as { raw_data: Record<string, unknown> }).raw_data
    }))
  };
}
