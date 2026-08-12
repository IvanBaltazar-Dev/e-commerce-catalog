/**
 * Contrato de navegación (S2).
 *
 * Agrupar trece entradas planas en ocho áreas cambia la arquitectura de
 * información, no la de rutas. Esta puerta comprueba justamente eso:
 *
 *   · cada ruta del panel sigue respondiendo donde siempre,
 *   · cada ruta marca su área en la barra,
 *   · y la vendedora no ve ni una pantalla administrativa, en ninguno de los
 *     dos niveles.
 *
 * Las dos rutas que no son pantalla están declaradas como tales: si algún día
 * dejan de comportarse así, esto falla y hay que revisarlas.
 */
import puppeteer from "puppeteer";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser local — recibido: ${BASE_URL}`);
  process.exit(1);
}

const CUENTAS = {
  admin: { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" },
  seller: { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!" }
};

// Lo que la propietaria debe encontrar, y en qué área.
const ESPERADO = [
  { ruta: "/admin/ventas", area: "Ventas", sub: "Nueva venta" },
  { ruta: "/admin/caja", area: "Ventas", sub: "Caja" },
  { ruta: "/admin/inventario", area: "Inventario", sub: "Existencias" },
  { ruta: "/admin/reposicion", area: "Inventario", sub: "Reposición" },
  { ruta: "/admin/conversaciones", area: "Clientes", sub: "Conversaciones" },
  { ruta: "/admin/carritos", area: "Clientes", sub: "Carritos" },
  { ruta: "/admin/productos", area: "Catálogo", sub: "Productos" },
  { ruta: "/admin/catalogo/revisar", area: "Catálogo", sub: "Revisar" },
  { ruta: "/admin/pdf", area: "Catálogo", sub: "Catálogo PDF" },
  { ruta: "/admin/compras", area: "Compras", sub: "Órdenes" },
  { ruta: "/admin/gastos", area: "Compras", sub: "Gastos" },
  { ruta: "/admin/atribucion", area: "Marketing", sub: "Atribución" },
  { ruta: "/admin/campanas", area: "Marketing", sub: "Campañas" },
  { ruta: "/admin/canales", area: "Marketing", sub: "Canales" },
  { ruta: "/admin/analitica", area: "Analítica", sub: null },
  { ruta: "/admin/asistente", area: "Asistente", sub: null }
];

// Rutas que existen pero NO son pantalla, y por eso no están en la barra.
const NO_SON_PANTALLA = [
  { ruta: "/admin/estructura", porque: "stub que redirige al alta de productos", destino: "/admin/productos/nuevo" },
  { ruta: "/admin/importaciones", porque: "entrada antigua que redirige a Revisar", destino: "/admin/catalogo/revisar" }
];

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

let fallos = 0;
const ok = (cond, texto, extra = "") => {
  if (!cond) fallos += 1;
  console.log(`${cond ? "✓" : "✗"} ${texto}${cond || !extra ? "" : ` — ${extra}`}`);
};

async function entrar(page, cuenta) {
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (!new URL(page.url()).pathname.endsWith("/login")) return true;
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.$eval('input[type="email"]', (n) => { n.value = ""; });
  await page.$eval('input[type="password"]', (n) => { n.value = ""; });
  await page.type('input[type="email"]', cuenta.email);
  await page.type('input[type="password"]', cuenta.password);
  await page.click('button[type="submit"]');
  return page.waitForFunction(
    () => window.location.pathname.startsWith("/admin") && !window.location.pathname.endsWith("/login"),
    { timeout: 20000 }
  ).then(() => true).catch(() => false);
}

const leerNav = () => ({
  ruta: window.location.pathname,
  area: document.querySelector(".nav-pill--active")?.textContent?.trim() ?? null,
  sub: document.querySelector(".nav-sub--active")?.textContent?.trim() ?? null,
  todo: [...document.querySelectorAll(".topbar-nav .nav-pill, .nav-subbar .nav-sub")]
    .map((n) => n.textContent?.trim())
});

try {
  // ── Propietaria ──
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const inventoryBoardClientRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/admin/inventory/board") {
      inventoryBoardClientRequests.push(request.url());
    }
  });
  if (!await entrar(page, CUENTAS.admin)) throw new Error("sin sesión de propietaria");

  console.log("Propietaria · las rutas no se movieron y cada una marca su área\n");
  for (const esperado of ESPERADO) {
    const startedAt = performance.now();
    const resp = await page.goto(`${BASE_URL}${esperado.ruta}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 500));
    const elapsedMs = Math.round(performance.now() - startedAt);
    const real = await page.evaluate(leerNav);
    const problemas = [];
    if (resp.status() >= 400) problemas.push(`HTTP ${resp.status()}`);
    if (real.ruta !== esperado.ruta) problemas.push(`redirigida a ${real.ruta}`);
    if (real.area !== esperado.area) problemas.push(`área "${real.area}" ≠ "${esperado.area}"`);
    if (esperado.sub && real.sub !== esperado.sub) problemas.push(`sub "${real.sub}" ≠ "${esperado.sub}"`);
    if (elapsedMs > 3000) problemas.push(`navegación ${elapsedMs} ms > 3000 ms`);
    ok(problemas.length === 0, `${esperado.ruta.padEnd(24)} → ${esperado.area} · ${elapsedMs} ms`, problemas.join(" · "));
  }
  ok(
    inventoryBoardClientRequests.length === 0,
    "Inventario y Reposición llegan hidratados, sin segunda petición inicial",
    `${inventoryBoardClientRequests.length} petición(es) inesperada(s)`,
  );

  console.log("\nRutas que existen pero no son pantalla (y por eso no están en la barra)\n");
  for (const caso of NO_SON_PANTALLA) {
    const resp = await page.goto(`${BASE_URL}${caso.ruta}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 400));
    const real = await page.evaluate(leerNav);
    const cumple = caso.http ? resp.status() === caso.http : real.ruta === caso.destino;
    ok(cumple, `${caso.ruta.padEnd(22)} ${caso.porque}`,
      caso.http ? `esperaba HTTP ${caso.http}, dio ${resp.status()}` : `esperaba ${caso.destino}, dio ${real.ruta}`);
  }

  // ── Vendedora ──
  // Contexto aparte, no otra pestaña: las pestañas comparten el frasco de
  // cookies, así que la vendedora heredaría la sesión de la propietaria y la
  // comprobación diría que ve secciones que en realidad no ve.
  const contexto = await browser.createBrowserContext();
  const pv = await contexto.newPage();
  await pv.setViewport({ width: 1440, height: 900 });
  if (!await entrar(pv, CUENTAS.seller)) throw new Error("sin sesión de vendedora");
  await pv.goto(`${BASE_URL}/admin/ventas`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 700));
  const nav = await pv.evaluate(leerNav);

  console.log("\nVendedora · lo suyo sí, lo administrativo no (en los dos niveles)\n");
  const debeVer = ["Ventas", "Caja", "Inventario", "Asistente"];
  const noDebeVer = ["Productos", "Catálogo PDF", "Gastos", "Compras", "Importaciones", "Marketing", "Analítica"];
  ok(debeVer.every((l) => nav.todo.includes(l)), `ve ${debeVer.join(", ")}`, JSON.stringify(nav.todo));
  ok(noDebeVer.every((l) => !nav.todo.includes(l)), "no ve ninguna sección administrativa",
    noDebeVer.filter((l) => nav.todo.includes(l)).join(", "));
} finally {
  await browser.close();
}

console.log(fallos === 0
  ? "\n✓ Contrato de navegación intacto: ninguna URL se movió."
  : `\n✗ ${fallos} comprobación(es) fallida(s).`);
process.exit(fallos === 0 ? 0 : 1);
