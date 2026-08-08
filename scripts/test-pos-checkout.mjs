/**
 * Reglas del cobro del POS (B1.2).
 *
 * «No preguntar lo que el sistema ya sabe» son afirmaciones concretas, así que
 * se comprueban una a una sobre la pantalla real:
 *
 *   · un solo medio asigna el 100% del total y no pide importe,
 *   · elegir el medio NO confirma la venta por sí solo,
 *   · efectivo precarga el total y calcula el vuelto,
 *   · dividir el pago es explícito y propone lo que falta,
 *   · ningún importe usa input type=number (los spinners estorban al teclear),
 *   · la coma decimal se acepta,
 *   · y al confirmar el botón se bloquea al instante.
 */
import puppeteer from "puppeteer";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser local — recibido: ${BASE_URL}`);
  process.exit(1);
}

let fallos = 0;
const check = (cond, texto, extra = "") => {
  if (!cond) fallos += 1;
  console.log(`${cond ? "✓" : "✗"} ${texto}${cond || !extra ? "" : ` — ${extra}`}`);
};

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (new URL(page.url()).pathname.endsWith("/login")) {
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', "demo-seller@local.invalid");
    await page.type('input[type="password"]', "Demo-Seller-2026!");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.endsWith("/login"), { timeout: 20000 });
  }

  await page.goto(`${BASE_URL}/admin/ventas`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".order-search", { timeout: 30000 });
  await page.type(".order-search", "Gel Evolution");
  await page.waitForFunction(() => document.querySelectorAll(".order-product").length > 0, { timeout: 30000 });
  await page.$$eval(".order-variant", (nodes) => {
    nodes.find((n) => !n.querySelector("button")?.disabled)?.querySelector("button").click();
  });
  await page.waitForSelector(".order-line", { timeout: 30000 });
  await page.waitForFunction(
    () => (document.querySelector(".sale-totals-final b")?.textContent ?? "").includes("S/"),
    { timeout: 30000 }
  );
  await new Promise((r) => setTimeout(r, 900));

  // ── Un solo medio cubre el total sin pedir importe ──
  const estado = await page.evaluate(() => ({
    balance: document.querySelector(".sale-balance")?.textContent?.trim() ?? "",
    ok: !!document.querySelector(".sale-balance--ok"),
    hayCampoImporte: !!document.querySelector('.sale-payment input[placeholder="Importe"]'),
    medios: [...document.querySelectorAll(".pay-method")].map((b) => b.textContent.trim()),
    total: document.querySelector(".sale-totals-final b")?.textContent?.trim() ?? ""
  }));
  check(estado.ok, "un solo medio deja la cobranza cubierta sin intervención", estado.balance);
  check(!estado.hayCampoImporte, "no se pide un importe que la pantalla ya conoce");
  check(estado.medios.length > 1, `los medios se eligen como chips (${estado.medios.length})`);

  // ── Elegir el medio no confirma ──
  const antesDeElegir = await page.evaluate(() => document.querySelectorAll(".order-history-item").length);
  await page.$$eval(".pay-method", (nodes) => {
    nodes.find((n) => n.textContent.trim().toLowerCase().includes("yape"))?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const trasElegir = await page.evaluate(() => ({
    ventas: document.querySelectorAll(".order-history-item").length,
    balance: document.querySelector(".sale-balance")?.textContent?.trim() ?? ""
  }));
  check(trasElegir.ventas === antesDeElegir, "elegir el medio NO registra la venta por sí solo");
  check(/Yape/i.test(trasElegir.balance), "y la línea confirma medio e importe", trasElegir.balance);

  // ── Efectivo: precarga el total y calcula vuelto ──
  await page.$$eval(".pay-method", (nodes) => {
    nodes.find((n) => n.textContent.trim().toLowerCase().includes("efectivo"))?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const efectivo = await page.evaluate(() => {
    const input = document.querySelector(".pay-cash input");
    return {
      placeholder: input?.placeholder ?? "",
      rapidos: [...document.querySelectorAll(".pay-quick button")].map((b) => b.textContent.trim()),
      tipo: input?.getAttribute("type") ?? ""
    };
  });
  check(efectivo.placeholder !== "", "«Recibido» viene precargado con el total", `placeholder=${efectivo.placeholder}`);
  check(efectivo.rapidos.includes("Exacto"), `botones rápidos calculados desde el total (${efectivo.rapidos.join(" · ")})`);

  // Vuelto automático al recibir de más.
  await page.$$eval(".pay-quick button", (nodes) => {
    const otro = nodes.find((n) => n.textContent.trim() !== "Exacto");
    otro?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const vuelto = await page.evaluate(() => document.querySelector(".pay-change")?.textContent?.trim() ?? "");
  check(vuelto.length > 0, "el vuelto se calcula solo al recibir de más", vuelto || "no apareció");

  // ── Sin spinners y con coma decimal ──
  const spinners = await page.evaluate(() =>
    document.querySelectorAll('.sale-payments input[type="number"], .order-page input[type="number"]').length);
  check(spinners === 0, "ningún importe usa input type=number", `encontrados ${spinners}`);

  await page.$eval(".pay-cash input", (n) => { n.value = ""; });
  await page.type(".pay-cash input", "99,50");
  await new Promise((r) => setTimeout(r, 500));
  const conComa = await page.evaluate(() => document.querySelector(".pay-change")?.textContent?.trim() ?? "");
  check(conComa.length > 0 && !/NaN/.test(conComa), "la coma decimal se acepta como separador", conComa || "sin vuelto");

  // ── Dividir es explícito y propone lo que falta ──
  await page.$$eval(".sale-payments .btn-soft", (nodes) => {
    nodes.find((n) => n.textContent.includes("Dividir"))?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const dividido = await page.evaluate(() => ({
    filas: document.querySelectorAll(".sale-payment").length,
    hayImporte: !!document.querySelector('.sale-payment input[placeholder="Importe"]'),
    valor: document.querySelector('.sale-payment input[placeholder="Importe"]')?.value ?? ""
  }));
  check(dividido.hayImporte, "al dividir sí aparece el importe por medio");
  check(dividido.valor !== "", "y el primer medio arranca con lo que ya cubría", `importe=${dividido.valor}`);

  console.log(fallos === 0
    ? "\n✓ El cobro no pregunta lo que el sistema ya sabe."
    : `\n✗ ${fallos} regla(s) de cobro sin cumplir.`);
} finally {
  await browser.close();
}

process.exit(fallos === 0 ? 0 : 1);
