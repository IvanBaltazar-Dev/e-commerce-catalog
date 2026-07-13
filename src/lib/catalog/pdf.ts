import "server-only";

import PDFDocument from "pdfkit";

type PdfProduct = {
  code: string;
  name: string;
  presentation: string | null;
  product_type: string | null;
  requires_lamp: boolean;
  description: string | null;
  unit_price: number | string;
  wholesale_price: number | string;
  wholesale_min_quantity: number;
  availability: "available" | "sold_out" | "consult";
  color_chart_status: "available" | "consult_advisor";
  brand?: { name?: string | null } | { name?: string | null }[] | null;
  category?: { name?: string | null } | { name?: string | null }[] | null;
};

type PdfSettings = {
  business_name?: string | null;
  whatsapp_number?: string | null;
  stock_notice?: string | null;
};

function nestedName(value: PdfProduct["brand"]) {
  if (Array.isArray(value)) {
    return value[0]?.name ?? "";
  }

  return value?.name ?? "";
}

function money(value: number | string) {
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN"
  }).format(Number(value));
}

function availabilityText(value: PdfProduct["availability"]) {
  if (value === "sold_out") {
    return "Agotado";
  }

  if (value === "consult") {
    return "Consultar disponibilidad";
  }

  return "Disponible";
}

function chartText(value: PdfProduct["color_chart_status"]) {
  return value === "available"
    ? "Carta de colores disponible"
    : "Amplia variedad de tonos. Consultar colores disponibles con asesor.";
}

export async function renderCatalogPdf(params: {
  products: PdfProduct[];
  settings: PdfSettings | null;
  generatedAt: Date;
}) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: "Catalogo Bellaroshe",
        Author: params.settings?.business_name ?? "Bellaroshe"
      }
    });

    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(28).text(params.settings?.business_name ?? "Bellaroshe", {
      align: "center"
    });
    doc.moveDown(0.5);
    doc.fontSize(14).text("Catalogo de productos", { align: "center" });
    doc.moveDown(0.5);
    doc
      .fontSize(10)
      .text(`Actualizado: ${params.generatedAt.toLocaleString("es-PE")}`, {
        align: "center"
      });
    doc.moveDown(1.5);

    doc
      .fontSize(10)
      .text(
        params.settings?.stock_notice ??
          "Precios y stock son referenciales hasta confirmar por WhatsApp."
      );
    doc.moveDown();
    doc.text(`WhatsApp: ${params.settings?.whatsapp_number ?? "+51 963 463 550"}`);
    doc.addPage();

    params.products.forEach((product, index) => {
      const title = [nestedName(product.brand), product.name].filter(Boolean).join(" ");
      const category = nestedName(product.category);

      if (index > 0) {
        doc.moveDown(0.8);
      }

      if (doc.y > 690) {
        doc.addPage();
      }

      doc.fontSize(15).text(title || product.name, { continued: false });
      doc.fontSize(9).fillColor("#555555").text(product.code);
      doc.fillColor("#000000");
      doc.fontSize(10).text(`Categoria: ${category || "Sin categoria"}`);
      doc.text(`Presentacion: ${product.presentation ?? "No especificada"}`);
      doc.text(`Tipo: ${product.product_type ?? "No especificado"}`);
      doc.text(`Requiere lampara: ${product.requires_lamp ? "Si" : "No"}`);
      doc.text(`Disponibilidad: ${availabilityText(product.availability)}`);
      doc.text(`Precio unitario: ${money(product.unit_price)}`);
      doc.text(
        `Precio mayorista: ${money(product.wholesale_price)} desde ${
          product.wholesale_min_quantity
        } unidades`
      );
      doc.text(chartText(product.color_chart_status));

      if (product.description) {
        doc.moveDown(0.2);
        doc.text(product.description, { width: 480 });
      }
    });

    doc.moveDown(1.5);
    doc
      .fontSize(9)
      .text("La disponibilidad de tonos, stock y precio final se confirma con un asesor.", {
        align: "center"
      });

    doc.end();
  });
}
