/**
 * Contratos del POS (B1). Todo lo que aquí se declara lo resuelve PostgreSQL:
 * la pantalla no calcula precios, ni disponibilidad, ni qué tono es relevante.
 *
 * Cómo se PINTA un tono (respaldo por familia cromática, plegado de tildes) se
 * declara aquí y también en `lib/public/tones`, que la ficha pública está
 * construyendo en paralelo. Es duplicación consciente y temporal: en cuanto esa
 * pieza aterrice, esto se sustituye por su import. Un mismo esmalte no puede
 * verse de un color en la ficha pública y de otro en la venta.
 */

/**
 * Tintes por familia cromática: el respaldo visual cuando un tono todavía no
 * tiene ni fotografía ni color registrado. Nunca sustituyen a la foto real;
 * solo evitan un círculo mudo que obliga a leer 164 nombres.
 */
export const FAMILY_TINTS: Record<string, string> = {
  rojos: "#C0392B",
  rosados: "#E38AA8",
  morados: "#7D4B9E",
  azules: "#3B6FB5",
  verdes: "#5B8C5A",
  "amarillos-dorados": "#D9A62E",
  "naranjas-corales": "#E07B4F",
  nude: "#D9B49B",
  marrones: "#8A5A3B",
  blancos: "#F2EEE9",
  "negros-grises": "#4A4A4A",
  metalicos: "#9FA8B5",
  transparentes: "#E4E9EC",
  multicolor: "#C96A82",
  "por-clasificar": "#CFC4BC"
};

/** Sin tilde y en minúscula: media carta de Masglo las lleva («Arcoíris»,
 *  «Auténtica», «Bombón») y en mostrador nadie las teclea. */
export function foldText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export type PosAvailability = "available" | "sold_out" | "consult";

/** Una fila del buscador del POS: es una variante, no un producto. */
export type PosVariant = {
  variantId: string;
  sku: string | null;
  barcode: string | null;
  variantName: string;
  productId: string;
  productName: string;
  presentation: string | null;
  brandName: string;
  lineName: string | null;
  shadeName: string | null;
  shadeCode: string | null;
  referenceColor: string | null;
  /** De la lista vigente. Null cuando el producto aún no tiene precio: null
   *  NO es cero, y un cero impreso en la pantalla de venta se acaba cobrando. */
  unitPrice: number | null;
  wholesalePrice: number | null;
  /** Del producto y configurable por la dueña. Jamás una constante. */
  wholesaleMinQuantity: number | null;
  availability: PosAvailability;
  tracksInventory: boolean;
  availableQuantity: number;
};

/**
 * Un tono destacado en la tarjeta del producto. `reason` explica POR QUÉ está
 * ahí, para no ofrecer tres tonos sin decir de dónde salieron.
 */
export type PosHighlight = {
  variantId: string;
  shadeName: string | null;
  shadeCode: string | null;
  variantName: string;
  referenceColor: string | null;
  swatchPath: string | null;
  availableQuantity: number;
  tracksInventory: boolean;
  reason: "reciente" | "mas_vendido";
};

/**
 * Un producto agrupado en el buscador: la tercera velocidad. Con 164 tonos, la
 * pantalla ofrece «abrir» en vez de 164 filas.
 */
export type PosProductGroup = {
  productId: string;
  productName: string;
  brandName: string;
  presentation: string | null;
  /** Rango de precio del producto entero: dentro del mismo esmalte puede haber
   *  tonos con precio y tonos sin él, y anunciar uno solo mentiría. */
  priceFrom: number | null;
  priceTo: number | null;
  withoutPrice: number;
  wholesaleMinQuantity: number | null;
  /** Cuántas variantes coincidieron con lo tecleado. */
  matchedVariants: number;
  /** Cuántos tonos tiene el producto ENTERO, coincidan o no. */
  toneCount: number;
  availableCount: number;
  highlights: PosHighlight[];
};

export type PosSearchResult = {
  items: PosVariant[];
  total: number;
  products: PosProductGroup[];
};

export type PosToneSheetHeader = {
  productId: string;
  name: string;
  brandName: string;
  lineName: string | null;
  presentation: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  /** Cuántos tonos siguen sin precio vigente. Se dice, no se disimula. */
  withoutPrice: number;
  wholesaleMinQuantity: number | null;
  toneCount: number;
  availableCount: number;
};

export type PosToneFamily = {
  value: string;
  label: string;
  toneCount: number;
  availableCount: number;
};

export type PosTone = {
  variantId: string;
  sku: string | null;
  barcode: string | null;
  variantName: string;
  shadeName: string | null;
  shadeCode: string | null;
  referenceColor: string | null;
  familyValue: string | null;
  familyLabel: string | null;
  finishLabel: string | null;
  swatchPath: string | null;
  availability: PosAvailability;
  tracksInventory: boolean;
  availableQuantity: number;
  unitPrice: number | null;
  wholesalePrice: number | null;
  /** Última vez que ESTA vendedora lo despachó (30 días). Null si nunca. */
  lastSoldAt: string | null;
  /** Unidades vendidas en la tienda en 30 días. */
  soldUnits: number;
};

export type PosToneSheet = {
  product: PosToneSheetHeader | null;
  families: PosToneFamily[];
  tones: PosTone[];
};

/** El color con el que se pinta un tono: el suyo, el de su familia, o nada. */
export function toneTint(tone: { referenceColor: string | null; familyValue: string | null }) {
  if (tone.referenceColor) return tone.referenceColor;
  if (tone.familyValue) return FAMILY_TINTS[tone.familyValue] ?? FAMILY_TINTS["por-clasificar"];
  return null;
}

/**
 * Un tono se puede vender si la base dice que está disponible Y tiene precio
 * vigente. `consult` NO es vendible: es el estado del catálogo recién
 * importado, y despacharlo registraría una venta de S/ 0.00.
 */
export function isSellable(tone: { availability: PosAvailability; unitPrice?: number | null }) {
  if (tone.availability !== "available") return false;
  return tone.unitPrice === undefined || tone.unitPrice !== null;
}

export function availabilityLabel(tone: { availability: PosAvailability; unitPrice?: number | null }) {
  if (tone.availability === "sold_out") return "Agotado";
  if (tone.availability === "consult") return "Todavía sin precio";
  if (tone.unitPrice === null) return "Todavía sin precio";
  return "Disponible";
}

/** «S/ 12.50», «desde S/ 9.00», «S/ 9.00 – 15.00» o «todavía sin precio». */
export function priceRangeLabel(range: { priceFrom: number | null; priceTo: number | null }) {
  if (range.priceFrom === null || range.priceTo === null) return "Todavía sin precio";
  const soles = (value: number) => `S/ ${value.toFixed(2)}`;
  if (range.priceFrom === range.priceTo) return soles(range.priceFrom);
  return `${soles(range.priceFrom)} – ${soles(range.priceTo)}`;
}
