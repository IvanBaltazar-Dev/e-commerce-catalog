import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "test-catalog-import-flow" });
if (!isLocal) throw new Error("La prueba de importación solo puede ejecutarse contra Supabase local.");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const [{ parseCatalogImportXlsx }, { analyzeCatalogImport, commitCatalogImport }] = await Promise.all([
  import("../src/lib/admin/catalog-import-xlsx.ts"),
  import("../src/lib/admin/catalog-import-service.ts")
]);

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const email = `catalog-import-${stamp}@local.invalid`;
const password = `Catalog-${stamp}-Only!`;
const startedAt = new Date().toISOString();
let userId;
let batchId;
let productIds = [];
let productLineId;
let toneIds = [];
let toneOptionIds = [];
let uploadedPaths = [];

try {
  const createdUser = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error) throw createdUser.error;
  userId = createdUser.data.user.id;
  const profile = await service.from("admin_profiles").insert({ id: userId, role: "developer", full_name: "Catalog import test" });
  if (profile.error) throw profile.error;

  const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const login = await developer.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;

  const templatePath = path.join(root, "assets", "import", "plantilla_importacion_productos.xlsx");
  const bytes = await fs.readFile(templatePath);
  const workbook = await parseCatalogImportXlsx({
    name: "plantilla_importacion_productos.xlsx",
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });
  for (const rows of Object.values(workbook.sheets)) for (const row of rows) row.importar = true;
  for (const medium of workbook.sheets.Medios) if (String(medium.sku || "").trim()) medium.role = "swatch";
  const firstProduct = workbook.sheets.Productos[0];
  const firstProductCode = String(firstProduct.product_code);
  const firstVariant = workbook.sheets.Variantes.find((row) => String(row.product_code).toLowerCase() === firstProductCode.toLowerCase());
  assert(firstVariant, "La plantilla debe incluir una variante para el primer producto.");
  const brandSlug = String(firstProduct.brand_slug);
  const originalLineSlug = String(firstProduct.product_line_slug);
  const productLineSlug = `linea-import-${stamp}`;
  firstProduct.product_line_slug = productLineSlug;
  const firstProductToneCodes = new Set(workbook.sheets.Variantes
    .filter((row) => String(row.product_code).toLowerCase() === firstProductCode.toLowerCase())
    .map((row) => String(row.tone_code).toLowerCase())
    .filter(Boolean));
  for (const tone of workbook.sheets.Tonos) {
    if (
      String(tone.brand_slug).toLowerCase() === brandSlug.toLowerCase()
      && String(tone.product_line_slug).toLowerCase() === originalLineSlug.toLowerCase()
      && firstProductToneCodes.has(String(tone.tone_code).toLowerCase())
    ) tone.product_line_slug = productLineSlug;
  }
  workbook.sheets.Atributos_variante.push({
    __row: Math.max(...workbook.sheets.Atributos_variante.map((row) => row.__row)) + 1,
    importar: true,
    sku: firstVariant.sku,
    attribute_code: "photochromic_pair",
    option_value: null,
    tone_code: null,
    value_text: null,
    value_number: null,
    value_boolean: null,
    value_date: null,
    value_json: '{"sin_sol":"#112233","con_sol":"#445566"}'
  });
  const withoutAssets = await analyzeCatalogImport(developer, workbook);
  assert.equal(withoutAssets.preview.canCommit, false);
  assert(withoutAssets.preview.issues.some((item) => item.code === "media_asset_missing"), "La previsualización debe exigir medios existentes.");
  uploadedPaths = [...new Set([
    ...workbook.sheets.Medios.map((row) => String(row.path || "")),
    ...workbook.sheets.Variantes.map((row) => String(row.media_path || ""))
  ].filter(Boolean))];
  for (const storagePath of uploadedPaths) {
    const isPdf = storagePath.toLowerCase().endsWith(".pdf");
    const upload = await service.storage.from("catalog-assets").upload(
      storagePath,
      Buffer.from(isPdf ? "%PDF-1.4\n%%EOF\n" : "RIFF-test-WEBP"),
      { contentType: isPdf ? "application/pdf" : "image/webp", upsert: false }
    );
    if (upload.error) throw upload.error;
  }

  const analysis = await analyzeCatalogImport(developer, workbook);
  assert.equal(analysis.preview.summary.products, 3);
  assert.equal(analysis.preview.summary.variants, 5);
  assert.equal(analysis.preview.summary.productLinesToCreate, 1);
  assert.equal(analysis.preview.summary.tonesToCreate, 3);
  assert.deepEqual(analysis.preview.productLinesToCreate.map((item) => ({ brandSlug: item.brandSlug, slug: item.slug })), [{ brandSlug, slug: productLineSlug }]);
  assert.equal(analysis.preview.canCommit, true, JSON.stringify(analysis.preview.issues, null, 2));

  await assert.rejects(
    () => commitCatalogImport(developer, userId, workbook, workbook.fileSha256),
    (error) => error?.code === "catalog_import_structure_approval_required"
  );

  const committed = await commitCatalogImport(
    developer,
    userId,
    workbook,
    workbook.fileSha256,
    [{ brandSlug, slug: productLineSlug, name: "Línea importada de prueba" }],
    "AUTORIZAR E IMPORTAR"
  );
  batchId = committed.batchId;
  productIds = committed.products.map((item) => item.id);
  assert.equal(committed.products.length, 3);
  assert.equal(committed.createdProductLineCount, 1);
  assert.equal(committed.createdToneCount, 3);

  const [products, variants, audit, relation, productLine] = await Promise.all([
    service.from("products").select("id, code").in("id", productIds),
    service.from("product_variants").select("id, product_id, sku").in("product_id", productIds),
    service.from("import_batches").select("status, processed_rows, error_rows, file_sha256, security_report").eq("id", batchId).single(),
    service.from("product_relations").select("id").in("source_product_id", productIds),
    service.from("product_lines").select("id, name").eq("brand_id", analysis.productLinesToCreate[0].brandId).eq("slug", productLineSlug).single()
  ]);
  for (const result of [products, variants, audit, relation, productLine]) if (result.error) throw result.error;
  productLineId = productLine.data.id;
  assert.equal(products.data.length, 3);
  assert.equal(variants.data.length, 5);
  assert.equal(relation.data.length, 1);
  assert.equal(audit.data.status, "committed");
  assert.equal(audit.data.processed_rows, 3);
  assert.equal(audit.data.error_rows, 0);
  assert.equal(audit.data.file_sha256, workbook.fileSha256);
  assert.equal(audit.data.security_report.originalFileStored, false);
  assert.equal(productLine.data.name, "Línea importada de prueba");
  const importedFirstVariant = variants.data.find((item) => item.sku === firstVariant.sku);
  assert(importedFirstVariant, "La primera variante importada debe existir.");
  const jsonDefinition = await service.from("attribute_definitions").select("id").eq("code", "photochromic_pair").single();
  if (jsonDefinition.error) throw jsonDefinition.error;
  const jsonAttribute = await service.from("variant_attribute_values").select("value_json").eq("variant_id", importedFirstVariant.id).eq("attribute_definition_id", jsonDefinition.data.id).single();
  if (jsonAttribute.error) throw jsonAttribute.error;
  assert.deepEqual(jsonAttribute.data.value_json, { sin_sol: "#112233", con_sol: "#445566" });
  const lineAssociation = await service.from("product_line_product_families").select("template_id").eq("product_line_id", productLineId);
  if (lineAssociation.error) throw lineAssociation.error;
  assert.equal(lineAssociation.data.length, 1);

  console.log(`OK: lote ${batchId}, 1 línea autorizada, 3 productos, 5 variantes, 3 tonos y 1 relación; auditoría verificada.`);
} finally {
  if (batchId) await service.from("import_batches").delete().eq("id", batchId);
  const partialProducts = await service.from("products").select("id").in("code", ["EJ-ESM-001", "EJ-TOR-001", "EJ-ACC-001"]).gte("created_at", startedAt);
  productIds = [...new Set([...productIds, ...(partialProducts.data ?? []).map((item) => item.id)])];
  if (productIds.length) {
    const variants = await service.from("product_variants").select("id").in("product_id", productIds);
    const variantIds = (variants.data ?? []).map((item) => item.id);
    await service.from("product_relations").delete().in("source_product_id", productIds);
    await service.from("product_relations").delete().in("target_product_id", productIds);
    await service.from("wholesale_rules").delete().in("product_id", productIds);
    if (variantIds.length) {
      await service.from("product_relations").delete().in("source_variant_id", variantIds);
      await service.from("product_relations").delete().in("target_variant_id", variantIds);
      await service.from("wholesale_rules").delete().in("variant_id", variantIds);
    }
    await service.from("products").delete().in("id", productIds);
  }
  const shades = await service.from("color_shades").select("id, tone_option_id").in("code", ["EJ-CORAL-101", "EJ-NUDE-102", "EJ-ROJO-103"]).gte("created_at", startedAt);
  toneIds = (shades.data ?? []).map((item) => item.id);
  toneOptionIds = (shades.data ?? []).map((item) => item.tone_option_id).filter(Boolean);
  if (toneIds.length) await service.from("color_shades").delete().in("id", toneIds);
  if (toneOptionIds.length) await service.from("attribute_options").delete().in("id", toneOptionIds);
  if (productLineId) {
    await service.from("product_line_product_families").delete().eq("product_line_id", productLineId);
    await service.from("product_lines").delete().eq("id", productLineId);
  }
  await service.from("media_assets").delete().like("storage_path", "productos/EJ-%").gte("created_at", startedAt);
  if (uploadedPaths.length) await service.storage.from("catalog-assets").remove(uploadedPaths);
  if (userId) await service.auth.admin.deleteUser(userId);
}
