import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";
const TARGET = "/admin/catalogo/revisar/decisiones";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon.*404/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().startsWith(BASE_URL)) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (new URL(page.url()).pathname.endsWith("/login")) {
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);
  }

  await page.goto(`${BASE_URL}${TARGET}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".rd-list-card", { timeout: 30000 });
  const queue = await page.evaluate(() => ({
    cards: document.querySelectorAll(".rd-list-card").length,
    text: document.body.innerText,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert.ok(queue.cards > 0, "La cola no mostró decisiones.");
  assert.ok(queue.text.includes("decisiones pendientes"));
  assert.equal(queue.overflow, 0, "La cola desborda horizontalmente en escritorio.");
  for (const forbidden of ["rule_code", "fingerprint", "Qué recomienda Bellaroshé", "Evidencia heurística"]) {
    assert.equal(queue.text.includes(forbidden), false, `La cola expone lenguaje técnico o descartado: ${forbidden}`);
  }

  await page.click(".rd-list-card > button");
  await page.waitForSelector(".rd-action-panel", { timeout: 30000 });
  const decision = await page.evaluate(() => ({
    text: document.body.innerText,
    evidenceClosed: !document.querySelector(".rd-evidence")?.hasAttribute("open"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  for (const copy of ["Qué problema corrige", "Qué recomendamos", "Qué va a resolver", "¿Y si no estamos seguros", "Anotar y guardar pendiente"]) {
    assert.ok(decision.text.includes(copy), `Falta el texto de producto: ${copy}`);
  }
  assert.equal(decision.evidenceClosed, true, "La evidencia debe iniciar cerrada.");
  assert.equal(decision.overflow, 0, "La decisión desborda horizontalmente en escritorio.");

  await page.click(".rd-save-later");
  await page.waitForSelector(".rd-defer-form");
  assert.ok((await page.$eval(".rd-defer-form", (node) => node.innerText)).includes("No es un sí ni un no"));

  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  await page.screenshot({
    path: path.join(ROOT, "test-results", "catalog-relation-decision-desktop.png"),
    fullPage: true,
  });

  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(`${BASE_URL}${TARGET}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".rd-list-card", { timeout: 30000 });
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(mobileOverflow <= 1, `La cola móvil desborda ${mobileOverflow}px.`);
  await page.screenshot({
    path: path.join(ROOT, "test-results", "catalog-relation-decisions-mobile.png"),
    fullPage: true,
  });

  assert.deepEqual(consoleErrors, [], `Errores de consola: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(failedResponses, [], `Respuestas 5xx: ${failedResponses.join(" | ")}`);
  console.log(JSON.stringify({ result: "PASS", queueCards: queue.cards, desktopOverflow: queue.overflow, mobileOverflow }, null, 2));
} finally {
  await browser.close();
}
