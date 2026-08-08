// Lote piloto del importador masivo contra Supabase LOCAL.
//
// Ejercita los casos difíciles del bloque con FILAS REALES del listado:
//   producto simple · producto sin código · descripción duplicada (mismo y
//   distinto proveedor) · varias variantes (tonos, aromas+gramajes, medidas)
//   · colores · producto con imagen · variante con imagen distinta · producto
//   sin imagen · color como respaldo · posible duplicado.
// Y verifica el contrato central: ejecutar dos veces NO duplica nada.
//
// Uso:
//   npm run test:bulk-import-pilot            (limpia al final)
//   npm run test:bulk-import-pilot -- --keep  (deja el lote para inspección)
//   npm run test:bulk-import-pilot -- --listado "F:\\ruta\\al\\Listado.xlsx"

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "test-bulk-import-pilot" });
if (!isLocal) throw new Error("El piloto solo puede ejecutarse contra Supabase local.");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const [{ parseCatalogXlsxRaw }, bulkService, { mapListingRows, normalizeListing }] = await Promise.all([
  import("../src/lib/admin/catalog-import-xlsx.ts"),
  import("../src/lib/admin/catalog-bulk-import/service.ts"),
  import("../src/lib/admin/catalog-bulk-import/normalize.ts")
]);
const { stageBulkImportBatch, approveBulkBatch, commitBulkBatch, buildBulkPreview, bulkBatchReport, syncBulkBatchMedia } = bulkService;

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const listadoArg = args.indexOf("--listado");
const listadoPath = listadoArg >= 0
  ? args[listadoArg + 1]
  : "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\Listado_organizado_productos_Bellaroshe.xlsx";

const LOTE = "piloto-01";
const FAMILIAS = [
  "Accesorios y protección de peluquería",   // simples, sin código, CROCODILE ×2 proveedores
  "Ceras depilatorias",                       // aromas + gramajes, fila sin código (KONSUNG 300GR)
  "Guantes y protección",                     // tallas S/M/L, colores
  "Extensiones profesionales 1x1/volumen",    // medidas MM, SMALL/MEDIUM/LONG
  "Press on y uñas decoradas",                // duplicado exacto BELLESPA, formas
  "Esmaltes tradicionales y gel"              // tonos ADMISS/MASGLO (descripción = tono)
];

// WebP 1×1 válido para las pruebas de conciliación.
const TINY_WEBP = Buffer.from("UklGRiYAAABXRUJQVlA4TBoAAAAvAAAAEAcQERGIiP4HAA==", "base64");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const email = `bulk-pilot-${stamp}@local.invalid`;
const password = `Bulk-${stamp}-Only!`;

