// G · Caso crítico MASGLO: reconcilia el producto importado (Excel de 1,500)
// contra la fuente oficial vigente (plantilla curada de 157 tonos con SKU,
// familia y hex reales) y, con --aplicar, completa el catálogo por el staging:
//
//   node … scripts/reconcile-masglo-tradicional.mjs --env .env.supabase.local            → solo reporte
//   node … scripts/reconcile-masglo-tradicional.mjs --env .env.supabase.local --aplicar  → carga faltantes
//
// Reglas: la variante es la unidad vendible; nada se borra por no estar en una
// fuente más antigua; los tonos del Excel sin correlato oficial quedan como
// EXTRA_IN_DB documentado, no se eliminan.

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "reconcile-masglo", allowedFlags: ["--aplicar"] });
if (!isLocal) throw new Error("Solo local.");
const APLICAR = process.argv.includes("--aplicar");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});
const { parseCatalogImportXlsx } = await import("../src/lib/admin/catalog-import-xlsx.ts");
const { commitBulkBatch } = await import("../src/lib/admin/catalog-bulk-import/service.ts");
const { slugify } = await import("../src/lib/catalog/slug.ts");

const CURATED = "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\products\\01-masglo-tradicional\\plantilla_masglo_tradicional_lista_para_importar.xlsx";
const SWATCH_DIR = "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\products\\01-masglo-tradicional\\masglo_tradicional_media_envases_reales_catalog_assets\\productos\\MAS-TRA-135\\tonos";
const PRODUCT_CODE = "MAS-ESM-4C95F3";
const LOTE = "masglo-completar-01";

// Erratas del Excel de 1,500 confirmadas contra la carta oficial: el tono es el
// mismo; la grafía del Excel estaba incompleta. (Decisión documentada.)
const ERRATAS_EXCEL = new Map([
  ["trascedental", "trascendental"],
  ["suceptible", "susceptible"]
]);

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const login = await developer.auth.signInWithPassword({ email: "bulk-dev@local.invalid", password: "Bulk-Dev-2026!" });
if (login.error) throw login.error;

