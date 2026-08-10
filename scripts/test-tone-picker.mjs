/**
 * Criterio de terminado de la carta de tonos pública.
 *
 * La prueba es la del brief: con los 164 tonos de MASGLO, una persona debe
 * poder encontrar «Activista» buscando, o acotar por familia cromática y
 * elegir mirando, sin recorrer una lista de nombres ni una galería de 164
 * envases. Y elegir tono debe ser UNA acción.
 *
 * Móvil con emulación de dispositivo, no con ventana estrecha: es la misma
 * regla que documenta test-responsive-sweep.mjs. Fijar solo el ancho mide un
 * escritorio angosto y deja pasar desbordes reales.
 *
 *   npm run test:tone-picker                    (contra el dev server de la sesión)
 *   UI_BASE_URL=http://localhost:3002 npm run test:tone-picker
 *
 * Deja capturas en test-results/.
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3006";
const SLUG = process.env.TONE_SLUG ?? "masglo-esmalte-masglo-4c95f3";

// Rangos del brief. El área táctil de 44px es el mínimo de la W3C; los tonos
// por fila son lo que convierte la rejilla en carta de colores y no en lista.
const VIEWPORTS = [
  { label: "escritorio", width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1, porFila: [9, 12] },
  { label: "móvil", width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2, porFila: [6, 7] }
];

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !extra ? "" : ` — ${extra}`}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });

  for (const viewport of VIEWPORTS) {
    // El objeto entero: quedarse con width/height desactivaría la emulación.
    const { label, porFila, ...metrics } = viewport;
    await page.setViewport(metrics);

    const consoleErrors = [];
    const onConsole = (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/Download the React DevTools|third-party cookie|favicon/i.test(text)) return;
      consoleErrors.push(text.slice(0, 160));
    };
    page.on("console", onConsole);

    // Se entra por un tono distinto del predeterminado a propósito: si se
    // entrara por «Activista», buscarlo y tocarlo no cambiaría la foto grande y
    // la comprobación de abajo pasaría sin haber probado nada.
    await page.goto(`${BASE_URL}/producto/${SLUG}?variante=313987`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".pub-tones-grid", { timeout: 40000 });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const layout = await page.evaluate(() => {
      const grid = document.querySelector(".pub-tones-grid");
      const items = [...grid.querySelectorAll(".pub-tone")];
      const firstTop = items[0].offsetTop;
      const index = items.findIndex((item) => item.offsetTop > firstTop);
      const box = items[0].getBoundingClientRect();
      const rows = Math.round((grid.clientHeight + 8) / (box.height + 8));
      const selected = grid.querySelector('[aria-checked="true"]');
      const selBox = selected.getBoundingClientRect();
      const gridBox = grid.getBoundingClientRect();
      return {
        porFila: index === -1 ? items.length : index,
        total: items.length,
        ancho: Math.round(box.width),
        alto: Math.round(box.height),
        filasVisibles: rows,
        desbordaInternamente: grid.scrollHeight > grid.clientHeight,
        fotosEnRejilla: grid.querySelectorAll("img").length,
        // Ningún texto bajo los círculos: el nombre vive en el pie.
        textoEnLaRejilla: grid.innerText.trim().length,
        tonoElegidoVisible: selBox.top >= gridBox.top - 1 && selBox.bottom <= gridBox.bottom + 1,
        paradasDeTabulador: items.filter((item) => item.tabIndex === 0).length,
        desbordeHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        pie: document.querySelector(".pub-tones-picked-name")?.innerText ?? ""
      };
    });

    const [min, max] = porFila;
    check(`${label}: ${layout.porFila} tonos por fila (${min}–${max})`, layout.porFila >= min && layout.porFila <= max, String(layout.porFila));
    check(`${label}: área táctil ${layout.ancho}×${layout.alto} ≥ 44×44`, layout.ancho >= 44 && layout.alto >= 44);
    check(`${label}: ~4 filas visibles y el resto con scroll interno`, layout.filasVisibles >= 4 && layout.filasVisibles <= 5 && layout.desbordaInternamente, `${layout.filasVisibles} filas`);
    check(`${label}: ninguna fotografía de envase dentro de la rejilla`, layout.fotosEnRejilla === 0, `${layout.fotosEnRejilla} imágenes`);
    check(`${label}: sin nombres bajo los círculos`, layout.textoEnLaRejilla === 0, `${layout.textoEnLaRejilla} caracteres`);
    check(`${label}: la rejilla se abre sobre el tono elegido`, layout.tonoElegidoVisible);
    check(`${label}: una sola parada de tabulador entre ${layout.total} tonos`, layout.paradasDeTabulador === 1, String(layout.paradasDeTabulador));
    check(`${label}: sin desborde horizontal`, layout.desbordeHorizontal <= 1, `+${layout.desbordeHorizontal}px`);

    // Buscar «activista» y elegirlo: una acción, sin recargar la página.
    const flow = await page.evaluate(async () => {
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      const input = document.querySelector(".pub-tones-search input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "activista");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await espera(150);
      const tras = [...document.querySelectorAll(".pub-tones-grid .pub-tone")];
      const antesImagen = document.querySelector(".pub-gallery-frame img")?.getAttribute("src") ?? "";
      const marca = performance.now();
      tras[0]?.click();
      await espera(200);
      return {
        resultados: tras.length,
        aria: tras[0]?.getAttribute("aria-label") ?? "",
        imagenCambio: (document.querySelector(".pub-gallery-frame img")?.getAttribute("src") ?? "") !== antesImagen,
        pie: document.querySelector(".pub-tones-picked-name")?.innerText ?? "",
        totalLinea: document.querySelector(".pub-ficha-totalrow")?.innerText.replace(/\n/g, " · ") ?? "",
        urlCompartible: location.search,
        // Si la página se hubiera recargado, este marcador no sobreviviría.
        sinRecarga: performance.now() > marca
      };
    });

    check(`${label}: buscar «activista» deja ${flow.resultados} resultado`, flow.resultados === 1, `${flow.resultados}: ${flow.aria}`);
    check(`${label}: un toque cambia la foto grande`, flow.imagenCambio);
    check(`${label}: un toque actualiza el tono elegido (${flow.pie})`, flow.pie === "Activista", flow.pie);
    check(`${label}: un toque actualiza el total (${flow.totalLinea})`, flow.totalLinea.includes("Activista"), flow.totalLinea);
    check(`${label}: el enlace queda compartible`, flow.urlCompartible.includes("variante="), flow.urlCompartible);
    check(`${label}: sin recarga de página`, flow.sinRecarga);
    check(`${label}: sin errores de consola`, consoleErrors.length === 0, consoleErrors.join(" | "));
    page.off("console", onConsole);

    // Captura con la vista limpia, no con la búsqueda puesta.
    await page.evaluate(() => {
      const input = document.querySelector(".pub-tones-search input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const shot = path.join(ROOT, "test-results", `carta-tonos-${label}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  captura → ${path.relative(ROOT, shot)}`);
  }
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones en verde.`);
if (failed.length > 0) {
  console.error(`Fallan: ${failed.map((item) => item.name).join(" · ")}`);
  process.exit(1);
}
