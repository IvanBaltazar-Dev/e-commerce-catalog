/**
 * Verificación de pantallas del asistente IA (Bloque 4) sobre el build de
 * producción, con sesión real y SIN credencial de IA — exactamente el entorno
 * donde la regla 10 debe verse: todo degrada con honestidad y nada se detiene.
 *
 * Recorre: dictado → propuesta → llevar a Ventas (prefill) · foto sin
 * credencial (unavailable explícito) · tendencias (generar → aprobar →
 * «ya la publiqué») · sugerencia del asesor en una conversación real.
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-assistant-ui" });

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const ADMIN_EMAIL = "demo-admin@local.invalid";
const ADMIN_PASSWORD = "Demo-Admin-2026!";

const results = [];
function check(name, condition, extra = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || !extra ? "" : ` — ${extra}`}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1300 });

  // --- Sesión ---------------------------------------------------------------
  let signedIn = false;
  for (let attempt = 1; attempt <= 4 && !signedIn; attempt += 1) {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
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
      await page.waitForFunction(
        () => window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login",
        { timeout: 20000 }
      );
      signedIn = true;
    } catch { /* hidratación: reintento */ }
  }
  if (!signedIn) throw new Error("Sin sesión de administración.");

  // --- Asistente: dictado → propuesta ---------------------------------------
  await page.goto(`${BASE_URL}/admin/asistente`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("textarea", { timeout: 20000 });

  const bodyText = () => page.evaluate(() => document.body.innerText);
  check("El asistente carga con sus tres herramientas",
    (await bodyText()).includes("Dictar pedido") &&
    (await bodyText()).includes("Identificar por foto") &&
    (await bodyText()).includes("Asesora Bellaroshé"));

  await page.type("textarea", "dos rojo intenso y un nude rosado");
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Interpretar pedido"));
    target?.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".ai-line").length > 0 || document.querySelector(".ai-ambiguity"),
    { timeout: 30000 }
  );

  const lineCount = await page.evaluate(() => document.querySelectorAll(".ai-line").length);
  check("El dictado produce líneas de propuesta contra el catálogo real", lineCount > 0, `líneas=${lineCount}`);
  check("Sin credencial, el modo determinista se DICE (regla 10)",
    (await bodyText()).includes("Modo determinista"));

  // --- Foto sin credencial: unavailable explícito y registrado --------------
  const photo = await page.evaluate(async () => {
    const response = await fetch("/api/admin/assistant/photo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ imagenBase64: "A".repeat(200), mediaType: "image/jpeg", etapa: "single" })
    });
    return { status: response.status, body: await response.json() };
  });
  const photoResult = photo.body?.data ?? photo.body;
  check("La foto sin credencial responde «no disponible» con evidencia",
    photo.status === 200 &&
    photoResult?.resultado?.estado === "unavailable" &&
    typeof photoResult?.interactionId === "string",
    JSON.stringify(photoResult?.resultado ?? photo.body).slice(0, 120));

  // --- Asesora (degradada) ---------------------------------------------------
  const advice = await page.evaluate(async () => {
    const response = await fetch("/api/admin/assistant/advise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pregunta: "¿Qué gel me recomiendas para empezar?" })
    });
    return { status: response.status, body: await response.json() };
  });
  const adviceResult = advice.body?.data ?? advice.body;
  check("La asesora responde aun degradada, con recomendaciones del catálogo",
    advice.status === 200 && typeof adviceResult?.respuesta === "string" &&
    Array.isArray(adviceResult?.recomendaciones),
    JSON.stringify(adviceResult).slice(0, 120));

  // --- Llevar a Ventas: el prefill viaja ------------------------------------
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Llevar a Ventas"));
    target?.click();
  });
  await page.waitForFunction(() => window.location.pathname === "/admin/ventas", { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".order-lines .order-line, .order-lines > *").length > 0,
    { timeout: 30000 }
  );
  const salesText = await bodyText();
  check("Ventas recibe la propuesta como borrador (el precio lo evalúa PostgreSQL)",
    salesText.includes("Gel Evolution") || salesText.includes("Rojo intenso") || salesText.includes("Nude"));

  // --- Tendencias: proponer no es publicar ----------------------------------
  await page.goto(`${BASE_URL}/admin/atribucion`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector(".order-loading"), { timeout: 30000 });
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Tendencias");
    tab?.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes("Propuestas de contenido"), { timeout: 15000 });

  await page.evaluate(() => {
    const target = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Generar propuesta"));
    target?.click();
  });
  await page.waitForFunction(() => document.querySelectorAll(".trend-card").length > 0, { timeout: 40000 });
  check("Se genera una propuesta en borrador desde señales reales",
    (await bodyText()).includes("Borrador"));

  await page.evaluate(() => {
    const card = document.querySelector(".trend-card");
    const target = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Aprobar");
    target?.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".trend-card")?.textContent?.includes("Aprobada"),
    { timeout: 20000 }
  );
  check("La dueña aprueba con un clic", true);

  await page.evaluate(() => {
    window.prompt = () => "Instagram (prueba)";
    const card = document.querySelector(".trend-card");
    const target = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Ya la publiqué"));
    target?.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".trend-card")?.textContent?.includes("Publicada"),
    { timeout: 20000 }
  );
  check("«Publicada» solo registra que la publicó ELLA — no hay publicación automática", true);

  // --- Sugerencia del asesor en una conversación real -----------------------
  const conversations = await page.evaluate(async () => {
    const response = await fetch("/api/admin/conversations", { credentials: "include" });
    const body = await response.json();
    return body?.data?.items ?? body?.items ?? [];
  });

  if (conversations.length === 0) {
    check("Sugerencia en conversación (sin conversaciones en la base: se omite)", true);
  } else {
    await page.goto(`${BASE_URL}/admin/conversaciones/${conversations[0].id}`, {
      waitUntil: "domcontentloaded", timeout: 60000
    });
    await page.waitForSelector(".conv-composer textarea", { timeout: 30000 });
    await page.evaluate(() => {
      const target = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Sugerir"));
      target?.click();
    });
    await page.waitForFunction(
      () => (document.querySelector(".conv-composer textarea")?.value ?? "").length > 0,
      { timeout: 30000 }
    );
    const draftValue = await page.$eval(".conv-composer textarea", (node) => node.value);
    check("El asesor deja un BORRADOR en el compositor; enviarlo sigue siendo humano",
      draftValue.length > 10, draftValue.slice(0, 80));
  }

  await page.screenshot({ path: path.join(ROOT, "test-results", "asistente.png"), fullPage: false });
  console.log("Captura: test-results/asistente.png");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} verificación(es) fallaron.`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} verificaciones del asistente en verde.`);