let userId;
const uploadedPaths = [];
const batchIds = [];
const pilotProductCodes = new Set();
const log = (label, value) => console.log(`\n== ${label} ==\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

async function cleanup() {
  if (keep) {
    console.log("\n[keep] Se conserva el lote para inspección manual (limpia luego con cleanup-v2-test-data).");
    return;
  }
  const batches = await service.from("import_batches").select("id").like("source_name", "bulk_catalog_v2:piloto-%");
  const ids = (batches.data ?? []).map((batch) => batch.id);
  const productIds = new Set();
  if (ids.length) {
    const rows = await service.from("import_rows").select("target_product_id").in("batch_id", ids).not("target_product_id", "is", null);
    for (const row of rows.data ?? []) productIds.add(row.target_product_id);
  }
  // Primero los lotes: import_rows referencia products y bloquearía el borrado.
  if (ids.length) {
    const dropBatches = await service.from("import_batches").delete().in("id", ids);
    if (dropBatches.error) console.error(`[cleanup] lotes: ${dropBatches.error.message}`);
  }
  // Los códigos son deterministas: también barre clústeres que fallaron a medias.
  for (let offset = 0; offset < pilotProductCodes.size; offset += 60) {
    const chunk = [...pilotProductCodes].slice(offset, offset + 60);
    const byCode = await service.from("products").select("id").in("code", chunk);
    for (const product of byCode.data ?? []) productIds.add(product.id);
  }
  if (productIds.size) {
    const list = [...productIds];
    const variants = await service.from("product_variants").select("id").in("product_id", list);
    const variantIds = (variants.data ?? []).map((variant) => variant.id);
    for (let offset = 0; offset < variantIds.length; offset += 80) {
      const drop = await service.from("product_suppliers").delete().in("variant_id", variantIds.slice(offset, offset + 80));
      if (drop.error) console.error(`[cleanup] ofertas: ${drop.error.message}`);
    }
    await service.from("wholesale_rules").delete().in("product_id", list);
    for (let offset = 0; offset < list.length; offset += 80) {
      const drop = await service.from("products").delete().in("id", list.slice(offset, offset + 80));
      if (drop.error) console.error(`[cleanup] productos: ${drop.error.message}`);
    }
  }
  for (const storagePath of uploadedPaths) {
    await service.storage.from("catalog-assets").remove([storagePath]);
  }
  await service.from("media_assets").delete().in("storage_path", uploadedPaths);
  // Marcas, proveedores, tonos y opciones creados por el piloto quedan como
  // datos reutilizables SOLO con --keep; sin él, se retiran los del lote.
  const shades = await service.from("color_shades").select("id, tone_option_id, brands!inner(slug)").eq("brands.slug", "admiss");
  for (const shade of shades.data ?? []) {
    await service.from("color_shades").delete().eq("id", shade.id);
    if (shade.tone_option_id) await service.from("attribute_options").delete().eq("id", shade.tone_option_id);
  }
  if (userId) await service.auth.admin.deleteUser(userId);
}

try {
  // --- Guard: el piloto borra por códigos deterministas al limpiar. Si alguna
  // de sus familias ya fue importada por un lote REAL, esos códigos coinciden y
  // la limpieza destruiría datos de verdad. En ese caso el piloto no corre.
  const committedReal = await service
    .from("import_batches")
    .select("id, source_name, summary")
    .like("source_name", "bulk_catalog_v2:%")
    .not("source_name", "like", "bulk_catalog_v2:piloto-%")
    .eq("status", "committed");
  const overlapping = (committedReal.data ?? []).filter((batch) => {
    const familias = (batch.summary?.familias ?? []);
    return familias.some((familia) => FAMILIAS.includes(familia));
  });
  if (overlapping.length) {
    console.log(`[skip] Hay lotes reales committed con familias del piloto (${overlapping.map((batch) => batch.source_name).join(", ")}); el piloto no corre para no tocar datos reales.`);
    process.exit(0);
  }

  // --- Usuario desarrollador -------------------------------------------------
  const createdUser = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error) throw createdUser.error;
  userId = createdUser.data.user.id;
  const profile = await service.from("admin_profiles").insert({ id: userId, role: "developer", full_name: "Piloto import masivo" });
  if (profile.error) throw profile.error;
  const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const login = await developer.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;

  // --- Listado real ----------------------------------------------------------
  const bytes = await fs.readFile(listadoPath).catch(() => null);
  if (!bytes) {
    console.log(`[skip] No se encontró el listado real en ${listadoPath}; el piloto necesita el Excel.`);
    process.exit(0);
  }
  const workbook = await parseCatalogXlsxRaw({
    name: path.basename(listadoPath),
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });

  // --- Fixtures de imagen: producto ADMISS con main + un tono exacto --------
  const { rows: allRows } = mapListingRows(workbook.sheets);
  const pilotRows = allRows.filter((row) => row.familia && FAMILIAS.includes(row.familia.trim()));
  const { records: preRecords } = normalizeListing(pilotRows);
  const admissTones = preRecords.filter((record) => record.identity.brandSlug === "admiss" && record.grouping.axes.some((axis) => axis.code === "tone"));
  assert.ok(admissTones.length >= 3, "El piloto debe contener esmaltes ADMISS con tonos suficientes");
  const admiss = admissTones[0];
  const admissCode = admiss.grouping.productCode;
  const admissTone = admiss.grouping.axes.find((axis) => axis.code === "tone").value;
  // El fixture por código interno usa OTRA fila, para que exact-por-tono y
  // exact-por-código se cuenten por separado.
  const admissInternalRecord = admissTones.find((record) => record.identity.internalCode && record.source.row !== admiss.source.row);
  const admissInternal = admissInternalRecord?.identity.internalCode;
  // Y la conciliación tardía usa una TERCERA fila que quedó sin imagen.
  const lateToneRecord = admissTones.find((record) => record.source.row !== admiss.source.row && record.source.row !== admissInternalRecord?.source.row);

  for (const storagePath of [
    `productos/${admissCode}/main.webp`,
    `productos/${admissCode}/tonos/${admissTone}.webp`,
    ...(admissInternal ? [`productos/${admissInternal}.webp`] : [])
  ]) {
    const upload = await service.storage.from("catalog-assets").upload(storagePath, TINY_WEBP, { contentType: "image/webp", upsert: true });
    if (upload.error) throw new Error(`No se pudo subir el fixture ${storagePath}: ${upload.error.message}`);
    uploadedPaths.push(storagePath);
  }

  // --- PASE 1: preview → aprobar limpias → aprobar revisión → commit --------
  const t0 = Date.now();
  const preview1 = await stageBulkImportBatch(developer, userId, workbook, { name: LOTE, familias: FAMILIAS });
  batchIds.push(preview1.batchId);
  log("PREVIEW lote piloto", {
    filas: preview1.totalRows,
    productosPropuestos: preview1.productos.length,
    porAccion: preview1.porAccion,
    porEstadoFila: preview1.porEstadoFila,
    excepciones: preview1.excepciones.length,
    issuesAbiertos: preview1.issuesAbiertos
  });

  // Casos difíciles visibles en el staging:
  const crocodile = preview1.productos.find((producto) => producto.productName.toLowerCase().includes("cocodrilo"));
  assert.ok(crocodile, "CROCODILE (misma descripción, dos proveedores) debe estar en el lote");
  const excepcionesFilas = new Set(preview1.excepciones.map((excepcion) => excepcion.row));
  assert.ok(preview1.excepciones.length > 0, "El piloto debe producir excepciones para revisar");
  const admissPreview = preview1.productos.find((producto) => producto.productCode === admissCode);
  assert.ok(admissPreview && admissPreview.variantCount > 20, `ADMISS debe agrupar decenas de tonos como variantes (obtuvo ${admissPreview?.variantCount})`);
  assert.ok(admissPreview.mediaStatus.exact >= 1, "El tono ADMISS con archivo en tonos/ debe conciliar exact");
  const conRespaldo = preview1.productos.reduce((sum, producto) => sum + producto.mediaStatus.color_fallback, 0);
  assert.ok(conRespaldo > 0, "Debe existir al menos una variante con color como respaldo");
  const sinImagen = preview1.productos.reduce((sum, producto) => sum + producto.mediaStatus.missing, 0);
  assert.ok(sinImagen > 0, "Debe existir deuda media_pending visible");

  const approve1 = await approveBulkBatch(developer, preview1.batchId, { includeReview: true });
  log("APROBACIÓN masiva (incluye revisión)", approve1);

  for (const producto of preview1.productos) pilotProductCodes.add(producto.productCode);
  const commit1 = await commitBulkBatch(developer, userId, preview1.batchId, "IMPORTAR LOTE");
  log("REPORTE lote piloto (pase 1)", commit1.counts);
  if (commit1.rechazadas.length) log("RECHAZADAS (muestra)", commit1.rechazadas.slice(0, 6));
  assert.ok(commit1.counts.productosNuevos > 0, "El pase 1 debe crear productos");
  assert.ok(commit1.counts.variantesCreadas > commit1.counts.productosNuevos, "Debe haber más variantes que productos (agrupamiento real)");
  assert.ok(commit1.counts.duplicadosEvitados > 0, "El duplicado BELLESPA debe evitarse");
  assert.ok(commit1.counts.imagenesExactas >= 2, "main + tono + código interno deben conciliar exact");
  assert.ok(commit1.counts.variantesConColorRespaldo > 0, "Debe registrarse el respaldo por color");

  // Deuda de medios persistida y honesta:
  const debtVariants = await service.from("product_variants").select("id", { count: "exact", head: true }).eq("media_backfill", "pending");
  const colorVariants = await service.from("product_variants").select("id", { count: "exact", head: true }).eq("media_backfill", "color");
  assert.ok((debtVariants.count ?? 0) > 0, "media_backfill=pending debe quedar en variantes sin imagen ni color");
  assert.ok((colorVariants.count ?? 0) > 0, "media_backfill=color debe quedar en variantes con swatch temporal");

  // Ofertas multi-proveedor (CROCODILE): una variante, dos product_suppliers.
  const crocodileRows = await service
    .from("product_variants")
    .select("id, product_id, products!inner(name), product_suppliers(id)")
    .ilike("products.name", "%cocodrilo%");
  const crocodileVariant = (crocodileRows.data ?? []).find((variant) => (variant.product_suppliers ?? []).length >= 2);
  assert.ok(crocodileVariant, "La variante CROCODILE debe terminar con dos ofertas de proveedor");

  // Navegación issue → fila original del Excel:
  const report1 = await bulkBatchReport(developer, preview1.batchId);
  const issueConFila = report1.issues.find((issue) => issue.original && issue.original.descripcion);
  assert.ok(issueConFila, "Cada issue debe poder abrirse hasta la fila original del Excel");

  // --- PASE 2: mismo lote otra vez → cero duplicados -------------------------
  const before = await Promise.all([
    service.from("products").select("id", { count: "exact", head: true }),
    service.from("product_variants").select("id", { count: "exact", head: true }),
    service.from("product_suppliers").select("id", { count: "exact", head: true }),
    service.from("media_assets").select("id", { count: "exact", head: true })
  ]);
  const preview2 = await stageBulkImportBatch(developer, userId, workbook, { name: LOTE, familias: FAMILIAS });
  batchIds.push(preview2.batchId);
  assert.notEqual(preview2.batchId, preview1.batchId, "El re-envío tras commit debe abrir un lote nuevo (historial intacto)");
  log("PREVIEW pase 2 (idempotencia)", { porAccion: preview2.porAccion, porEstadoFila: preview2.porEstadoFila });
  assert.equal(preview2.porAccion.create_product, 0, "Nada debe proponerse como producto nuevo en el pase 2");

  await approveBulkBatch(developer, preview2.batchId, { includeReview: true });
  const commit2 = await commitBulkBatch(developer, userId, preview2.batchId, "IMPORTAR LOTE").catch((error) => {
    // Si todas las filas quedaron omitidas, el commit responde «nada que hacer»: también es idempotencia válida.
    if (error?.code === "bulk_commit_nothing_to_do") return { counts: { productosNuevos: 0, variantesCreadas: 0, duplicadosEvitados: -1 } };
    throw error;
  });
  log("REPORTE pase 2", commit2.counts);
  const after = await Promise.all([
    service.from("products").select("id", { count: "exact", head: true }),
    service.from("product_variants").select("id", { count: "exact", head: true }),
    service.from("product_suppliers").select("id", { count: "exact", head: true }),
    service.from("media_assets").select("id", { count: "exact", head: true })
  ]);
  assert.equal(after[0].count, before[0].count, "Pase 2: cero productos nuevos");
  assert.equal(after[1].count, before[1].count, "Pase 2: cero variantes nuevas");
  assert.equal(after[2].count, before[2].count, "Pase 2: cero ofertas duplicadas");
  assert.equal(after[3].count, before[3].count, "Pase 2: cero medios duplicados");

  // --- PASE 3: la imagen llega DESPUÉS del commit (ZIP tardío) --------------
  const lateTonePath = `productos/${admissCode}/tonos/${lateToneRecord.grouping.axes.find((axis) => axis.code === "tone").value}.webp`;
  const lateUpload = await service.storage.from("catalog-assets").upload(lateTonePath, TINY_WEBP, { contentType: "image/webp", upsert: true });
  if (lateUpload.error) throw new Error(`No se pudo subir el fixture tardío: ${lateUpload.error.message}`);
  uploadedPaths.push(lateTonePath);

  const sync = await syncBulkBatchMedia(developer, preview1.batchId);
  log("CONCILIACIÓN tardía de imágenes", sync);
  assert.ok(sync.variantesConImagen >= 1, "El tono subido tras el commit debe adoptarse");
  const lateVariant = await service
    .from("product_variants")
    .select("id, media_backfill, product_media(id)")
    .eq("product_id", (await service.from("products").select("id").eq("code", admissCode).single()).data.id)
    .not("product_media", "is", null);
  const adopted = (lateVariant.data ?? []).filter((variant) => (variant.product_media ?? []).length > 0);
  assert.ok(adopted.length >= 1, "La variante adoptada debe tener product_media");
  assert.ok(adopted.every((variant) => variant.media_backfill === null), "La deuda media_backfill debe limpiarse sola al adoptar la imagen");

  log("RESULTADO", `Piloto completo en ${((Date.now() - t0) / 1000).toFixed(1)}s. Idempotencia y conciliación tardía verificadas.`);
} finally {
  await cleanup();
}
