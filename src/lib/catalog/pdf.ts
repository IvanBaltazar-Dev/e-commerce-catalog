import "server-only";

import { launchBrowser } from "@/lib/catalog/browser";
import { buildCatalogHtml, type PdfProduct, type PdfSettings } from "@/lib/catalog/pdf-html";

export type { PdfProduct, PdfSettings };

/**
 * Renderiza el catálogo premium (portada + fichas + cartas de color + cierre) a PDF A4
 * usando Chromium (HTML/CSS → PDF). Reemplaza al generador de texto plano de PDFKit.
 */
export async function renderCatalogPdf(params: {
  products: PdfProduct[];
  settings: PdfSettings | null;
  generatedAt: Date;
}): Promise<Buffer> {
  const html = await buildCatalogHtml(params);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 90000 });

    // Espera a que las fotos remotas (Storage) y las webfonts terminen de cargar para
    // que el PDF no salga con imágenes en blanco ni el tipo de letra del sistema.
    try {
      await page.evaluate(async () => {
        await Promise.all(
          Array.from(document.images).map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  img.addEventListener("load", () => resolve(), { once: true });
                  img.addEventListener("error", () => resolve(), { once: true });
                })
          )
        );

        const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
        if (fonts?.ready) {
          await fonts.ready;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // Si algún recurso no carga seguimos igualmente; no bloquea el PDF.
    }

    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
