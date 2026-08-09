// Runner de lotes del importador masivo contra Supabase LOCAL.
// Herramienta permanente: cada lote del runbook se ejecuta por fases, con la
// revisión de excepciones como paso humano entre stage y approve.
//
// Fases (combinables, en orden):
//   --stage         parsea el Excel y deja el lote en staging; imprime TODAS
//                   las excepciones para revisarlas antes de aprobar.
//   --approve       aprueba lo limpio; con --include-review también lo marcado
//                   para revisión sin issues de error; --skip-rows 12,15 omite.
//   --commit        importa filas aprobadas, imprime el reporte obligatorio y
//                   RECONCILIA los conteos contra la BD (R1–R7).
//   --second-pass   re-ejecuta el lote completo y exige cero duplicados.
//   --media-sync    concilia imágenes llegadas después del commit.
//
// Uso típico:
//   node --conditions=react-server --experimental-transform-types scripts/run-bulk-lote.mjs \
//     --lote unas-esmaltes-01 --familias "Esmaltes tradicionales y gel;Bases, tops, brillos y finalizadores" --stage

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: root,
  scriptName: "run-bulk-lote",
  allowedFlags: ["--lote", "--familias", "--listado", "--skip-rows", "--stage", "--approve", "--include-review", "--commit", "--second-pass", "--media-sync"]
});
if (!isLocal) throw new Error("El runner de lotes solo opera contra Supabase local (el entorno de prueba/producción va por la UI).");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const [{ parseCatalogXlsxRaw }, bulkService] = await Promise.all([
  import("../src/lib/admin/catalog-import-xlsx.ts"),
  import("../src/lib/admin/catalog-bulk-import/service.ts")
]);
const { stageBulkImportBatch, approveBulkBatch, commitBulkBatch, buildBulkPreview, syncBulkBatchMedia } = bulkService;

// --- argumentos -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const loteName = option("lote");
const familias = (option("familias") ?? "").split(";").map((item) => item.trim()).filter(Boolean);
const listadoPath = option("listado") ?? "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\Listado_organizado_productos_Bellaroshe.xlsx";
const skipRows = (option("skip-rows") ?? "").split(",").map((item) => Number(item.trim())).filter(Number.isFinite);
if (!loteName) throw new Error("Falta --lote <nombre>.");

const DEV_EMAIL = "bulk-dev@local.invalid";
const DEV_PASSWORD = "Bulk-Dev-2026!";
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const login = await developer.auth.signInWithPassword({ email: DEV_EMAIL, password: DEV_PASSWORD });
if (login.error) throw new Error(`No se pudo iniciar sesión como ${DEV_EMAIL}: ${login.error.message}`);
const userId = login.data.user.id;

