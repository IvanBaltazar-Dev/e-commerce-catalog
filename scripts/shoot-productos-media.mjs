/**
 * Captura de /admin/productos con el estado fotográfico a la vista.
 *
 * Comprueba lo que la lista no sabía decir: cuántos productos tienen foto,
 * cuántos están publicados, y que la miniatura salga de la imagen colgada de
 * una variante y no del `main_image_path` que está vacío en los 1.051.
 *
 * Uso:
 *   node scripts/shoot-productos-media.mjs --label despues
 *
 * Salida: test-results/productos-media/<label>/*.png
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3006";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const labelArg = process.argv.indexOf("--label");
const LABEL = labelArg >= 0 ? process.argv[labelArg + 1] : "despues";
if (!/^[a-z0-9-]+$/.test(LABEL ?? "")) {
  console.error("✗ --label admite solo minúsculas, dígitos y guiones");
  process.exit(1);
}

// Mismo cerrojo que shoot-surfaces.mjs: este script teclea credenciales de
// administración en un formulario, y que el destino sea local es la condición
// para ejecutarlo, no una comodidad.
const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser http://localhost o http://127.0.0.1 — recibido: ${BASE_URL}`);
  process.exit(1);
}

const OUT = path.join(ROOT, "test-results", "productos-media", LABEL);
mkdirSync(OUT, { recursive: true });

// Móvil de verdad: userAgent, puntos táctiles y isMobile. Un viewport estrecho
// en un navegador de escritorio no prueba nada de lo que se rompe en un
// teléfono.
const MOVIL = {
  label: "movil",
  viewport: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
};
const ESCRITORIO = {
  label: "escritorio",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1.5, isMobile: false },
  userAgent: null
};

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

const resultados = [];

try {
  const page = await browser.newPage();
  await page.setViewport(ESCRITORIO.viewport);

  let enVuelo = 0;
  page.on("request", () => { enVuelo += 1; });
  page.on("requestfinished", () => { enVuelo -= 1; });
  page.on("requestfailed", () => { enVuelo -= 1; });

  async function settle() {
    await page.waitForFunction(() => !document.querySelector(".loading-block"), { timeout: 30000 })
      .catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    let previo = -1;
    let quieto = 0;
    let intentos = 0;
    while (intentos < 60 && quieto < 5) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      intentos += 1;
      const alto = await page.evaluate(() => document.documentElement.scrollHeight);
      quieto = alto === previo && enVuelo <= 0 ? quieto + 1 : 0;
      previo = alto;
    }
  }

  let signedIn = false;
  for (let attempt = 1; attempt <= 4 && !signedIn; attempt += 1) {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const inside = await page.waitForFunction(
      () => window.location.pathname !== "/admin/login" && window.location.pathname.startsWith("/admin"),
      { timeout: 3000 }
    ).then(() => true).catch(() => false);
    if (inside) { signedIn = true; break; }
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    signedIn = await page.waitForFunction(
      () => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login",
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
  }
  if (!signedIn) throw new Error("Sin sesión de administración: ¿está sembrada la base local?");

  // Lo que el panel afirma, leído del DOM. Si la lista vuelve a quedarse ciega,
  // esto lo dice sin que haya que mirar una captura.
  async function leerPanel() {
    return page.evaluate(() => {
      const segmentos = [...document.querySelectorAll(".cov-line")].map((line) => ({
        dimension: line.querySelector(".cov-label")?.textContent?.trim() ?? "",
        medida: line.querySelector(".cov-meter-fill")?.getAttribute("style") ?? "",
        valores: [...line.querySelectorAll(".cov-seg")].map((seg) => seg.textContent?.trim())
      }));
      const filas = [...document.querySelectorAll(".row")].map((row) => ({
        nombre: row.querySelector(".row-name")?.textContent?.trim(),
        conImagen: Boolean(row.querySelector(".row-thumb img")),
        src: row.querySelector(".row-thumb img")?.getAttribute("src") ?? null,
        contador: row.querySelector(".row-thumb-count")?.textContent?.trim() ?? null
      }));
      return { segmentos, filas, encabezado: document.querySelector(".page-sub")?.textContent?.trim() };
    });
  }

  for (const perfil of [ESCRITORIO, MOVIL]) {
    await page.setViewport(perfil.viewport);
    if (perfil.userAgent) {
      await page.setUserAgent(perfil.userAgent);
    }

    const t0 = Date.now();
    await page.goto(`${BASE_URL}/admin/productos`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle();
    const carga = Date.now() - t0;

    const panel = await leerPanel();
    resultados.push({ perfil: perfil.label, carga_ms: carga, ...panel });

    await page.screenshot({ path: path.join(OUT, `productos-${perfil.label}.png`), fullPage: false });
    console.log(`✓ ${perfil.label} · ${carga} ms · ${panel.filas.filter((f) => f.conImagen).length}/${panel.filas.length} filas con imagen`);
    for (const linea of panel.segmentos) {
      console.log(`   ${linea.dimension}: ${linea.valores.join("  |  ")}`);
    }

    // La primera carga de un dev server compila la ruta; medirla no dice nada
    // del coste real. La segunda sí.
    const t1 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await settle();
    const recarga = Date.now() - t1;
    resultados[resultados.length - 1].recarga_ms = recarga;
    console.log(`   recarga en caliente: ${recarga} ms`);

    async function filtrar(texto) {
      const boton = await page.evaluateHandle(
        (t) => [...document.querySelectorAll(".cov-seg")].find((seg) => seg.textContent?.includes(t)) ?? null,
        texto
      );
      const el = boton.asElement();
      if (!el) return null;
      await el.click();
      await settle();
      return leerPanel();
    }

    // El filtro que es la razón de esta pantalla: ver exactamente lo que falta.
    const sinFoto = await filtrar("sin foto");
    if (sinFoto) {
      resultados.push({ perfil: `${perfil.label}-sin-foto`, ...sinFoto });
      await page.screenshot({ path: path.join(OUT, `productos-${perfil.label}-sin-foto.png`), fullPage: false });
      console.log(`✓ ${perfil.label} «sin foto» · ${sinFoto.encabezado} · ${sinFoto.filas.filter((f) => f.conImagen).length} con imagen (debe ser 0)`);
    }

    // Y el contrario, que es donde se comprueba lo que de verdad se arregló: la
    // miniatura sale de una foto colgada de una variante.
    await filtrar("sin foto");
    const conFoto = await filtrar("con foto");
    if (conFoto) {
      resultados.push({ perfil: `${perfil.label}-con-foto`, ...conFoto });
      await page.screenshot({ path: path.join(OUT, `productos-${perfil.label}-con-foto.png`), fullPage: false });
      const conImagen = conFoto.filas.filter((f) => f.conImagen).length;
      console.log(`✓ ${perfil.label} «con foto» · ${conFoto.encabezado} · ${conImagen}/${conFoto.filas.length} con imagen`);
      for (const fila of conFoto.filas) {
        console.log(`   · ${fila.nombre} — imagen: ${fila.conImagen ? "sí" : "NO"} · contador: ${fila.contador ?? "—"}`);
      }
    }
    await filtrar("con foto");
  }

  writeFileSync(path.join(OUT, "lectura.json"), JSON.stringify(resultados, null, 2), "utf8");
  console.log(`\n→ ${OUT}`);
} finally {
  await browser.close();
}
