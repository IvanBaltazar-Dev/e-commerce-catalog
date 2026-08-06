import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-product-registration-ui" });
const baseUrl = process.env.PRODUCT_REGISTRATION_BASE_URL ?? "http://127.0.0.1:3001";
const stamp = Date.now().toString(36);
const email = `product-registration-${stamp}@local.invalid`;
const password = `Product-${stamp}-Only!`;
const productCode = `ADM-TOR-${stamp.toUpperCase()}`;
const productName = `Torno profesional Demo ${stamp}`;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let browser;
let userId;
let productId;
let createdBrandId;
let createdShadeId;
let createdToneOptionId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fillLabeledField(page, labelText, value) {
  const field = await page.evaluateHandle((text) => {
    const labels = [...document.querySelectorAll("label.product-field, div.product-field")];
    const label = labels.find((item) => item.querySelector(".field-label")?.textContent?.includes(text));
    return label?.querySelector("input, textarea, select") ?? null;
  }, labelText);
  const element = field.asElement();
  assert(element, `No se encontró el campo ${labelText}.`);
  const tagName = await element.evaluate((item) => item.tagName);
  if (tagName === "SELECT") {
    await element.select(value);
  } else {
    await element.click({ clickCount: 3 });
    await element.type(value);
  }
  await field.dispose();
}

