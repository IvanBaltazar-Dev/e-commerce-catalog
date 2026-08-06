// Prueba de extremo a extremo de la caja DESDE LA PANTALLA, con la sesión real
// de una vendedora. No repite lo que ya cubren pgTAP ni la prueba de
// concurrencia: comprueba lo único que ninguna de las dos puede ver, que es si
// la persona que atiende el mostrador puede cobrar sin pasar por la consola.
//
// Uso: node scripts/test-sales-ui.mjs --env .env.supabase.local
//      E2E_BASE_URL=http://127.0.0.1:3001 node scripts/test-sales-ui.mjs …
//
// Requiere `node scripts/seed-demo-operation.mjs` ejecutado antes: usa la
// vendedora demo, su sede y la existencia inicial cargada por el contrato.

import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-sales-ui" });

if (!isLocal) {
  throw new Error("La prueba de pantalla de caja solo corre contra Supabase local.");
}

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const SELLER = { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!" };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let failures = 0;
let browser;
let createdSaleId;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function stockOf(sku) {
  const rows = must(
    await admin
      .from("inventory_stock")
      .select("on_hand, reserved, product_variants!inner(sku)")
      .eq("product_variants.sku", sku),
    `existencias de ${sku}`
  );
  return rows[0] ?? null;
}

try {
  const before = await stockOf("DEMO-ESM-ROJO");
  if (!before) throw new Error("Falta la existencia inicial: corre scripts/seed-demo-operation.mjs.");

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  console.log("\n1. La vendedora entra al panel y aterriza en su caja");

  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector('input[type="email"]');
  // El formulario es un componente cliente: sin esperar a la hidratación, el
  // click envía el form de forma nativa y la navegación nunca ocurre.
  await page.waitForFunction(() => !document.querySelector("form")?.hasAttribute("data-pending"), { timeout: 5000 })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await page.type('input[type="email"]', SELLER.email);
  await page.type('input[type="password"]', SELLER.password);
  await Promise.all([
    page.waitForFunction(() => window.location.pathname === "/admin/ventas", { timeout: 90000 }),
    page.click('button[type="submit"]')
  ]);

  check("la vendedora aterriza en /admin/ventas", true);

  await page.waitForSelector(".order-page");
  const navLabels = await page.$$eval(".topbar-nav .nav-pill", (nodes) => nodes.map((node) => node.textContent?.trim()));
  check("solo ve la sección de ventas", navLabels.length === 1 && navLabels[0] === "Ventas",
    `navegación = ${JSON.stringify(navLabels)}`);

  console.log("\n2. Arma la venta desde el catálogo");

  await page.waitForSelector(".order-search");
  await page.type(".order-search", "Gel Evolution");
  await page.waitForFunction(
    () => document.querySelectorAll(".order-product").length > 0,
    { timeout: 30000 }
  );
  await page.click(".order-product");
  await page.waitForSelector(".order-variant");

  // Se agregan dos unidades de la primera presentación disponible.
  const added = await page.$$eval(".order-variant", (nodes) => {
    const target = nodes.find((node) => !node.querySelector("button")?.disabled);
    if (!target) return null;
    target.querySelector("button").click();
    return target.querySelector("small")?.textContent ?? "";
  });
  check("agrega una presentación disponible", added !== null, "todas las presentaciones salían agotadas");

  await page.waitForSelector(".order-line");
  await page.click(".order-qty button:last-child");

  await page.waitForFunction(
    () => document.querySelector(".sale-totals-final b")?.textContent?.includes("S/"),
    { timeout: 30000 }
  );

  const total = await page.$eval(".sale-totals-final b", (node) => node.textContent?.trim());
  check("PostgreSQL resuelve el total y la pantalla lo muestra", Boolean(total && total !== "—"), `total = ${total}`);

  console.log("\n3. Cobra y registra");

  await page.$$eval(".sale-payment .btn-soft", (nodes) => nodes[0].click());
  await page.waitForFunction(
    () => document.querySelector(".sale-balance--ok") !== null,
    { timeout: 15000 }
  );
  check("el botón de completar cuadra el cobro al céntimo", true);

  await page.click(".order-actions .btn-save");
  // Se espera el TEXTO, no el elemento: el aviso de «producto agregado» sigue en
  // pantalla y un waitForSelector lo daría por bueno sin haber cobrado nada.
  const toast = await page
    .waitForFunction(
      () => {
        const text = document.querySelector(".toast")?.textContent ?? "";
        return /Venta NV-\d{6} registrada/.test(text) ? text : false;
      },
      { timeout: 60000 }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => "");
  check("la venta se registra y devuelve su correlativo", /Venta NV-\d{6} registrada/.test(toast), `toast = ${toast}`);

  await page.waitForFunction(
    () => document.querySelectorAll(".order-history-item").length > 0,
    { timeout: 30000 }
  );

  console.log("\n4. Lo que la base debe haber hecho");

  const sales = must(
    await admin.from("sales").select("id, sale_number, total, seller_label, status").order("issued_at", { ascending: false }).limit(1),
    "venta registrada"
  );
  const sale = sales[0];
  createdSaleId = sale?.id;

  check("queda una venta confirmada con vendedora identificada",
    Boolean(sale) && sale.status === "confirmed" && sale.seller_label === "Vendedora demo",
    JSON.stringify(sale));

  const payments = must(
    await admin.from("sale_payments").select("amount").eq("sale_id", sale.id),
    "pagos de la venta"
  );
  const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  check("la cobranza suma exactamente el total", Math.abs(paid - Number(sale.total)) < 0.0001,
    `cobrado ${paid} · total ${sale.total}`);

  const after = await stockOf("DEMO-ESM-ROJO");
  check("la existencia bajó en las unidades vendidas", after.on_hand === before.on_hand - 2,
    `antes ${before.on_hand} · después ${after.on_hand}`);

  const costs = must(
    await admin.from("sale_line_costs").select("unit_cost, cost_basis").eq("sale_id", sale.id),
    "costos capturados"
  );
  check("cada línea capturó su costo al confirmar",
    costs.length > 0 && costs.every((cost) => cost.cost_basis !== null),
    JSON.stringify(costs));

  console.log("\n5. La vendedora no ve el costo por ninguna vía");

  const detail = await page.evaluate(async (id) => {
    const response = await fetch(`/api/admin/sales/${id}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  }, sale.id);

  check("el detalle que sirve la aplicación llega sin bloque de costo",
    detail.status === 200 && detail.body.data.lines.every((line) => line.cost === null || line.cost === undefined),
    JSON.stringify(detail.body?.data?.lines?.map((line) => line.cost)));

  const forbidden = await page.evaluate(async () => {
    const response = await fetch("/api/admin/productos", { method: "GET" }).catch(() => null);
    return response?.status ?? 0;
  });
  check("y el panel de catálogo no le abre ninguna ruta", forbidden !== 200, `status = ${forbidden}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (createdSaleId) {
    const cleanup = await admin.from("sales").delete().eq("id", createdSaleId);
    if (cleanup.error) console.log(`  aviso: no se pudo limpiar la venta (${cleanup.error.message})`);
  }
}

console.log(failures === 0 ? "\nPASS · sin fallos" : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
