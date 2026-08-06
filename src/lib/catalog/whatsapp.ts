import "server-only";

import type { WhatsAppOrder } from "@/lib/catalog/contracts";

export function normalizeWhatsappNumber(phone: string) {
  return phone.replace(/\D/g, "");
}

export function whatsappUrl(phone: string, text: string) {
  return `https://wa.me/${normalizeWhatsappNumber(phone)}?text=${encodeURIComponent(text)}`;
}

function money(value: number | null) {
  if (value === null) return "por confirmar";

  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN"
  }).format(value);
}

function modeLabel(mode: WhatsAppOrder["lines"][number]["purchaseMode"]) {
  if (mode === "wholesale") return "Mayorista";
  if (mode === "consult") return "Consulta";
  return "Minorista";
}

export function buildWhatsAppOrderMessage(
  order: WhatsAppOrder,
  intent: "order" | "advice" = "order"
) {
  const lines = [
    intent === "advice"
      ? "Hola Bellaroshé, quisiera asesoría sobre esta selección:"
      : "Hola Bellaroshé, deseo consultar el siguiente pedido:",
    ""
  ];

  order.lines.forEach((line) => {
    lines.push(`${line.brandName} · ${line.productName}`);
    lines.push(`- Variante: ${line.variantName}`);
    lines.push(`- SKU: ${line.sku}`);
    lines.push(`- Cantidad: ${line.quantity}`);
    lines.push(`- Modalidad: ${modeLabel(line.purchaseMode)}`);
    lines.push(`- Precio referencial: ${money(line.unitPrice)}`);

    if (line.wholesaleRule) {
      lines.push(`- Regla aplicada: ${line.wholesaleRule.name}`);
    }

    lines.push(`- Ver producto: ${line.slug ? `/producto/${line.slug}?variante=${encodeURIComponent(line.sku)}` : "—"}`);
    lines.push("");
  });

  lines.push(`Total de unidades: ${order.totalUnits}`);
  lines.push(`Subtotal referencial: ${money(order.subtotal)}`);

  if (order.deliveryMethod) {
    lines.push(`Entrega: ${order.deliveryMethod === "shipping" ? "envío" : "recojo en tienda"}`);
  }

  if (order.customerNote) {
    lines.push(`Nota: ${order.customerNote}`);
  }

  if (order.unresolvedLines > 0) {
    lines.push("Hay líneas sujetas a confirmación de disponibilidad o precio.");
  }

  return lines.join("\n");
}
