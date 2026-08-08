import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "test-catalog-import-access" });
if (!isLocal) throw new Error("La prueba de acceso solo se ejecuta contra Supabase local.");

const baseUrl = process.env.CATALOG_IMPORT_BASE_URL ?? "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const password = `Import-Access-${stamp}!`;
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const users = [];
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createUser(role) {
  const email = `${role}-import-${stamp}@local.invalid`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  users.push(created.data.user.id);
  const profile = await service.from("admin_profiles").insert({ id: created.data.user.id, role, full_name: `${role} import access test` });
  if (profile.error) throw profile.error;
  return { email, role };
}

async function login(page, account) {
  await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', account.email);
  await page.type('input[type="password"]', password);
  await Promise.all([
    page.waitForFunction(() => window.location.pathname === "/admin/productos/nuevo" || Boolean(document.querySelector(".login-error")?.textContent)),
    page.click('button[type="submit"]')
  ]);
  const state = await page.evaluate(() => ({ path: window.location.pathname, error: document.querySelector(".login-error")?.textContent ?? "" }));
  if (state.path !== "/admin/productos/nuevo") throw new Error(`No se pudo ingresar como ${account.role}: ${state.error || "sin respuesta del formulario"}`);
}

try {
  const admin = await createUser("admin");
  const developer = await createUser("developer");
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath: await resolveBrowserExecutable()
  });
  const adminContext = await browser.createBrowserContext();
  const adminPage = await adminContext.newPage();
  adminPage.setDefaultTimeout(90_000);

  await login(adminPage, admin);
  assert(await adminPage.$('a[href="/admin/importaciones"]') === null, "El admin no debe ver Importaciones.");
  const adminAccess = await adminPage.evaluate(async () => {
    const [pageResponse, apiResponse, mediaResponse] = await Promise.all([
      fetch("/admin/importaciones"),
      fetch("/api/admin/importaciones/template"),
      fetch("/api/admin/importaciones/media/preview", { method: "POST" })
    ]);
    return { pageStatus: pageResponse.status, apiStatus: apiResponse.status, mediaStatus: mediaResponse.status };
  });
  assert(adminAccess.pageStatus === 404, `La página developer devolvió ${adminAccess.pageStatus} para admin.`);
  assert(adminAccess.apiStatus === 403, `La API developer devolvió ${adminAccess.apiStatus} para admin.`);
  assert(adminAccess.mediaStatus === 403, `La API ZIP devolvió ${adminAccess.mediaStatus} para admin.`);
  await adminContext.close();

  const developerContext = await browser.createBrowserContext();
  const developerPage = await developerContext.newPage();
  developerPage.setDefaultTimeout(90_000);
  await login(developerPage, developer);
  assert(await developerPage.$('a[href="/admin/importaciones"]') !== null, "El developer debe ver Importaciones.");
  await developerPage.goto(`${baseUrl}/admin/importaciones`, { waitUntil: "domcontentloaded" });
  assert(await developerPage.$('input[accept*=".zip"]') !== null, "El developer debe ver el cargador ZIP.");
  const developerAccess = await developerPage.evaluate(async () => {
    const pageResponse = await fetch("/admin/importaciones");
    const templateResponse = await fetch("/api/admin/importaciones/template");
    const mediaResponse = await fetch("/api/admin/importaciones/media/preview", { method: "POST" });
    const blob = await templateResponse.blob();
    const form = new FormData();
    form.set("file", new File([blob], "plantilla_importacion_productos.xlsx", { type: blob.type }));
    const previewResponse = await fetch("/api/admin/importaciones/preview", { method: "POST", body: form });
    return {
      pageStatus: pageResponse.status,
      templateStatus: templateResponse.status,
      mediaStatus: mediaResponse.status,
      contentType: templateResponse.headers.get("content-type"),
      previewStatus: previewResponse.status,
      preview: await previewResponse.json()
    };
  });
  assert(developerAccess.pageStatus === 200, `La página devolvió ${developerAccess.pageStatus} para developer.`);
  assert(developerAccess.templateStatus === 200, `La plantilla devolvió ${developerAccess.templateStatus}.`);
  assert(developerAccess.mediaStatus === 400, `La API ZIP devolvió ${developerAccess.mediaStatus} sin archivo para developer.`);
  assert(developerAccess.contentType?.includes("spreadsheetml.sheet"), "La descarga no usa el MIME XLSX.");
  assert(developerAccess.previewStatus === 200, `La previsualización devolvió ${developerAccess.previewStatus}.`);
  assert(developerAccess.preview.data.canCommit === false, "La plantilla intacta no debe poder importarse.");
  assert(developerAccess.preview.data.issues.some((item) => item.code === "no_products_selected"), "Falta la protección importar=FALSE.");
  assert(developerAccess.preview.data.security.originalFileStored === false, "El reporte debe confirmar que no se almacena el original.");
  await developerContext.close();

  console.log("OK: admin oculto/403-404; developer visible/200; ZIP, descarga y previsualización seguras.");
} finally {
  if (browser) await browser.close();
  for (const userId of users) await service.auth.admin.deleteUser(userId);
}
