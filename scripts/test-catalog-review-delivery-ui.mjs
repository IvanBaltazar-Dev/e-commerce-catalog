/**
 * Regresión de la entrega de Mesa: lenguaje de pertenencia a familia, orden de
 * decisión y ausencia de prefetch masivo desde la barra superior.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3000";
const target = new URL(BASE_URL);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error(`UI_BASE_URL debe ser local: ${BASE_URL}`);
}

const { env } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "test-catalog-review-delivery-ui",
  allowedFlags: [],
});
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const reference = must(await service.from("catalog_reference_products")
  .select("id")
  .ilike("source_url", "%zac-esmalte-tradicional%")
  .single(), "ficha oficial ZAC");
const reconciliation = must(await service.from("catalog_reconciliation_cases")
  .select("id")
  .eq("reference_product_id", reference.id)
  .eq("algorithm", "official_identity_v1")
  .single(), "reconciliación oficial ZAC");
const work = must(await service.from("catalog_review_work_items")
  .select("id")
  .eq("source_type", "reconciliation_case")
  .eq("source_id", reconciliation.id)
  .single(), "trabajo ZAC");

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[type="submit"]');
    return Boolean(button && Object.keys(button).some((key) => key.startsWith("__reactProps")));
  }, { timeout: 20_000 });
  await page.type('input[type="email"]', "demo-admin@local.invalid");
  await page.type('input[type="password"]', "Demo-Admin-2026!");
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => location.pathname.startsWith("/admin/") && !location.pathname.endsWith("/login"),
    { timeout: 20_000 },
  );

  const unexpectedAdminLoads = [];
  let reviewLoaded = false;
  page.on("request", (request) => {
    if (!reviewLoaded) return;
    const url = new URL(request.url());
    if (url.origin !== target.origin || !url.pathname.startsWith("/admin/")) return;
    if (url.pathname !== "/admin/catalogo/revisar") unexpectedAdminLoads.push(url.pathname);
  });

  await page.goto(`${BASE_URL}/admin/catalogo/revisar`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector(".cr-primary--large", { timeout: 30_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".cr-primary--large");
    return Boolean(button && Object.keys(button).some((key) => key.startsWith("__reactProps")));
  }, { timeout: 30_000 });
  await page.click(".cr-primary--large");
  await page.waitForSelector(".cr-decision", { timeout: 30_000 });
  reviewLoaded = true;
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const visible = await page.evaluate(() => {
    const decision = document.querySelector(".cr-decision");
    const evidence = document.querySelector(".cr-evidence-disclosure");
    return {
      options: document.querySelectorAll(".cr-options button").length,
      decisionBeforeEvidence: !evidence || Boolean(decision && (decision.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  if (visible.options < 2 || !visible.decisionBeforeEvidence) {
    throw new Error(`La decisión no quedó visible antes de la evidencia: ${JSON.stringify(visible)}`);
  }

  const response = await page.evaluate(async (workId) => {
    const request = await fetch(`/api/admin/catalog-review/${workId}`);
    return { status: request.status, body: await request.json() };
  }, work.id);
  if (response.status !== 200) throw new Error(`API ZAC respondió ${response.status}`);
  const caseItem = response.body?.data?.case ?? response.body?.case;
  const assertions = [
    [caseItem?.title === "Confirma la familia de esta ficha oficial", "título de familia"],
    [caseItem?.entity?.type === "Familia interna", "entidad presentada como familia"],
    [/no representa un tono específico/i.test(caseItem?.entity?.description ?? ""), "explicación de familia"],
    [caseItem?.options?.[0]?.label === "Sí, pertenece a esta familia", "opción afirmativa natural"],
    [caseItem?.options?.[1]?.label === "No, es otra clase de producto", "opción negativa natural"],
    [caseItem?.hasContradiction === false, "sin contradicción falsa"],
    [!/AJO Y LIMON/i.test(JSON.stringify(caseItem?.entity ?? {})), "Ajo y Limón no se muestra como identidad"],
  ];
  const failed = assertions.filter(([passed]) => !passed).map(([, label]) => label);
  if (failed.length) throw new Error(`Falló el contrato ZAC: ${failed.join(", ")} · ${JSON.stringify({
    responseKeys: Object.keys(response.body ?? {}),
    dataKeys: Object.keys(response.body?.data ?? {}),
    title: caseItem?.title,
    entity: caseItem?.entity,
    optionLabels: caseItem?.options?.map((option) => option.label),
  })}`);
  if (unexpectedAdminLoads.length) {
    throw new Error(`La barra precargó páginas no solicitadas: ${[...new Set(unexpectedAdminLoads)].join(", ")}`);
  }

  const output = path.join(ROOT, "test-results", "catalog-review-delivery.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    workItemId: work.id,
    visibleOptions: visible.options,
    unsolicitedTopbarLoads: 0,
    screenshot: output,
  }, null, 2));
} finally {
  await browser.close();
}
