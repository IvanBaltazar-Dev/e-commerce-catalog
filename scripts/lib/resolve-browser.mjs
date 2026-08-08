/**
 * Resolución del navegador para las pruebas de UI, en el mismo orden que el
 * render del PDF (src/lib/catalog/browser.ts): variable de entorno →
 * Chrome del propio puppeteer → instalaciones estándar del sistema → error
 * claro. Una máquina nueva no necesita rutas mágicas: `npx puppeteer
 * browsers install chrome` o PUPPETEER_EXECUTABLE_PATH bastan.
 */
import { existsSync } from "node:fs";

export async function resolveBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (!existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      throw new Error(
        `PUPPETEER_EXECUTABLE_PATH apunta a un ejecutable inexistente: ${process.env.PUPPETEER_EXECUTABLE_PATH}`
      );
    }
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  try {
    const puppeteer = (await import("puppeteer")).default;
    const bundled = puppeteer.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    // Sigue con los navegadores del sistema.
  }

  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const installed = candidates.find((candidate) => existsSync(candidate));
  if (installed) return installed;

  throw new Error(
    "No hay navegador para las pruebas de UI. Corre `npx puppeteer browsers install chrome` " +
    "o define PUPPETEER_EXECUTABLE_PATH."
  );
}
