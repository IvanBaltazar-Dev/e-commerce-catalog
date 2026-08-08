/**
 * Capturas de las cuatro superficies de control del rediseño (Fase 0, §3.4).
 *
 *   B1 Nueva venta         → velocidad operativa
 *   F2 Ficha de producto   → 1.168 líneas de formulario
 *   H1 Analítica           → tablas, cifras y jerarquía
 *   P1 Catálogo público    → lo visual/editorial
 *
 * No son cuatro rediseños: son los cuatro controles que dicen si la Fundación
 * sirve. Por eso hay que tener el ANTES capturado antes de tocar una línea.
 *
 * Uso:
 *   node scripts/shoot-surfaces.mjs --label before
 *   node scripts/shoot-surfaces.mjs --label after
 *
 * Salida: test-results/redesign/<label>/<superficie>-<viewport>.png + manifest.json
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const labelArg = process.argv.indexOf("--label");
const LABEL = labelArg >= 0 ? process.argv[labelArg + 1] : "before";
if (!/^[a-z0-9-]+$/.test(LABEL ?? "")) {
  console.error("✗ --label admite solo minúsculas, dígitos y guiones (before, after, 0-1-tipografia…)");
  process.exit(1);
}

// Este script escribe credenciales de administración en un formulario. Que el
// destino sea local no es un detalle de conveniencia: es la condición para
// ejecutarlo.
const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser http://localhost o http://127.0.0.1 — recibido: ${BASE_URL}`);
  console.error("  Este script teclea credenciales de admin; no se apunta a un entorno remoto.");
  process.exit(1);
}

const OUT = path.join(ROOT, "test-results", "redesign", LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { label: "escritorio", width: 1440, height: 900, deviceScaleFactor: 1.5, isMobile: false },
  { label: "movil", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true }
];

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

const manifest = { label: LABEL, baseUrl: BASE_URL, shots: [] };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // ── sesión de administración ──
  let signedIn = false;
  for (let attempt = 1; attempt <= 4 && !signedIn; attempt += 1) {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const inside = await page.waitForFunction(
      () => window.location.pathname !== "/admin/login" && window.location.pathname.startsWith("/admin"),
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    if (inside) { signedIn = true; break; }
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.$eval('input[type="email"]', (node) => { node.value = ""; });
    await page.$eval('input[type="password"]', (node) => { node.value = ""; });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    signedIn = await page.waitForFunction(
      () => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login",
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
  }
  if (!signedIn) throw new Error("Sin sesión de administración: ¿está sembrada la base local?");

  // ── descubrir contenido real en vez de fijar ids a mano ──
  async function firstHref(url, pattern) {
    await page.goto(`${BASE_URL}${url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle();
    return page.evaluate((source) => {
      const rx = new RegExp(source);
      const link = [...document.querySelectorAll("a[href]")]
        .map((node) => node.getAttribute("href"))
        .find((href) => rx.test(href));
      return link ?? null;
    }, pattern);
  }

  async function settle() {
    await page.waitForFunction(() => !document.querySelector(".order-loading"), { timeout: 30000 })
      .catch(() => { /* un loader eterno también es información: se ve en la captura */ });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  // La home no enlaza las fichas con <a href>: navega con router.push sobre un
  // div. No hay anchor que leer, así que se descubre recorriendo el camino real
  // del visitante — clic en la primera tarjeta y ver dónde aterriza.
  async function firstPublicFicha() {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle();
    const card = await page.$(".pub-card-img");
    if (!card) return null;
    await card.click();
    const landed = await page.waitForFunction(
      () => window.location.pathname.startsWith("/producto/"),
      { timeout: 15000 }
    ).then(() => true).catch(() => false);
    return landed ? new URL(page.url()).pathname : null;
  }

  const fichaHref = await firstHref("/admin/productos", "^/admin/productos/[0-9a-f-]{16,}$");
  const publicHref = await firstPublicFicha();

  if (!fichaHref) console.warn("  · sin producto en la lista: F2 caerá en /admin/productos/nuevo");
  if (!publicHref) console.warn("  · sin ficha pública alcanzable desde la home: P1 solo capturará la home");

  const SURFACES = [
    { key: "B1-nueva-venta", name: "B1 · Nueva venta", url: "/admin/ventas" },
    { key: "F2-ficha-producto", name: "F2 · Ficha de producto", url: fichaHref ?? "/admin/productos/nuevo" },
    { key: "H1-analitica", name: "H1 · Analítica", url: "/admin/analitica" },
    { key: "P1-publico-home", name: "P1 · Catálogo público (home)", url: "/" },
    ...(publicHref ? [{ key: "P1-publico-ficha", name: "P1 · Ficha pública", url: publicHref }] : [])
  ];

  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport);

    for (const surface of SURFACES) {
      await page.goto(`${BASE_URL}${surface.url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await settle();

      // Medir ANTES de disparar: una captura fullPage puede redimensionar el
      // viewport y falsear el desborde.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );

      const file = `${surface.key}-${viewport.label}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: true });

      manifest.shots.push({ surface: surface.name, url: surface.url, viewport: viewport.label, file, overflow });
      console.log(`  ✓ ${viewport.label.padEnd(11)} ${surface.name}${overflow > 1 ? `  ⚠ overflow +${overflow}px` : ""}`);
    }
  }

  writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`\n✓ ${manifest.shots.length} capturas en test-results/redesign/${LABEL}/`);
} finally {
  await browser.close();
}