const log = (label, value) => console.log(`\n== ${label} ==\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

async function currentBatchId({ preferApprovedRows = false } = {}) {
  const batches = await service
    .from("import_batches")
    .select("id, status, created_at")
    .eq("source_name", `bulk_catalog_v2:${loteName}`)
    .order("created_at", { ascending: false });
  if (batches.error || !batches.data?.length) throw new Error(`No hay lote ${loteName} en staging.`);
  if (preferApprovedRows) {
    // El commit debe apuntar al lote que tiene filas aprobadas pendientes,
    // aunque un segundo pase haya abierto un lote más nuevo después.
    for (const batch of batches.data) {
      const pending = await service
        .from("import_rows")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", batch.id)
        .eq("status", "approved");
      if ((pending.count ?? 0) > 0) return String(batch.id);
    }
  }
  return String(batches.data[0].id);
}

async function loadWorkbook() {
  const bytes = await fs.readFile(listadoPath);
  return parseCatalogXlsxRaw({
    name: path.basename(listadoPath),
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });
}

function printPreview(preview) {
  log(`PREVIEW «${preview.loteName}»`, {
    batchId: preview.batchId,
    filas: preview.totalRows,
    productosPropuestos: preview.productos.length,
    porAccion: preview.porAccion,
    porEstadoFila: preview.porEstadoFila,
    issuesAbiertos: preview.issuesAbiertos,
    excepciones: preview.excepciones.length
  });
  if (preview.excepciones.length) {
    console.log("\n== EXCEPCIONES A REVISAR ==");
    for (const excepcion of preview.excepciones) {
      console.log(`\n· Fila ${excepcion.row} — ${excepcion.productCode} [${excepcion.variantKey}]`);
      console.log(`  «${excepcion.description ?? "(sin descripción)"}»`);
      for (const reason of excepcion.reasons) console.log(`  - ${reason}`);
      for (const issue of excepcion.issues) console.log(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }
}

// --- reconciliación de conteos (R1–R7) --------------------------------------
async function reconcile(batchId, report) {
  const rows = await service
    .from("import_rows")
    .select("status, proposed_action, target_product_id, target_variant_id, normalized_data, import_issues(issue_code, status)")
    .eq("batch_id", batchId);
  if (rows.error) throw rows.error;
  const data = rows.data ?? [];
  const committed = data.filter((row) => row.status === "committed");
  const byStatus = {};
  for (const row of data) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  // R1 · cada fila del lote terminó en un estado contable. Un commit puede ser
  // incremental (reintento tras corregir filas): el reporte cuenta SU pasada y
  // el lote acumula; la igualdad estricta solo aplica al primer commit.
  const contadas = (byStatus.committed ?? 0) + (byStatus.skipped ?? 0) + (byStatus.failed ?? 0) + (byStatus.needs_review ?? 0) + (byStatus.normalized ?? 0) + (byStatus.approved ?? 0);
  assert.equal(contadas, data.length, "R1: filas del lote sin estado contable");
  assert.ok((byStatus.committed ?? 0) >= report.counts.filasProcesadas, "R1: el lote tiene menos filas committed que las que el reporte dice haber procesado");

  // R2 · todo producto del reporte está entre los destinos del lote.
  const productIds = new Set(committed.map((row) => row.target_product_id).filter(Boolean));
  assert.ok(productIds.size >= report.productos.length, "R2: el lote registra menos productos destino que el reporte");
  for (const producto of report.productos) {
    assert.ok(productIds.has(producto.id), `R2: el producto ${producto.code} del reporte no aparece como destino en el lote`);
  }

  // R3 · variantes del reporte = suma por producto.
  const variantesReporte = report.productos.reduce((sum, producto) => sum + producto.variants, 0);
  assert.equal(variantesReporte, report.counts.variantesCreadas, "R3: variantesCreadas ≠ suma por producto");

  // R4 · todos los códigos del reporte existen en products.
  const codes = report.productos.map((producto) => producto.code);
  let found = 0;
  for (let offset = 0; offset < codes.length; offset += 80) {
    const check = await service.from("products").select("id", { count: "exact", head: true }).in("code", codes.slice(offset, offset + 80));
    found += check.count ?? 0;
  }
  assert.equal(found, codes.length, "R4: códigos del reporte ausentes en products");

  // R5 · toda fila committed apunta a una variante.
  assert.ok(committed.every((row) => row.target_variant_id), "R5: fila committed sin variante destino");

  // R6 · toda fila committed con eje de tono terminó con color_shade en su variante.
  const toneRows = committed.filter((row) => {
    const record = row.normalized_data;
    return record?.grouping?.axes?.some((axis) => axis.code === "tone");
  });
  const toneVariantIds = [...new Set(toneRows.map((row) => row.target_variant_id))];
  let withShade = 0;
  for (let offset = 0; offset < toneVariantIds.length; offset += 80) {
    const check = await service.from("product_variants").select("id", { count: "exact", head: true }).in("id", toneVariantIds.slice(offset, offset + 80)).not("color_shade_id", "is", null);
    withShade += check.count ?? 0;
  }
  assert.equal(withShade, toneVariantIds.length, "R6: variantes con tono sin color_shade");

  // R7 · toda fila committed con proveedor tiene su oferta enlazada, sin duplicar.
  // Excepción explicada: filas con supplier_offer_conflict — el código ya vive
  // en otra variante y el enlace se omitió a propósito, con issue que lo cuenta.
  const supplierRows = committed.filter((row) =>
    row.normalized_data?.supplier?.name
    && !(row.import_issues ?? []).some((issue) => issue.issue_code === "supplier_offer_conflict")
  );
  const supplierVariantIds = [...new Set(supplierRows.map((row) => row.target_variant_id))];
  let linked = 0;
  for (let offset = 0; offset < supplierVariantIds.length; offset += 80) {
    const chunk = supplierVariantIds.slice(offset, offset + 80);
    const links = await service.from("product_suppliers").select("variant_id, supplier_id").in("variant_id", chunk).eq("is_active", true);
    if (links.error) throw links.error;
    const perVariant = new Map();
    for (const link of links.data ?? []) {
      const key = `${link.variant_id}|${link.supplier_id}`;
      assert.ok(!perVariant.has(key), `R7: oferta duplicada ${key}`);
      perVariant.set(key, true);
    }
    linked += new Set((links.data ?? []).map((link) => link.variant_id)).size;
  }
  assert.equal(linked, supplierVariantIds.length, "R7: variantes con proveedor sin oferta enlazada");

  log("RECONCILIACIÓN R1–R7", {
    estadoFilas: byStatus,
    productosDistintos: productIds.size,
    variantesReporte,
    codigosVerificados: found,
    variantesConTono: toneVariantIds.length,
    variantesConProveedor: supplierVariantIds.length,
    verdict: "OK — reporte y BD cuentan lo mismo"
  });
}

async function snapshotCounts() {
  const tables = ["products", "product_variants", "product_suppliers", "color_shades", "media_assets", "attribute_options", "suppliers", "brands"];
  const snapshot = {};
  for (const table of tables) {
    const result = await service.from(table).select("id", { count: "exact", head: true });
    snapshot[table] = result.count ?? 0;
  }
  return snapshot;
}

// --- fases ------------------------------------------------------------------
if (flag("stage")) {
  const workbook = await loadWorkbook();
  const preview = await stageBulkImportBatch(developer, userId, workbook, {
    name: loteName,
    familias: familias.length ? familias : undefined
  });
  printPreview(preview);
}

if (flag("approve")) {
  const batchId = await currentBatchId();
  const result = await approveBulkBatch(developer, batchId, {
    includeReview: flag("include-review"),
    skipRowNumbers: skipRows.length ? skipRows : undefined
  });
  log("APROBACIÓN", result);
  printPreview(await buildBulkPreview(developer, batchId));
}

if (flag("commit")) {
  const batchId = await currentBatchId({ preferApprovedRows: true });
  const report = await commitBulkBatch(developer, userId, batchId, "IMPORTAR LOTE");
  log("REPORTE DEL LOTE", report.counts);
  if (report.rechazadas.length) log("RECHAZADAS", report.rechazadas);
  await reconcile(batchId, report);
}

if (flag("second-pass")) {
  const before = await snapshotCounts();
  const workbook = await loadWorkbook();
  const preview = await stageBulkImportBatch(developer, userId, workbook, {
    name: loteName,
    familias: familias.length ? familias : undefined
  });
  log("SEGUNDO PASE · preview", { porAccion: preview.porAccion, porEstadoFila: preview.porEstadoFila });
  assert.equal(preview.porAccion.create_product, 0, "Segundo pase: no debe proponer productos nuevos");
  await approveBulkBatch(developer, preview.batchId, { includeReview: true });
  await commitBulkBatch(developer, userId, preview.batchId, "IMPORTAR LOTE").catch((error) => {
    if (error?.code === "bulk_commit_nothing_to_do") return null;
    throw error;
  });
  const after = await snapshotCounts();
  for (const [table, count] of Object.entries(before)) {
    assert.equal(after[table], count, `Segundo pase: ${table} cambió (${count} → ${after[table]})`);
  }
  log("SEGUNDO PASE", { before, after, verdict: "CERO duplicados — ninguna tabla cambió" });
}

if (flag("media-sync")) {
  const batches = await service
    .from("import_batches")
    .select("id")
    .eq("source_name", `bulk_catalog_v2:${loteName}`)
    .eq("status", "committed")
    .order("created_at", { ascending: true });
  if (batches.error || !batches.data?.length) throw new Error(`No hay lote ${loteName} committed.`);
  const result = await syncBulkBatchMedia(developer, String(batches.data[0].id));
  log("CONCILIACIÓN DE IMÁGENES", result);
}
