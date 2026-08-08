/**
 * Barrido de superficies reales (Bloque 5, §10): escritorio (1440×900) y
 * móvil (375×812) sobre el build de producción con sesión real.
 *
 * Por cada superficie exige:
 *   · sin overflow horizontal (scrollWidth ≤ viewport + 1px),
 *   · sin loaders eternos (nada de .order-loading tras estabilizar),
 *   · sin errores de consola ni de hidratación,
 *   · sin peticiones fallidas propias (respuestas 5xx del mismo origen).
 *
 * Deja capturas móviles de las superficies clave en test-results/.
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-responsive-sweep" });

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const SURFACES = [
  { name: "público · home", url: "/", admin: false, shot: true },
  { name: "público · selección", url: "/seleccion", admin: false, shot: true },
  { name: "admin · productos", url: "/admin/productos", admin: true, shot: false },
  { name: "admin · venta", url: "/admin/ventas", admin: true, shot: true },
  { name: "admin · compras", url: "/admin/compras", admin: true, shot: false },
  { name: "admin · inventario", url: "/admin/inventario", admin: true, shot: false },
  { name: "admin · caja", url: "/admin/caja", admin: true, shot: false },
  { name: "admin · conversaciones", url: "/admin/conversaciones", admin: true, shot: false },
  { name: "admin · carritos", url: "/admin/carritos", admin: true, shot: false },
  { name: "admin · marketing", url: "/admin/atribucion", admin: true, shot: false },
  { name: "admin · analítica", url: "/admin/analitica", admin: true, shot: true },
  { name: "admin · asistente", url: "/admin/asistente", admin: true, shot: true }
];

const VIEWPORTS = [
  { label: "escritorio", width: 1440, height: 900 },
  { label: "móvil", width: 375, height: 812 }
];

// Ruido conocido que NO es defecto del producto.
const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /third-party cookie/i,
  /favicon.*404/i
];

const results = [];
function check(name, condition, extra = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || !extra ? "" : ` — ${extra}`}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();

  // Sesión admin una sola vez (escritorio).
  await page.setViewport({ width: 1440, height: 900 });
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
  if (!signedIn) throw new Error("Sin sesión de administración.");

  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  const evidence = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewport({ width: viewport.width, height: viewport.height });

    for (const surface of SURFACES) {
      const consoleErrors = [];
      const failedRequests = [];
      const onConsole = (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
        consoleErrors.push(text.slice(0, 160));
      };
      const onResponse = (response) => {
        if (response.status() >= 500 && response.url().startsWith(BASE_URL)) {
          failedRequests.push(`${response.status()} ${response.url().slice(BASE_URL.length, BASE_URL.length + 60)}`);
        }
      };
      page.on("console", onConsole);
      page.on("response", onResponse);

      try {
        await page.goto(`${BASE_URL}${surface.url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        // Estabilización: sin loaders y una pausa corta para hidratación.
        await page.waitForFunction(
          () => !document.querySelector(".order-loading"),
          { timeout: 30000 }
        ).catch(() => { /* el loader eterno se castiga abajo */ });
        await new Promise((resolve) => setTimeout(resolve, 900));

        const state = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          loader: Boolean(document.querySelector(".order-loading")),
          hydrationError: document.body.innerText.includes("Application error")
        }));

        const problems = [];
        if (state.overflow > 1) problems.push(`overflow horizontal +${state.overflow}px`);
        if (state.loader) problems.push("loader eterno");
        if (state.hydrationError) problems.push("error de aplicación en pantalla");
        if (consoleErrors.length) problems.push(`consola: ${consoleErrors[0]}`);
        if (failedRequests.length) problems.push(`5xx propio: ${failedRequests[0]}`);

        check(`${viewport.label} · ${surface.name}`, problems.length === 0, problems.join(" · "));
        evidence.push({ viewport: viewport.label, surface: surface.name, problems });

        if (surface.shot && viewport.label === "móvil") {
          const file = `sweep-movil-${surface.url.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "home"}.png`;
          await page.screenshot({ path: path.join(ROOT, "test-results", file) });
        }
      } finally {
        page.off("console", onConsole);
        page.off("response", onResponse);
      }
    }
  }

  writeFileSync(path.join(ROOT, "test-results", "responsive-sweep.md"), [
    "# Barrido escritorio + móvil sobre superficies reales",
    "",
    "| Viewport | Superficie | Estado |",
    "|---|---|---|",
    ...evidence.map((row) => `| ${row.viewport} | ${row.surface} | ${row.problems.length === 0 ? "✓" : `✗ ${row.problems.join(" · ")}`} |`),
    ""
  ].join("\n"));
  console.log("\nEvidencia: test-results/responsive-sweep.md (+ capturas móviles)");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} superficie(s) con defectos.`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} superficies limpias en escritorio y móvil.`);
