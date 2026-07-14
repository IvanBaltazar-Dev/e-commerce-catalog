import "server-only";

import puppeteer, { type Browser } from "puppeteer-core";

// Viewport de render (2x) igual al usado por scripts/render-pdf.mjs para que el PDF de la
// app salga idéntico a la vista previa del equipo.
const VIEWPORT = { width: 900, height: 1273, deviceScaleFactor: 2 };

function isServerless() {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.VERCEL);
}

/**
 * Lanza Chromium para renderizar el catálogo a PDF.
 * - En serverless (Vercel/Lambda): binario de `@sparticuz/chromium` + `puppeteer-core`.
 * - En desarrollo local: Chromium del paquete `puppeteer` completo (devDependency) o el
 *   ejecutable indicado por `PUPPETEER_EXECUTABLE_PATH`.
 */
export async function launchBrowser(): Promise<Browser> {
  if (isServerless()) {
    const chromium = (await import("@sparticuz/chromium")).default;

    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: VIEWPORT
    });
  }

  return puppeteer.launch({
    args: ["--no-sandbox", "--font-render-hinting=none"],
    executablePath: await resolveLocalChrome(),
    headless: true,
    defaultViewport: VIEWPORT
  });
}

async function resolveLocalChrome(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  try {
    const full = (await import("puppeteer")).default;
    return full.executablePath();
  } catch {
    throw new Error(
      "No se encontró Chromium para el render local del PDF. Instala `puppeteer` (devDependency) o define PUPPETEER_EXECUTABLE_PATH."
    );
  }
}
