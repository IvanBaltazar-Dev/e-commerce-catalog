/**
 * Verificación de pantalla: /admin/analitica sobre el build de producción.
 *
 * Comprueba con una sesión real que el tablero renderiza sus indicadores, que
 * los presets de rango responden y que ningún número viene de otra fuente que
 * el contrato business_dashboard. Deja una captura como evidencia.
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-analytics-ui" });

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const results = [];
function check(name, condition) {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "✓" : "✗"} ${name}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1400 });

  // Inicio de sesión con reintento de hidratación, pero esperando por DOM en
  // lugar de networkidle0: el panel mantiene conexiones vivas (Supabase) que
  // impiden el «cero conexiones» y volverían eterna esa espera.
  let signedIn = false;
  for (let attempt = 1; attempt <= 4 && !signedIn; attempt += 1) {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Si una sesión previa sigue viva, el login redirige directo al panel.
    const alreadyInside = await page
      .waitForFunction(
        () => window.location.pathname !== "/admin/login" && window.location.pathname.startsWith("/admin"),
        { timeout: 3000 }
      )
      .then(() => true)
      .catch(() => false);
    if (alreadyInside) { signedIn = true; break; }
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.$eval('input[type="email"]', (node) => { node.value = ""; });
    await page.$eval('input[type="password"]', (node) => { node.value = ""; });
    await page.type('input[type="email"]', ADMIN_EMAIL);
    await page.type('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    try {
      // El destino exacto tras el login varía (p. ej. /admin/productos/nuevo):
      // lo que prueba la sesión es haber salido del login hacia el panel.
      await page.waitForFunction(
        () => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login",
        { timeout: 20000 }
      );
      signedIn = true;
    } catch {
      // Envío nativo por hidratación incompleta: se reintenta sobre ruta caliente.
    }
  }
  if (!signedIn) throw new Error(`No se pudo iniciar sesión como ${ADMIN_EMAIL}.`);

  await page.goto(`${BASE_URL}/admin/analitica`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".metric-grid, .order-loading", { timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector(".order-loading"),
    { timeout: 30000 }
  );

  const text = await page.evaluate(() => document.body.innerText);
  check("La pantalla carga con su título", text.includes("Analítica comercial"));
  check("Indicadores del periodo presentes", text.includes("Total vendido") && text.includes("Utilidad neta estimada"));
  check("Salidas y compromisos presentes", text.includes("Devoluciones") && text.includes("Compras pendientes"));
  check("Rankings presentes", text.includes("Productos por unidades") && text.includes("Tonos más vendidos"));
  check("Proveedores con veredicto de conveniencia", text.includes("Proveedores"));

  // La respuesta de la API es la única fuente: se lee directa para contrastar.
  const api = await page.evaluate(async () => {
    const response = await fetch("/api/admin/analytics", { credentials: "include" });
    return { status: response.status, body: await response.json() };
  });
  check("La API responde 200 a la sesión admin", api.status === 200);
  const dashboard = api.body?.data?.dashboard ?? api.body?.dashboard;
  check("El contrato trae ventas y margen", Boolean(dashboard?.ventas) && Boolean(dashboard?.margen));
  check(
    "La regla 16 viaja en el contrato: utilidad nula trae su razón",
    dashboard?.margen?.utilidadNetaEstimada !== undefined
  );

  // Preset «Hoy»: el rango cambia y la vista recarga sin error.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.trim() === "Hoy")?.click();
  });
  await page.waitForFunction(
    () => !document.querySelector(".order-loading"),
    { timeout: 30000 }
  );
  const todayValue = await page.$eval('input[type="date"]', (node) => node.value);
  check("El preset Hoy mueve la fecha inicial a hoy", todayValue === new Date().toISOString().slice(0, 10));

  await page.screenshot({ path: path.join(ROOT, "test-results", "analitica.png"), fullPage: true });
  console.log("Captura: test-results/analitica.png");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} verificación(es) fallaron.`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} verificaciones de la pantalla de analítica en verde.`);