// --- Fuente oficial ---------------------------------------------------------
const bytes = await fs.readFile(CURATED);
const wb = await parseCatalogImportXlsx({ name: path.basename(CURATED), size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const stat = await fs.stat(CURATED);
const tonos = wb.sheets.Tonos.map((t) => ({
  row: t.__row,
  code: String(t.tone_code),
  name: String(t.tone_name),
  family: String(t.color_family_value),
  hex: String(t.reference_color),
  slug: slugify(String(t.tone_name))
}));
const variantesBySlug = new Map(wb.sheets.Variantes.map((v) => [slugify(String(v.name)), v]));

// --- BD ---------------------------------------------------------------------
const { data: product } = await service.from("products").select("id, code, name").eq("code", PRODUCT_CODE).single();
if (!product) throw new Error(`No existe el producto ${PRODUCT_CODE}.`);
const { data: dbVariants } = await service
  .from("product_variants")
  .select("id, sku, name, variant_key, color_shade_id, media_backfill, color_shades(id, code, name, color_family_option_id, reference_color)")
  .eq("product_id", product.id);
const dbBySlug = new Map();
for (const v of dbVariants ?? []) {
  const raw = (v.variant_key.match(/^tone:(.+)$/) ?? [])[1] ?? slugify(v.name);
  const slug = ERRATAS_EXCEL.get(raw) ?? raw;
  dbBySlug.set(slug, v);
}

// --- G1 · MATCH / MISSING_IN_DB / EXTRA_IN_DB -------------------------------
const officialBySlug = new Map(tonos.map((t) => [t.slug, t]));
const MATCH = [];
const MISSING_IN_DB = [];
const EXTRA_IN_DB = [];
for (const t of tonos) {
  if (dbBySlug.has(t.slug)) MATCH.push({ slug: t.slug, oficial: t.code, skuOficial: variantesBySlug.get(t.slug)?.sku ?? null, skuDB: dbBySlug.get(t.slug).sku });
  else MISSING_IN_DB.push({ slug: t.slug, oficial: t.code, name: t.name, family: t.family, hex: t.hex, skuOficial: variantesBySlug.get(t.slug)?.sku ?? null });
}
for (const [slug, v] of dbBySlug) {
  if (!officialBySlug.has(slug)) EXTRA_IN_DB.push({ slug, skuDB: v.sku, name: v.name });
}

const reporte = {
  generado: new Date().toISOString(),
  fuenteOficial: { archivo: CURATED, fechaArchivo: stat.mtime.toISOString(), tonos: tonos.length, variantes: wb.sheets.Variantes.length, hexCompletos: tonos.every((t) => t.hex) },
  productoDB: { code: product.code, variantes: (dbVariants ?? []).length },
  erratasAplicadas: [...ERRATAS_EXCEL.entries()],
  MATCH: MATCH.length,
  MISSING_IN_DB: MISSING_IN_DB.length,
  EXTRA_IN_DB,
  detalleMissing: MISSING_IN_DB.map((m) => m.slug)
};
await fs.mkdir(path.join(root, "docs", "evidencia-certificacion-1c"), { recursive: true });
await fs.writeFile(path.join(root, "docs", "evidencia-certificacion-1c", "masglo-reconciliacion.json"), JSON.stringify({ ...reporte, matchDetalle: MATCH }, null, 2), "utf8");
console.log(JSON.stringify(reporte, null, 2));

if (!APLICAR) process.exit(0);

// --- G3 · Completar por el staging (trazable) --------------------------------
// 1. Shades existentes suben a datos oficiales (código TRA, familia real, hex real).
const { data: familyDef } = await service.from("attribute_definitions").select("id").eq("code", "color_family").single();
const { data: familyOptions } = await service.from("attribute_options").select("id, value").eq("attribute_definition_id", familyDef.id);
const familyByValue = new Map(familyOptions.map((o) => [o.value, o.id]));
const shadeUpdates = [];
for (const [slug, v] of dbBySlug) {
  const official = officialBySlug.get(slug);
  if (!official || !v.color_shades) continue;
  const shade = v.color_shades;
  const familyOptionId = familyByValue.get(official.family);
  const changes = {};
  if (shade.code !== official.code) changes.code = official.code;
  if (!shade.reference_color) changes.reference_color = official.hex;
  if (familyOptionId && String(shade.color_family_option_id) !== String(familyOptionId)) changes.color_family_option_id = familyOptionId;
  if (Object.keys(changes).length) {
    const update = await service.from("color_shades").update(changes).eq("id", shade.id);
    if (update.error) throw new Error(`shade ${slug}: ${update.error.message}`);
    shadeUpdates.push({ slug, antes: { code: shade.code, family: shade.color_family_option_id, hex: shade.reference_color }, cambios: changes });
  }
}
console.log(`Shades existentes actualizadas a datos oficiales: ${shadeUpdates.length}`);

// 2. Swatches oficiales al bucket (solo los que faltan).
const files = await fs.readdir(SWATCH_DIR);
let uploaded = 0;
for (const file of files) {
  if (!file.endsWith(".webp")) continue;
  const target = `productos/${PRODUCT_CODE}/tonos/${file}`;
  const body = await fs.readFile(path.join(SWATCH_DIR, file));
  const up = await service.storage.from("catalog-assets").upload(target, body, { contentType: "image/webp", upsert: false });
  if (!up.error) uploaded += 1;
  else if (!String(up.error.message).toLowerCase().includes("already exists") && !String(up.error.message).includes("Duplicate")) {
    throw new Error(`${target}: ${up.error.message}`);
  }
}
console.log(`Swatches subidos (nuevos): ${uploaded}`);

// 3. Lote de compleción: una fila trazable por tono faltante, apuntando a la
//    fila de la plantilla curada como fuente.
if (MISSING_IN_DB.length) {
  const existing = await service.from("import_batches").select("id").eq("source_name", `bulk_catalog_v2:${LOTE}`).neq("status", "committed").maybeSingle();
  if (existing.data) await service.from("import_batches").delete().eq("id", existing.data.id);
  const batch = await service.from("import_batches").insert({
    source_type: "xlsx",
    source_name: `bulk_catalog_v2:${LOTE}`,
    original_file_name: path.basename(CURATED),
    status: "approved",
    total_rows: MISSING_IN_DB.length,
    created_by: login.data.user.id,
    summary: { lote: LOTE, fuente: "plantilla curada oficial Masglo Tradicional", familias: ["Esmaltes tradicionales y gel"], shadesActualizadas: shadeUpdates.length }
  }).select("id").single();
  if (batch.error) throw batch.error;

  const rows = MISSING_IN_DB.map((m, index) => {
    const curatedVariant = variantesBySlug.get(m.slug) ?? {};
    const toneRow = tonos.find((t) => t.slug === m.slug);
    const record = {
      source: { sheet: "Tonos+Variantes (plantilla curada)", row: toneRow?.row ?? index + 2, estado: "oficial", categoriaOriginal: null },
      classification: { familia: "Esmaltes tradicionales y gel", categoryPath: "unas/esmaltes", templateCode: "ESMALTE_TONOS", confidence: "high" },
      identity: { internalCode: String(curatedVariant.sku ?? ""), supplierCode: null, supplierName: null, brandName: "Masglo", brandSlug: "masglo", brandIsGeneric: false },
      naming: { originalDescription: m.name, normalizedName: m.name, baseName: "Esmalte MASGLO", presentation: "13.5 ml" },
      grouping: {
        productKey: "masglo|Esmaltes tradicionales y gel|ESMALTE",
        productCode: PRODUCT_CODE,
        productName: "Esmalte MASGLO",
        productSlug: "masglo-esmalte-masglo-4c95f3",
        variantKey: `tone:${m.slug}`,
        variantName: m.name,
        axes: [{ code: "tone", value: m.slug, label: m.name, confidence: "high" }],
        confidence: "high"
      },
      attributes: [{ code: "tone", value: m.slug, source: "description" }],
      color: { shadeName: m.name, shadeCode: m.oficial, colorFamilyValue: m.family, referenceColor: m.hex },
      supplier: null,
      media: (() => {
        // El archivo oficial puede llevar prefijo (dec-, fot-): manda el
        // media_path de la hoja Variantes, nunca un nombre inventado.
        const officialPath = curatedVariant.media_path ? String(curatedVariant.media_path) : null;
        const fileName = officialPath ? officialPath.split("/").pop() : null;
        return fileName
          ? { matches: [{ storagePath: `productos/${PRODUCT_CODE}/tonos/${fileName}`, mechanism: "package_direct", confidence: "exact", target: "variant", role: "swatch" }], status: "exact", backfill: null }
          : { matches: [], status: "missing", backfill: "pending" };
      })(),
      action: "create_variant",
      review: [`Tono oficial ${m.oficial} (SKU ${curatedVariant.sku ?? "s/d"}) ausente en el Excel de 1,500; cargado desde la plantilla curada vigente.`]
    };
    return {
      batch_id: batch.data.id,
      row_number: toneRow?.row ?? index + 2,
      raw_data: { fuente: path.basename(CURATED), tono: m.name, tone_code: m.oficial, sku_oficial: curatedVariant.sku ?? null, familia: m.family, hex: m.hex },
      normalized_data: record,
      proposed_action: "create_variant",
      status: "approved"
    };
  });
  for (let offset = 0; offset < rows.length; offset += 100) {
    const insert = await service.from("import_rows").insert(rows.slice(offset, offset + 100));
    if (insert.error) throw insert.error;
  }
  const report = await commitBulkBatch(developer, login.data.user.id, String(batch.data.id), "IMPORTAR LOTE");
  console.log("COMMIT:", JSON.stringify({ filas: report.counts.filasProcesadas, variantes: report.counts.variantesCreadas, exact: report.counts.imagenesExactas, rechazadas: report.counts.filasRechazadas }));
  if (report.rechazadas.length) console.log("rechazadas:", JSON.stringify(report.rechazadas.slice(0, 8)));
}

// 3b. Reparación idempotente: variantes del producto sin shade enlazada cuyo
//     tono oficial existe → vincular shade + atributos tipados, y cerrar las
//     filas del lote que quedaron failed por el desfase código/slug.
{
  const { data: defs } = await service.from("attribute_definitions").select("id, code").in("code", ["tone", "color_family"]);
  const toneDefId = defs.find((d) => d.code === "tone")?.id;
  const famDefId = defs.find((d) => d.code === "color_family")?.id;
  const { data: masgloShades } = await service.from("color_shades").select("id, code, name, tone_option_id, color_family_option_id").eq("brand_id", (await service.from("brands").select("id").eq("slug", "masglo").single()).data.id).is("product_line_id", null);
  const shadeBySlug = new Map((masgloShades ?? []).map((s) => [slugify(s.name), s]));
  const { data: current } = await service.from("product_variants").select("id, variant_key, color_shade_id").eq("product_id", product.id);
  let repaired = 0;
  for (const v of current ?? []) {
    if (v.color_shade_id) continue;
    const slug = (v.variant_key.match(/^tone:(.+)$/) ?? [])[1];
    if (!slug) continue;
    const shade = shadeBySlug.get(slug) ?? shadeBySlug.get(ERRATAS_EXCEL.get(slug) ?? "");
    if (!shade) continue;
    const upd = await service.from("product_variants").update({ color_shade_id: shade.id }).eq("id", v.id);
    if (upd.error) throw new Error(`variant ${slug}: ${upd.error.message}`);
    const { data: existingAttrs } = await service.from("variant_attribute_values").select("attribute_definition_id").eq("variant_id", v.id);
    const has = new Set((existingAttrs ?? []).map((a) => String(a.attribute_definition_id)));
    const inserts = [];
    if (toneDefId && !has.has(String(toneDefId)) && shade.tone_option_id) inserts.push({ variant_id: v.id, attribute_definition_id: toneDefId, option_id: shade.tone_option_id });
    if (famDefId && !has.has(String(famDefId)) && shade.color_family_option_id) inserts.push({ variant_id: v.id, attribute_definition_id: famDefId, option_id: shade.color_family_option_id });
    if (inserts.length) {
      const ins = await service.from("variant_attribute_values").insert(inserts);
      if (ins.error) throw new Error(`attrs ${slug}: ${ins.error.message}`);
    }
    repaired += 1;
  }
  console.log(`Variantes reparadas (shade + atributos): ${repaired}`);

  // Cierra las filas failed del lote de compleción apuntando a su variante real.
  const { data: loteBatch } = await service.from("import_batches").select("id").eq("source_name", `bulk_catalog_v2:${LOTE}`).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (loteBatch) {
    const { data: failedRows } = await service.from("import_rows").select("id, normalized_data").eq("batch_id", loteBatch.id).in("status", ["failed", "approved"]);
    let closed = 0;
    const byKey = new Map((current ?? []).map((v) => [v.variant_key.toLowerCase(), v]));
    for (const row of failedRows ?? []) {
      const key = String(row.normalized_data?.grouping?.variantKey ?? "").toLowerCase();
      const variant = byKey.get(key);
      if (!variant) continue;
      await service.from("import_rows").update({ status: "committed", target_product_id: product.id, target_variant_id: variant.id }).eq("id", row.id);
      closed += 1;
    }
    await service.from("import_batches").update({ status: "committed", processed_rows: closed, error_rows: (failedRows?.length ?? 0) - closed, committed_at: new Date().toISOString() }).eq("id", loteBatch.id);
    const openIssues = await service.from("import_issues").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { decision: "repaired", motivo: "Variante creada y enlazada a su shade oficial tras corregir el desfase código/slug.", por: "certificacion-1c" } }).eq("status", "open").in("import_row_id", (failedRows ?? []).map((r) => r.id));
    void openIssues;
    console.log(`Filas del lote cerradas como committed: ${closed}`);
  }
}

