/**
 * Contraste WCAG AA sobre las superficies reales (Fase 0, criterio 6).
 *
 * No mide la paleta en abstracto: recorre el texto que de verdad se pinta en
 * cada pantalla, resuelve su color y el del primer ancestro con fondo opaco, y
 * exige 4.5:1 (3:1 si el texto es grande). Un token puede estar aprobado y aun
 * así quedar ilegible sobre la superficie donde acaba usándose.
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser local — recibido: ${BASE_URL}`);
  process.exit(1);
}

const SUPERFICIES = [
  { nombre: "B1 · Nueva venta", url: "/admin/ventas", admin: true },
  { nombre: "H1 · Analítica", url: "/admin/analitica", admin: true },
  { nombre: "F2 · Ficha de producto", url: "/admin/productos/nuevo", admin: true },
  { nombre: "P1 · Catálogo público", url: "/", admin: false }
];

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

let fallos = 0;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  let dentro = false;
  for (let intento = 1; intento <= 4 && !dentro; intento += 1) {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!new URL(page.url()).pathname.endsWith("/login")) { dentro = true; break; }
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.$eval('input[type="email"]', (n) => { n.value = ""; });
    await page.$eval('input[type="password"]', (n) => { n.value = ""; });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    dentro = await page.waitForFunction(
      () => window.location.pathname.startsWith("/admin") && !window.location.pathname.endsWith("/login"),
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
  }
  if (!dentro) throw new Error("Sin sesión de administración.");

  for (const sup of SUPERFICIES) {
    await page.goto(`${BASE_URL}${sup.url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector(".order-loading"), { timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    const malos = await page.evaluate(() => {
      const lum = (c) => {
        const s = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
      };
      const parse = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const ratio = (a, b) => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      // Mezcla el color sobre su fondo cuando el texto es translúcido.
      const mezcla = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

      const fondoDe = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const cs = getComputedStyle(n);
          const c = parse(cs.backgroundColor);
          if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c.slice(0, 3);
          n = n.parentElement;
        }
        return [255, 255, 255];
      };

      const out = [];
      const vistos = new Set();
      for (const el of document.querySelectorAll("body *")) {
        const texto = [...el.childNodes]
          .filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
          .map((n) => n.textContent.trim()).join(" ");
        if (!texto) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.5) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;

        const fg = parse(cs.color);
        const bg = fondoDe(el);
        const alpha = fg[3] === undefined ? 1 : fg[3];
        const color = alpha < 1 ? mezcla(fg.slice(0, 3), bg, alpha) : fg.slice(0, 3);

        const px = parseFloat(cs.fontSize);
        const peso = Number(cs.fontWeight) || 400;
        const grande = px >= 24 || (px >= 18.66 && peso >= 700);
        const minimo = grande ? 3 : 4.5;
        const c = ratio(color, bg);
        if (c >= minimo) continue;

        const clave = `${el.className}|${cs.color}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        out.push({
          clase: (typeof el.className === "string" ? el.className : "").slice(0, 40) || el.tagName.toLowerCase(),
          texto: texto.slice(0, 34),
          ratio: c.toFixed(2),
          minimo,
          px
        });
      }
      return out;
    });

    if (malos.length === 0) {
      console.log(`✓ ${sup.nombre}`);
    } else {
      fallos += malos.length;
      console.log(`✗ ${sup.nombre} — ${malos.length} con contraste por debajo de AA:`);
      for (const m of malos.slice(0, 8)) {
        console.log(`      ${m.ratio}:1 (mín ${m.minimo}) · ${m.px}px · .${m.clase} · «${m.texto}»`);
      }
    }
  }
} finally {
  await browser.close();
}

console.log(fallos === 0
  ? "\n✓ Contraste AA en las cuatro superficies de control."
  : `\n✗ ${fallos} combinación(es) por debajo de AA.`);
process.exit(fallos === 0 ? 0 : 1);
