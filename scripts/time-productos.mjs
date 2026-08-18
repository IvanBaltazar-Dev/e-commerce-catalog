/**
 * Dónde se van los segundos de /admin/productos.
 *
 * El requisito es 3 s. Mide por separado la navegación, cada petición que la
 * pantalla dispara, y el tiempo hasta que la lista está pintada — porque «la
 * página tarda» no dice si la culpa es del HTML, de la sesión o de los datos.
 *
 * Uso:  UI_BASE_URL=http://localhost:3002 node scripts/time-productos.mjs
 */
import puppeteer from "puppeteer";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser local — recibido: ${BASE_URL}`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const yaDentro = await page
    .waitForFunction(() => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login", { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!yaDentro) {
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login", { timeout: 30000 });
  }

  for (const vuelta of [1, 2, 3]) {
    const peticiones = new Map();
    const medidas = [];
    const onRequest = (req) => peticiones.set(req, Date.now());
    const onDone = (req) => {
      const t0 = peticiones.get(req);
      if (!t0) return;
      const url = req.url().replace(BASE_URL, "");
      if (url.startsWith("/api/") || url.startsWith("/admin/productos")) {
        medidas.push({ url: url.slice(0, 70), ms: Date.now() - t0 });
      }
      peticiones.delete(req);
    };
    page.on("request", onRequest);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);

    const t0 = Date.now();
    await page.goto(`${BASE_URL}/admin/productos`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const domReady = Date.now() - t0;

    // Lo que de verdad le importa a la dueña: cuándo puede leer la lista.
    await page.waitForSelector(".row", { timeout: 60000 });
    const listaVisible = Date.now() - t0;

    await page.waitForSelector(".cov-seg", { timeout: 60000 });
    const panelVisible = Date.now() - t0;

    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);

    console.log(`\n── vuelta ${vuelta} ──`);
    console.log(`  HTML servido:       ${domReady} ms`);
    console.log(`  panel a la vista:   ${panelVisible} ms`);
    console.log(`  lista a la vista:   ${listaVisible} ms   ${listaVisible <= 3000 ? "✓ dentro de 3 s" : "✗ POR ENCIMA DE 3 s"}`);
    for (const m of medidas.sort((a, b) => b.ms - a.ms).slice(0, 6)) {
      console.log(`     ${String(m.ms).padStart(6)} ms  ${m.url}`);
    }
  }
} finally {
  await browser.close();
}
