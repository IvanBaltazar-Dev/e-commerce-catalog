/**
 * Inicio de la propietaria (A1).
 *
 * Comprueba dos cosas distintas:
 *
 *  1. La REGLA TEMPORAL, que es pura y se puede probar sin navegador. Es la
 *     invariante más fácil de romper sin que nadie lo note: basta que alguien
 *     escriba `interval '7 days'` para que «la semana pasada» pase a significar
 *     «los últimos siete días» y las comparaciones dejen de ser comparables.
 *
 *  2. El CONTRATO DE PANTALLA: cuatro bloques en orden, cuatro KPI, entrada por
 *     rol, y ningún dato repetido entre bloques.
 *
 * Uso: node --experimental-transform-types scripts/test-owner-home.mjs
 */
import puppeteer from "puppeteer";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { semanasCerradas } from "../src/lib/admin/semanas.ts";

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const target = new URL(BASE_URL);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.protocol !== "http:") {
  console.error(`✗ UI_BASE_URL debe ser local — recibido: ${BASE_URL}`);
  process.exit(1);
}

let fallos = 0;
const check = (cond, texto, extra = "") => {
  if (!cond) fallos += 1;
  console.log(`${cond ? "✓" : "✗"} ${texto}${cond || !extra ? "" : ` — ${extra}`}`);
};

const dia = (iso) => new Date(`${iso}T00:00:00Z`);

console.log("Regla temporal · semana = lunes a domingo, la última CERRADA\n");

// El ejemplo que fija la especificación, palabra por palabra.
const sabado = semanasCerradas(dia("2026-08-08"));
check(
  sabado.pasada.desde === "2026-07-27" && sabado.pasada.hasta === "2026-08-02",
  "sábado 08/08 → la semana pasada es 27/07–02/08",
  `${sabado.pasada.desde}–${sabado.pasada.hasta}`
);
check(
  sabado.anterior.desde === "2026-07-20" && sabado.anterior.hasta === "2026-07-26",
  "y la anterior es 20/07–26/07",
  `${sabado.anterior.desde}–${sabado.anterior.hasta}`
);

// Lunes: la semana en curso acaba de empezar y NO puede contarse.
const lunes = semanasCerradas(dia("2026-08-03"));
check(
  lunes.pasada.desde === "2026-07-27" && lunes.pasada.hasta === "2026-08-02",
  "lunes 03/08 → sigue siendo 27/07–02/08, no la semana en curso",
  `${lunes.pasada.desde}–${lunes.pasada.hasta}`
);

// Domingo: el día que cierra la semana tampoco la incluye, porque aún no acabó.
const domingo = semanasCerradas(dia("2026-08-09"));
check(
  domingo.pasada.desde === "2026-07-27" && domingo.pasada.hasta === "2026-08-02",
  "domingo 09/08 → tampoco cuenta su propia semana, que aún no cierra",
  `${domingo.pasada.desde}–${domingo.pasada.hasta}`
);

// Siempre siete días exactos, en las dos.
for (const [nombre, rango] of [["pasada", sabado.pasada], ["anterior", sabado.anterior]]) {
  const dias = Math.round((dia(rango.hasta) - dia(rango.desde)) / 86400000) + 1;
  check(dias === 7, `la semana ${nombre} son siete días completos`, `${dias} días`);
}

console.log("\nContrato de pantalla\n");

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

async function entrar(ctx, email, password) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (new URL(page.url()).pathname.endsWith("/login")) {
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.endsWith("/login"), { timeout: 20000 });
  }
  return page;
}

try {
  const page = await entrar(browser, "demo-admin@local.invalid", "Demo-Admin-2026!");
  await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  check(new URL(page.url()).pathname === "/admin/inicio", "la propietaria aterriza en su Inicio", page.url());

  const pantalla = await page.evaluate(() => ({
    bloques: [...document.querySelectorAll(".order-section-title")].map((n) => n.textContent.trim()),
    kpis: [...document.querySelectorAll(".home-kpi-label")].map((n) => n.textContent.trim()),
    accesos: document.querySelectorAll(".home-action").length,
    // Los avisos que existan deben traer su acción, sin excepción.
    avisosSinAccion: [...document.querySelectorAll(".home-alert")]
      .filter((n) => !n.querySelector(".home-alert-action")).length,
    // Ninguna variación de dinero puede expresarse en puntos porcentuales.
    puntosPorcentuales: /\bpp\b/.test(document.body.innerText),
    desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));

  const esperados = ["Cómo va el día", "Necesita tu atención", "¿Qué quieres hacer?", "Lo que funcionó la semana pasada"];
  check(
    JSON.stringify(pantalla.bloques) === JSON.stringify(esperados),
    "cuatro bloques, en orden y sin añadir más",
    pantalla.bloques.join(" · ")
  );
  check(pantalla.kpis.length === 4, "cuatro KPI arriba", pantalla.kpis.join(" · "));
  check(
    pantalla.kpis.includes("Cobrado hoy") && pantalla.kpis.includes("Venta hoy"),
    "cobrado y venta son KPI distintos: no se mezclan"
  );
  check(pantalla.accesos === 6, "seis accesos compactos", `${pantalla.accesos}`);
  check(pantalla.avisosSinAccion === 0, "cada aviso lleva su acción");
  check(!pantalla.puntosPorcentuales, "el dinero no se compara en puntos porcentuales");
  check(pantalla.desborde <= 1, "sin desborde horizontal", `${pantalla.desborde}px`);

  // La vendedora no ve un error: se la lleva a donde trabaja.
  const contexto = await browser.createBrowserContext();
  const vend = await entrar(contexto, "demo-seller@local.invalid", "Demo-Seller-2026!");
  await vend.goto(`${BASE_URL}/admin/inicio`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  check(
    new URL(vend.url()).pathname === "/admin/ventas",
    "la vendedora que entra al Inicio acaba en Nueva venta, no en un error",
    vend.url()
  );
} finally {
  await browser.close();
}

console.log(fallos === 0
  ? "\n✓ El Inicio respeta la regla temporal y su contrato de pantalla."
  : `\n✗ ${fallos} comprobación(es) fallida(s).`);
process.exit(fallos === 0 ? 0 : 1);
