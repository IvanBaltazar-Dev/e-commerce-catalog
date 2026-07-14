// Captura el catálogo público (home + ficha) en desktop y móvil para revisión/entrega.
// Requiere el dev server corriendo en http://localhost:3000
// Uso: node scripts/shoot-public.mjs
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "catalog-preview", "public-shots");
await mkdir(OUT, { recursive: true });

const BASE = "http://localhost:3000";
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

async function shoot(page, url, name, fullPage) {
  await page.goto(BASE + url, { waitUntil: "networkidle0", timeout: 60000 });
  try {
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await new Promise((r) => setTimeout(r, 600));
  } catch {}
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log(`  shot ${name}.png`);
}

// Desktop
const d = await browser.newPage();
await d.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1.5 });
await shoot(d, "/", "home-desktop", true);
await shoot(d, "/producto/masglo-tradicional", "ficha-desktop", false);
await shoot(d, "/producto/glam-nails-gel-polish-12ml", "ficha-glam-desktop", false);
await d.close();

// Móvil (390px, mobile-first del brief)
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await shoot(m, "/", "home-mobile", true);
await shoot(m, "/producto/masglo-tradicional", "ficha-mobile", false);
await m.close();

await browser.close();
console.log("✅ Capturas del público en catalog-preview/public-shots/");
