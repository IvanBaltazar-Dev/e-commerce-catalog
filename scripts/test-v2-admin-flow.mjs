import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { signInToPanel } from "./lib/admin-login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-v2-admin-flow" });
const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const email = `codex-v2-${stamp}@local.invalid`;
const password = `Local-V2-${stamp}-Only!`;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let browser;
let userId;
let productId;
let categoryId;
let templateId;
let attributeId;
let saleId;
let pdfExportId;
let pdfStoragePath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertClean(result, label) {
  if (result.error) throw new Error(`Limpieza ${label}: ${result.error.message}`);
}

async function browserRequest(page, url, init) {
  return page.evaluate(async ({ url, init }) => {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }, { url, init });
}

try {
  const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error) throw createdUser.error;
  userId = createdUser.data.user.id;
  const profile = await admin.from("admin_profiles").upsert({ id: userId, role: "admin", full_name: "Admin V2 Test" });
  if (profile.error) throw profile.error;

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath: await resolveBrowserExecutable()
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);
  await signInToPanel(page, {
    baseUrl,
    email,
    password,
    expectedPath: "/admin/productos/nuevo"
  });

  let response = await browserRequest(page, "/api/admin/catalog-v2/structure", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_template", name: "Plantilla prueba V2", code: `TEST_${stamp.toUpperCase()}`, description: "Flujo E2E local" })
  });
  assert(response.status === 201, `No se creó plantilla: ${JSON.stringify(response.body)}`);
  templateId = response.body.data.id;

  response = await browserRequest(page, "/api/admin/catalog-v2/structure", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_attribute", name: "Tono prueba", code: `test_tone_${stamp}`, dataType: "single_option", scope: "variant", unit: null, isRequired: true, isVariantAxis: true, isFilterable: true, options: [{ value: "red", label: "Rojo" }, { value: "blue", label: "Azul" }] })
  });
  assert(response.status === 201, `No se creó atributo: ${JSON.stringify(response.body)}`);
  attributeId = response.body.data.id;

  response = await browserRequest(page, "/api/admin/catalog-v2/structure", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "attach_attribute", templateId, attributeDefinitionId: attributeId, isRequired: true, scope: "variant", sortOrder: 10 })
  });
  assert(response.status === 201, `No se asoció atributo: ${JSON.stringify(response.body)}`);

  response = await browserRequest(page, "/api/admin/catalog-v2/structure", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_category", name: "Categoría prueba V2", slug: `test-${stamp}`, parentId: null, templateId })
  });
  assert(response.status === 201, `No se creó categoría: ${JSON.stringify(response.body)}`);
  categoryId = response.body.data.id;

  const bootstrap = await browserRequest(page, "/api/admin/catalog-v2/bootstrap");
  assert(bootstrap.status === 200, "No se cargó bootstrap admin.");
  const brandId = bootstrap.body.data.brands[0].id;
  const definition = bootstrap.body.data.attributes.find((item) => item.id === attributeId);
  const [red, blue] = definition.options;
  const code = `TEST-${stamp.toUpperCase()}`;
  const payload = {
    code,
    slug: `test-product-${stamp}`,
    brandId,
    categoryId,
    templateId,
    name: "Producto de prueba V2",
    shortDescription: "Creación atómica local",
    description: "Producto temporal para validar el flujo administrativo V2.",
    editorialStatus: "draft",
    isActive: true,
    isFeatured: false,
    productAttributes: [],
    variants: [
      { sku: `${code}-RED`, name: "Rojo", variantKey: "test=red", availability: "available", isDefault: true, isActive: true, sortOrder: 0, retailPrice: 12, wholesalePrice: 10, wholesaleMinimum: 3, attributes: [{ attributeDefinitionId: attributeId, optionId: red.id }], mediaPath: null },
      { sku: `${code}-BLUE`, name: "Azul", variantKey: "test=blue", availability: "consult", isDefault: false, isActive: true, sortOrder: 10, retailPrice: null, wholesalePrice: null, wholesaleMinimum: 3, attributes: [{ attributeDefinitionId: attributeId, optionId: blue.id }], mediaPath: null }
    ],
    media: [],
    relations: [],
    wholesaleMixingPolicy: "same_product"
  };

  response = await browserRequest(page, "/api/admin/catalog-v2/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert(response.status === 201, `No se creó producto V2: ${JSON.stringify(response.body)}`);
  productId = response.body.data.id;
  assert(response.body.data.variants.length === 2, "La creación no devolvió dos variantes.");
  assert(response.body.data.variants.filter((item) => item.isDefault && item.isActive).length === 1, "La predeterminada activa no es única.");

  response = await browserRequest(page, `/api/admin/catalog-v2/products/${productId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, id: productId, editorialStatus: "published", variants: response.body.data.variants }) });
  assert(response.status === 200, `No se publicó producto V2: ${JSON.stringify(response.body)}`);

  const publicDetail = await browserRequest(page, `/api/catalog/${payload.slug}`);
  assert(publicDetail.status === 200, "El producto publicado no aparece en el detalle público.");
  assert(publicDetail.body.data.variants.length === 2, "El detalle público perdió variantes.");

  await page.goto(`${baseUrl}/producto/${payload.slug}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector(".pub-ficha-title");
  assert((await page.$eval(".pub-ficha-title", (element) => element.textContent))?.includes(payload.name), "La ficha pública no renderizó el producto.");
  await page.click(".pub-qtybtn-inc");
  await page.click(".pub-qtybtn-inc");
  await page.click(".pub-addbtn");
  await page.goto(`${baseUrl}/seleccion`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector(".pub-selrow");
  assert(await page.$eval(".pub-selrow-qty", (element) => element.textContent === "3"), "La selección pública no conservó variante y cantidad.");

  const evaluation = await browserRequest(page, "/api/catalog/cart/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ variantId: response.body.data.variants[0].id, quantity: 3 }] }) });
  assert(evaluation.status === 200, "No se evaluó el carrito V2.");
  assert(evaluation.body.data.lines[0].purchaseMode === "wholesale", "No se aplicó mayorista en el flujo admin.");

  const branches = await browserRequest(page, "/api/admin/branches");
  assert(branches.status === 200, "No se pudieron consultar las sedes operables.");
  assert(branches.body.data.items.length > 0, "El perfil no alcanza ninguna sede.");
  const branchId = branches.body.data.items[0].id;

  // El importe lo resuelve PostgreSQL: el cobro se arma con el subtotal que
  // devolvió la evaluación, nunca con un número calculado en el script.
  const saleTotal = Number(evaluation.body.data.subtotal);
  const saleOperationId = crypto.randomUUID();
  const sale = await browserRequest(page, "/api/admin/sales", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      branchId,
      clientOperationId: saleOperationId,
      sourceChannel: "in_store",
      fulfillmentMethod: "pickup",
      customer: { name: "Cliente prueba V2", phone: "999999999" },
      discountTotal: 0,
      notes: "Venta temporal E2E",
      lines: [{ variantId: response.body.data.variants[0].id, quantity: 3 }],
      payments: [{ method: "cash", amount: saleTotal }]
    })
  });
  assert(sale.status === 201, `No se registró la venta: ${JSON.stringify(sale.body)}`);
  saleId = sale.body.data.id;
  assert(sale.body.data.lines[0].purchaseMode === "wholesale", "La venta no conservó el precio mayorista canónico.");
  assert(Number(sale.body.data.total) === saleTotal, "La venta no cobró el total resuelto en PostgreSQL.");

  // Idempotencia (prueba crítica 1): el mismo identificador de operación
  // devuelve la venta ya creada en lugar de duplicarla.
  const retry = await browserRequest(page, "/api/admin/sales", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      branchId,
      clientOperationId: saleOperationId,
      sourceChannel: "in_store",
      fulfillmentMethod: "pickup",
      lines: [{ variantId: response.body.data.variants[0].id, quantity: 3 }],
      payments: [{ method: "cash", amount: saleTotal }]
    })
  });
  assert(retry.body?.data?.id === saleId,
    `El reintento no fue idempotente: ${retry.status} ${JSON.stringify(retry.body)}`);

  const saleList = await browserRequest(page, "/api/admin/sales");
  assert(saleList.status === 200, "No se pudo consultar el historial de ventas.");
  assert(saleList.body.data.items.some((item) => item.id === saleId), "La venta registrada no aparece en el historial.");

  await page.goto(`${baseUrl}/admin/estructura`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => window.location.pathname === "/admin/productos/nuevo", { timeout: 90000 });
  await page.waitForSelector(".product-wizard");

  const pdf = await browserRequest(page, "/api/admin/pdf/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ brand: "demo-professional", sort: "name_asc" })
  });
  assert(pdf.status === 201, `No se generó PDF V2: ${JSON.stringify(pdf.body)}`);
  assert(pdf.body.data.item_count > 0, "El PDF V2 no registró productos exportados.");
  pdfExportId = pdf.body.data.id;
  pdfStoragePath = pdf.body.data.storage_path;

  console.log("Flujo admin V2 verificado: login, producto, carrito, venta y PDF.");
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (pdfStoragePath) assertClean(await admin.storage.from("catalog-pdfs").remove([pdfStoragePath]), "archivo PDF");
  if (pdfExportId) assertClean(await admin.from("pdf_exports").delete().eq("id", pdfExportId), "registro PDF");
  if (saleId) assertClean(await admin.from("sales").delete().eq("id", saleId), "venta");
  if (productId) {
    const variants = await admin.from("product_variants").select("id").eq("product_id", productId);
    assertClean(variants, "consulta de variantes");
    const variantIds = variants.data.map((variant) => variant.id);
    assertClean(await admin.from("wholesale_rules").delete().eq("product_id", productId), "regla mayorista de producto");
    assertClean(await admin.from("product_relations").delete().or(`source_product_id.eq.${productId},target_product_id.eq.${productId}`), "relaciones de producto");
    if (variantIds.length) {
      // El carrito público persistente (0037) referencia la variante con FK
      // restrictiva: el recorrido de esta misma prueba deja la selección en el
      // servidor, así que se retira antes de borrar el producto.
      assertClean(await admin.from("public_cart_items").delete().in("variant_id", variantIds), "líneas de carrito público");
      assertClean(await admin.from("wholesale_rules").delete().in("variant_id", variantIds), "reglas mayoristas de variante");
      assertClean(await admin.from("product_relations").delete().or(`source_variant_id.in.(${variantIds.join(",")}),target_variant_id.in.(${variantIds.join(",")})`), "relaciones de variante");
    }
    assertClean(await admin.from("products").delete().eq("id", productId), "producto");
  }
  if (categoryId) assertClean(await admin.from("categories").delete().eq("id", categoryId), "categoría");
  if (templateId && attributeId) assertClean(await admin.from("template_attributes").delete().eq("template_id", templateId).eq("attribute_definition_id", attributeId), "asociación de plantilla");
  if (attributeId) {
    assertClean(await admin.from("attribute_options").delete().eq("attribute_definition_id", attributeId), "opciones");
    assertClean(await admin.from("attribute_definitions").delete().eq("id", attributeId), "atributo");
  }
  if (templateId) assertClean(await admin.from("attribute_templates").delete().eq("id", templateId), "plantilla");
  if (userId) assertClean(await admin.auth.admin.deleteUser(userId), "usuario Auth");
}