async function fillRequiredVisibleFields(page) {
  await page.evaluate(() => {
    const labels = [...document.querySelectorAll("label.product-field")];
    for (const label of labels) {
      const marker = label.querySelector(".field-label")?.textContent ?? "";
      const field = label.querySelector("input, textarea, select");
      if (!marker.includes("*") || !field || field.disabled) continue;
      if (field instanceof HTMLSelectElement && !field.value) {
        const option = [...field.options].find((item) => item.value);
        if (option) {
          field.value = option.value;
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (field instanceof HTMLInputElement && !field.value) {
        const value = field.type === "number" ? "35" : "Dato de prueba";
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  });
}

try {
  const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error) throw createdUser.error;
  userId = createdUser.data.user.id;
  const profile = await admin.from("admin_profiles").upsert({ id: userId, role: "admin", full_name: "Product Registration Test" });
  if (profile.error) throw profile.error;

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.location.pathname === "/admin/productos/nuevo");
  try {
    await page.waitForSelector(".product-type-grid");
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 1000)
    }));
    throw new Error(`No cargó el selector de tipo: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const firstStepText = await page.$eval(".product-wizard", (element) => element.textContent ?? "");
  assert(firstStepText.includes("Torno o pulidor"), "No aparece el tipo Torno o pulidor.");
  assert(!firstStepText.includes("Ruta canónica") && !firstStepText.includes("Ruta resuelta"), "El alta todavía expone rutas técnicas.");
  assert((await page.$$(".product-type-card")).length === 8, "El selector no presenta las ocho familias acordadas.");

  await page.$$eval(".product-type-card", (buttons) => {
    const button = buttons.find((item) => item.textContent?.includes("Torno o pulidor"));
    if (!(button instanceof HTMLButtonElement)) throw new Error("No se encontró la tarjeta Torno o pulidor.");
    button.click();
  });
  await page.waitForFunction(() => document.querySelector(".product-selected-type")?.textContent?.includes("Torno o pulidor"));

  await fillLabeledField(page, "Nombre comercial", productName);
  await fillLabeledField(page, "Código del producto", productCode);
  const brandSearch = await page.$('input[placeholder*="Buscar marca para"]');
  assert(brandSearch, "No existe el buscador contextual de marcas.");
  assert(await page.$eval(".product-entity-search button", (button) => button.textContent?.includes("Registrar")), "No existe la acción contextual para registrar una marca.");
  await brandSearch.type("Demo Professional");
  await page.waitForFunction(() => [...document.querySelectorAll(".product-entity-results button")].some((item) => item.textContent?.includes("Demo Professional")));
  await page.$$eval(".product-entity-results button", (buttons) => buttons.find((item) => item.textContent?.includes("Demo Professional"))?.click());
  await page.waitForFunction(() => document.querySelector(".product-picked-value")?.textContent?.includes("Demo Professional"));
  await fillRequiredVisibleFields(page);

  const continued = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Continuar con las opciones de venta"));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert(continued, "No se encontró la continuación del paso 2.");
  await page.waitForFunction(() => document.querySelector(".product-step-heading")?.textContent?.includes("Paso 3"));

  const axes = await page.$$(".product-axis");
  for (const axis of axes) {
    const option = await axis.$(".chip-row .opt-chip");
    if (option) await option.click();
  }
  if (axes.length) {
    await page.click(".product-generate");
    await page.waitForSelector(".product-variant-card");
  }
  await fillRequiredVisibleFields(page);

  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll(".product-step-actions .btn-save")];
    const button = buttons.at(-1);
    return button && !button.disabled && button.textContent?.includes("Guardar sin publicar");
  });
  await page.$$eval(".product-step-actions .btn-save", (buttons) => buttons.at(-1)?.click());
  await page.waitForFunction(() => /^\/admin\/productos\/[0-9a-f-]{36}$/.test(window.location.pathname));
  productId = windowId(await page.evaluate(() => window.location.pathname.split("/").at(-1)));

  const product = await admin
    .from("products")
    .select("id, product_line_id, brands(name), categories(slug), attribute_templates(code), product_variants(id, sku)")
    .eq("id", productId)
    .single();
  if (product.error) throw product.error;
  assert(product.data.brands?.name === "Demo Professional", "El producto no guardó la marca de equipos.");
  assert(product.data.categories?.slug === "tornos", "El sistema no asignó internamente la categoría Tornos.");
  assert(product.data.attribute_templates?.code === "TORNO_ELECTRICO", "El sistema no asignó la plantilla de torno.");
  assert(product.data.product_variants?.length >= 1, "El producto se guardó sin una opción de venta.");

  await page.goto(`${baseUrl}/admin/productos/nuevo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".product-type-grid");
  await page.$$eval(".product-type-card", (buttons) => buttons.find((item) => item.textContent?.includes("Esmalte"))?.click());
  await page.waitForFunction(() => document.querySelector(".product-selected-type")?.textContent?.includes("Esmalte"));
  const enamelInitialBrandSearch = await page.$('input[placeholder*="Buscar marca para"]');
  await enamelInitialBrandSearch.focus();
  await page.waitForSelector(".product-entity-results");
  await page.click(".product-entity-search button");
  await page.waitForSelector('.product-inline-create--panel input[placeholder="Nombre de la nueva marca"]');
  assert((await page.$$(".product-entity-results")).length === 0, "La lista de marcas sigue visible al registrar una nueva.");
  await page.$$eval(".product-inline-create--panel button", (buttons) => buttons.find((item) => item.textContent?.includes("Cancelar"))?.click());
  await fillLabeledField(page, "Nombre comercial", `Gel de prueba ${stamp}`);
  await fillLabeledField(page, "Código del producto", `ESM-${stamp.toUpperCase()}`);
  assert(await page.evaluate(() => {
    const field = [...document.querySelectorAll("label.product-field")].find((item) => item.querySelector(".field-label")?.textContent?.includes("Contenido neto"));
    return field?.querySelector("input")?.type === "number";
  }), "El contenido neto no usa un campo numérico.");
  assert(await page.evaluate(() => {
    const field = [...document.querySelectorAll("label.product-field")].find((item) => item.querySelector(".field-label")?.textContent?.includes("Unidad del contenido"));
    return [...(field?.querySelector("select")?.options ?? [])].some((item) => item.textContent === "ml") && [...(field?.querySelector("select")?.options ?? [])].some((item) => item.textContent === "fl oz");
  }), "No aparecen las unidades ml y fl oz.");
  assert(await page.evaluate(() => {
    const field = [...document.querySelectorAll("label.product-field")].find((item) => item.querySelector(".field-label")?.textContent?.includes("Acabado"));
    return [...(field?.querySelector("select")?.options ?? [])].some((item) => item.textContent === "Ojo de gato");
  }), "No aparece el acabado Ojo de gato.");
  assert(!await page.evaluate(() => [...document.querySelectorAll(".field-label")].some((item) => item.textContent?.includes("Tecnología de lámpara"))), "La tecnología de lámpara aparece antes de indicar que el esmalte la requiere.");
  await fillLabeledField(page, "Requiere lámpara", "true");
  await page.waitForFunction(() => [...document.querySelectorAll(".field-label")].some((item) => item.textContent?.includes("Tecnología de lámpara")));
  await page.evaluate(() => {
    const label = [...document.querySelectorAll("label.product-field")].find((item) => item.querySelector(".field-label")?.textContent?.includes("Tecnología de lámpara"));
    const field = label?.querySelector("select");
    const option = field instanceof HTMLSelectElement ? [...field.options].find((item) => item.value) : null;
    if (!(field instanceof HTMLSelectElement) || !option) throw new Error("No existe una tecnología de lámpara seleccionable.");
    field.value = option.value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await fillLabeledField(page, "Requiere lámpara", "false");
  await page.waitForFunction(() => ![...document.querySelectorAll(".field-label")].some((item) => item.textContent?.includes("Tecnología de lámpara")));
  await fillLabeledField(page, "Requiere lámpara", "true");
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll("label.product-field")].find((item) => item.querySelector(".field-label")?.textContent?.includes("Tecnología de lámpara"));
    return label?.querySelector("select")?.value === "";
  });
  await fillLabeledField(page, "Requiere lámpara", "false");
  await page.waitForFunction(() => document.querySelector(".carta-note")?.textContent?.includes("este esmalte no la requiere"));
  const enamelBrandSearch = await page.$('input[placeholder*="Buscar marca para"]');
  await enamelBrandSearch.type("Masglo");
  await page.waitForFunction(() => [...document.querySelectorAll(".product-entity-results button")].some((item) => item.textContent?.includes("Masglo")));
  await page.$$eval(".product-entity-results button", (buttons) => buttons.find((item) => item.textContent?.includes("Masglo"))?.click());
  const lineSearch = await page.$('input[placeholder*="Buscar línea de Masglo"]');
  assert(lineSearch, "No existe el buscador contextual de líneas.");
  await lineSearch.type("Gel Evolution");
  await page.waitForFunction(() => [...document.querySelectorAll(".product-entity-results button")].some((item) => item.textContent?.includes("Gel Evolution")));
  await page.$$eval(".product-entity-results button", (buttons) => buttons.find((item) => item.textContent?.includes("Gel Evolution"))?.click());
  await page.evaluate(() => [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Continuar para seleccionar tonos"))?.click());
  await page.waitForSelector(".product-tone-picker");
  assert((await page.$eval(".product-step-heading h2", (item) => item.textContent)) === "Selecciona todos los tonos de este esmalte", "El paso de tonos conserva un texto ambiguo.");
  assert((await page.$$(".product-variant-card")).length === 0, "Se muestra una opción vacía antes de seleccionar los tonos.");
  assert((await page.$$(".product-tone-result")).length <= 12, "El selector de tonos muestra una lista mayor a 12 resultados.");
  await page.$$eval(".product-family-chips button", (buttons) => buttons.find((item) => item.textContent?.trim() === "Rojos")?.click());
  await page.type('input[placeholder="Buscar tono o código…"]', "Rojo intenso");
  await page.waitForFunction(() => [...document.querySelectorAll(".product-tone-result")].some((item) => item.textContent?.includes("Rojo intenso")));
  await page.$$eval(".product-tone-result", (buttons) => buttons.find((item) => item.textContent?.includes("Rojo intenso"))?.click());
  assert(await page.$eval(".product-generate", (button) => button.textContent?.includes("Agregar 1 tono al producto")), "La acción no explica que agregará un tono al producto.");
  assert(await page.$eval(".product-shade-create-toggle", (button) => button.textContent?.includes("Agregar un tono")), "No existe la creación contextual de tonos.");
  await page.click(".product-shade-create-toggle");
  await page.waitForSelector(".product-shade-create");
  await page.type('input[placeholder="Ej. Apasionada"]', `Tono prueba ${stamp}`);
  await page.type('input[placeholder="Ej. 123"]', `TMP-${stamp}`);
  await page.$$eval(".product-shade-create button", (buttons) => buttons.find((item) => item.textContent?.includes("Crear y seleccionar"))?.click());
  await page.waitForFunction((name) => document.querySelector(".product-tone-selected")?.textContent?.includes(name), {}, `Tono prueba ${stamp}`);
  const createdShade = await admin.from("color_shades").select("id, tone_option_id").eq("code", `TMP-${stamp}`).single();
  if (createdShade.error) throw createdShade.error;
  createdShadeId = createdShade.data.id;
  createdToneOptionId = createdShade.data.tone_option_id;
  assert(await page.$eval(".product-generate", (button) => button.textContent?.includes("Agregar 2 tonos al producto")), "La acción no indica la cantidad exacta de tonos que agregará.");
  await page.click(".product-generate");
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("tonos listos para completar"), { timeout: 15000 }).catch(async () => {
    const message = await page.$eval(".toast", (item) => item.textContent).catch(() => "Sin mensaje");
    throw new Error(`No se crearon las opciones de venta por tono: ${message}`);
  });
  assert(await page.$eval(".product-variants-list", (item) => item.textContent?.includes("Rojo intenso")), "Las opciones creadas no conservaron el tono existente.");
  assert(await page.$eval(".product-variants-list", (item, name) => item.textContent?.includes(name), `Tono prueba ${stamp}`), "Las opciones creadas no conservaron el tono nuevo.");
  assert(await page.$eval(".product-variants-list", (item) => item.textContent?.includes("Tono principal del producto")), "La opción principal del esmalte no tiene un nombre claro.");
  assert(await page.$eval(".product-variants-list", (item) => item.textContent?.includes("representa al producto en el catálogo")), "No se explica para qué sirve el tono principal.");
  assert(!await page.$eval(".product-variants-list", (item) => item.textContent?.includes("Tono mostrado primero")), "Permanece el texto ambiguo Tono mostrado primero.");
  assert(!await page.$eval(".product-variant-card", (item) => item.textContent?.includes("Cantidad mínima para precio mayorista")), "El mínimo mayorista aparece sin haber ingresado un precio mayorista.");

  console.log(JSON.stringify({
    ok: true,
    product: productName,
    brand: product.data.brands.name,
    internalCategory: product.data.categories.slug,
    internalTemplate: product.data.attribute_templates.code,
    variants: product.data.product_variants.length,
    scopedBrandSearch: true,
    scopedLineSearch: true,
    enamelToneSearch: "familia cromática + nombre/código",
    contextualToneCreation: true,
    toneResultLimit: 12,
    routesExposed: false,
    productTypeCards: 8
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (productId) await admin.from("products").delete().eq("id", productId);
  if (createdShadeId) await admin.from("color_shades").delete().eq("id", createdShadeId);
  if (createdToneOptionId) await admin.from("attribute_options").delete().eq("id", createdToneOptionId);
  if (createdBrandId) await admin.from("brands").delete().eq("id", createdBrandId);
  if (userId) await admin.auth.admin.deleteUser(userId);
}

function windowId(value) {
  assert(typeof value === "string" && value.length > 0, "No se obtuvo el id del producto guardado.");
  return value;
}
