import "server-only";

import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";

const VIEWPORT = { width: 900, height: 1273, deviceScaleFactor: 2 };

function isServerless() {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.VERCEL);
}

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
    defaultViewport: VIEWPORT,
    protocolTimeout: 120000
  });
}

async function resolveLocalChrome(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  try {
    const full = (await import("puppeteer")).default;
    const bundled = full.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    // Continúa con un navegador instalado por el sistema.
  }

  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const installed = candidates.find((candidate) => existsSync(candidate));
  if (installed) return installed;

  throw new Error(
    "No se encontró Chromium para el render local del PDF. Instala puppeteer o define PUPPETEER_EXECUTABLE_PATH."
  );
}
