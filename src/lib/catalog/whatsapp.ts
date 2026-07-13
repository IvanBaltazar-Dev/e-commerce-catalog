import "server-only";

type ProductForMessage = {
  id: string;
  name: string;
  presentation: string | null;
  unit_price: number | string;
  wholesale_price: number | string;
  wholesale_min_quantity: number;
  brand?: { name?: string | null } | { name?: string | null }[] | null;
};

type SelectionItem = {
  product: ProductForMessage;
  quantity: number;
  toneMode: "assorted" | "full_set" | "specific_codes" | "confirm_with_advisor";
  toneCodes?: string[];
  note?: string | null;
};

const toneModeText = {
  assorted: "surtidos",
  full_set: "set completo",
  specific_codes: "codigos especificos",
  confirm_with_advisor: "por confirmar con asesor"
} as const;

function nestedName(value: ProductForMessage["brand"]) {
  if (Array.isArray(value)) {
    return value[0]?.name ?? "";
  }

  return value?.name ?? "";
}

export function productLabel(product: ProductForMessage) {
  return [nestedName(product.brand), product.name, product.presentation]
    .filter(Boolean)
    .join(" ");
}

export function normalizeWhatsappNumber(phone: string) {
  return phone.replace(/\D/g, "");
}

export function whatsappUrl(phone: string, text: string) {
  return `https://wa.me/${normalizeWhatsappNumber(phone)}?text=${encodeURIComponent(text)}`;
}

export function buildProductAdvisorMessage(product: ProductForMessage, quantity: number) {
  return [
    `Hola Bellaroshe, estoy revisando ${productLabel(product)}.`,
    `Necesito ${quantity} unidades y quisiera conocer los tonos disponibles.`
  ].join("\n");
}

export function buildColorChartAdvisorMessage(product: ProductForMessage, quantity: number) {
  return [
    `Hola Bellaroshe, estoy revisando la carta de ${productLabel(product)}.`,
    `Necesito ayuda para elegir ${quantity} tonos.`
  ].join("\n");
}

function referencePrice(product: ProductForMessage, quantity: number) {
  const wholesaleMin = Number(product.wholesale_min_quantity);
  const unit = quantity >= wholesaleMin ? product.wholesale_price : product.unit_price;
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN"
  }).format(Number(unit));
}

function tonesLine(item: SelectionItem) {
  if (item.toneMode === "specific_codes" && item.toneCodes?.length) {
    return item.toneCodes.join(", ");
  }

  return toneModeText[item.toneMode];
}

export function buildSelectionMessage(
  items: SelectionItem[],
  options: { deliveryMethod?: "shipping" | "pickup"; customerNote?: string | null } = {}
) {
  const lines = ["Hola Bellaroshe, deseo consultar esta seleccion:", ""];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${productLabel(item.product)}`);
    lines.push(`Cantidad: ${item.quantity}`);
    lines.push(`Tonos: ${tonesLine(item)}`);
    lines.push(`Precio referencial: ${referencePrice(item.product, item.quantity)}`);

    if (item.note) {
      lines.push(`Observacion: ${item.note}`);
    }

    lines.push("");
  });

  if (options.deliveryMethod) {
    lines.push(`Modalidad: ${options.deliveryMethod === "shipping" ? "envio" : "recojo"}`);
  }

  if (options.customerNote) {
    lines.push(`Nota: ${options.customerNote}`);
  }

  lines.push("Me confirman colores disponibles, stock y precio final?");

  return lines.join("\n");
}