// 3c. Swatches con prefijo oficial (dec-/fot-) o errata del Excel: el
//     media_path de la hoja Variantes manda; se enlaza sin renombrar nada.
{
  const { data: current } = await service.from("product_variants").select("id, variant_key, product_media(id)").eq("product_id", product.id);
  let linked = 0;
  for (const v of current ?? []) {
    if ((v.product_media ?? []).length) continue;
    const raw = (v.variant_key.match(/^tone:(.+)$/) ?? [])[1];
    if (!raw) continue;
    const slug = ERRATAS_EXCEL.get(raw) ?? raw;
    const curatedVariant = variantesBySlug.get(slug);
    const mediaPath = curatedVariant?.media_path ? String(curatedVariant.media_path) : null;
    if (!mediaPath) continue;
    const fileName = mediaPath.split("/").pop();
    const storagePath = `productos/${PRODUCT_CODE}/tonos/${fileName}`;
    const asset = await service.from("media_assets").upsert({
      bucket: "catalog-assets",
      storage_path: storagePath,
      file_name: fileName,
      mime_type: "image/webp"
    }, { onConflict: "bucket,storage_path" }).select("id").single();
    if (asset.error) throw new Error(`asset ${fileName}: ${asset.error.message}`);
    const link = await service.from("product_media").insert({ variant_id: v.id, media_asset_id: asset.data.id, media_role: "swatch", is_primary: true });
    if (link.error) throw new Error(`link ${fileName}: ${link.error.message}`);
    linked += 1;
  }
  console.log(`Swatches oficiales con prefijo/errata enlazados: ${linked}`);
}

// 4. Verificación final del producto.
const { data: after } = await service
  .from("product_variants")
  .select("id, media_backfill, color_shades(reference_color), product_media(id)")
  .eq("product_id", product.id);
const total = after?.length ?? 0;
const conMedia = (after ?? []).filter((v) => (v.product_media ?? []).length > 0).length;
const conHex = (after ?? []).filter((v) => v.color_shades?.reference_color).length;
console.log(JSON.stringify({ variantesFinales: total, conMedia, conHex, esperado: 157 + EXTRA_IN_DB.length }, null, 2));
