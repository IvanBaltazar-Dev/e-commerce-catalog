// Renderiza catalog-preview/catalogo.html -> catalogo.pdf (A4) + capturas PNG de páginas.
// Uso: node scripts/render-pdf.mjs
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREVIEW = path.join(ROOT, "catalog-preview");
const HTML = path.join(PREVIEW, "catalogo.html");
const SHOTS = path.join(PREVIEW, "shots");

await mkdir(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1273, deviceScaleFactor: 2 });

await page.goto(pathToFileURL(HTML).href, { waitUntil: "networkidle0", timeout: 60000 });
try {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));
} catch {}

// PDF
await page.emulateMediaType("print");
await page.pdf({
  path: path.join(PREVIEW, "catalogo.pdf"),
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
});
console.log("✅ catalogo.pdf generado");

// Capturas de páginas concretas (media 'screen')
await page.emulateMediaType("screen");
async function shot(el, name) {
  if (!el) {
    console.log(`(no encontrado: ${name})`);
    return;
  }
  await el.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  shot ${name}.png`);
}
const products = await page.$$(".product");
const cartas = await page.$$(".carta");
await shot(await page.$(".cover"), "01-cover");
await shot(await page.$(".intro"), "02-intro");
await shot(products[0], "03-ficha-masglo");
await shot(cartas[0], "04-carta-masglo");
await shot(products[7], "05-ficha-glam-consulta");
await shot(await page.$(".closing"), "06-cierre");

await browser.close();
console.log("✅ Capturas en catalog-preview/shots/");
