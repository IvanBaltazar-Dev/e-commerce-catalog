// Cómo se representa un tono cuando hay que mostrar 164 a la vez.
//
// La regla de fondo: el color de un esmalte se REGISTRA, no se deduce. Sacar el
// color dominante de la foto del envase da el azul de la tapa, el blanco de la
// etiqueta o un reflejo del vidrio, nunca el esmalte. `color_shades.
// reference_color` guarda el valor bueno una sola vez y aquí solo se lee.

import type { CatalogMedia, PurchasableVariant } from "@/lib/catalog/contracts";

// Respaldo por familia cromática: lo que se pinta cuando un tono todavía no
// tiene color registrado. Nunca se presenta como el color real — quien lo use
// debe decir que es referencial.
export const FAMILY_TINTS: Record<string, string> = {
  // Saturados a propósito: estos círculos compiten con esmaltes reales, que son
  // pigmento puro. Un rojo agrisado al lado de un frasco de laca no se lee como
  // «rojo», se lee como «apagado», y la vendedora deja de fiarse del respaldo.
  rojos: "#E02A22",
  rosados: "#F04E92",
  morados: "#8B3DC7",
  azules: "#2A6FE0",
  verdes: "#2FA14D",
  "amarillos-dorados": "#F0B01F",
  "naranjas-corales": "#FF6B3D",
  // Los que NO se suben, y el motivo importa: son familias definidas por ser
  // apagadas. Un nude saturado deja de ser nude, y un blanco vivo es otro color.
  nude: "#DFB398",
  marrones: "#8A5A3B",
  blancos: "#F4F1EC",
  "negros-grises": "#3A343A",
  metalicos: "#9AA6B6",
  transparentes: "#E4E9EC",
  // Valor de respaldo para cálculos —luminancia, contraste— porque una familia
  // «multicolor» no tiene UN color. Donde se pinta el círculo se le superpone un
  // degradado (`.tone-family-dot--multi`), que es lo que sí la representa.
  multicolor: "#C0398F",
  "por-clasificar": "#CFC4BC"
};

const UNCLASSIFIED_TINT = "#CFC4BC";

/** Sin tilde y en minúscula: «Fufurufa» y «fufurufa» son la misma búsqueda. */
export function foldText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Luminancia relativa (WCAG). Decide dos cosas: si un tono necesita borde para
 * no desaparecer sobre el blanco, y de qué color va la marca de selección.
 */
export function relativeLuminance(hex: string) {
  const parsed = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!parsed) return 0.5;
  const int = Number.parseInt(parsed[1], 16);
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * La textura real de un tono, si existe.
 *
 * Un HEX plano representa bien un cremoso y mal un glitter, un tornasol o un
 * cat-eye: para esos hace falta el recorte real del esmalte aplicado. El rol
 * `swatch` es donde vive ese recorte… salvo que hoy las únicas ocho filas con
 * ese rol son fotografías completas del envase, subidas como imagen única de su
 * variante. Meter una botella de 720×1086 en un círculo de 35px devuelve la
 * tapa azul y el logo, que es exactamente el problema que este selector viene a
 * resolver.
 *
 * De ahí el discriminante, que no depende de corregir datos a mano: un `swatch`
 * cuenta como textura solo si la variante tiene ADEMÁS otra foto. Si es su
 * única imagen, esa imagen está haciendo de foto de producto y es el envase. El
 * día que se suba un recorte de verdad junto a la foto del frasco, la rejilla
 * lo usa sin tocar una línea de código.
 */
export function toneTexture(media: CatalogMedia[]): string | null {
  const swatch = media.find((item) => item.role === "swatch");
  if (!swatch) return null;
  const hasOwnPhoto = media.some((item) => item.id !== swatch.id && item.role !== "swatch");
  return hasOwnPhoto ? swatch.path : null;
}

export type ToneCell = {
  variant: PurchasableVariant;
  /** Nombre comercial del tono. Cae al nombre de la variante si no hay tono. */
  name: string;
  /** Código de tono de la carta; si no existe, el SKU hace de identificador. */
  code: string;
  sku: string;
  familyValue: string;
  familyLabel: string;
  familySort: number;
  finishValue: string | null;
  finishLabel: string | null;
  /** Color que se pinta en la casilla. */
  fill: string;
  /** true cuando `fill` sale de la familia y no del color registrado del tono. */
  isReference: boolean;
  /** Recorte real del esmalte, cuando lo hay. */
  texture: string | null;
  /** Los muy claros necesitan borde o desaparecen sobre el fondo blanco. */
  isPale: boolean;
  soldOut: boolean;
  haystack: string;
};

export function toToneCell(variant: PurchasableVariant): ToneCell {
  const shade = variant.shade ?? null;
  const familyValue =
    shade?.familyValue
    ?? variant.attributes.find((attribute) => attribute.code === "color_family")?.optionValue
    ?? "por-clasificar";
  const familyLabel = shade?.familyLabel ?? "Por clasificar";
  const registered = shade?.referenceColor ?? null;
  const fill = registered ?? FAMILY_TINTS[familyValue] ?? UNCLASSIFIED_TINT;
  const name = shade?.name ?? variant.name;
  const code = shade?.code ?? variant.sku;

  return {
    variant,
    name,
    code,
    sku: variant.sku,
    familyValue,
    familyLabel,
    familySort: shade?.familySort ?? 9999,
    finishValue: variant.finish?.value ?? null,
    finishLabel: variant.finish?.label ?? null,
    fill,
    isReference: registered === null,
    texture: toneTexture(variant.media),
    isPale: relativeLuminance(fill) > 0.75,
    soldOut: variant.availability === "sold_out",
    haystack: foldText([name, code, variant.sku, variant.name, familyLabel, variant.finish?.label ?? ""].join(" "))
  };
}

/**
 * Orden de carta física: los tonos de la misma familia juntos y, dentro de
 * cada una, por nombre. Alfabético puro metería un rojo entre dos azules.
 */
export function sortToneCells(cells: ToneCell[]) {
  return [...cells].sort(
    (a, b) => a.familySort - b.familySort
      || a.familyLabel.localeCompare(b.familyLabel, "es")
      || a.name.localeCompare(b.name, "es")
  );
}

/**
 * Cuándo la carta de colores es mejor que la lista.
 *
 * Dos condiciones, y la segunda importa tanto como la primera:
 *
 * 1. Que el eje SEA el color. Un polvo acrílico por gramaje no lo es, y para
 *    él una rejilla de círculos no dice nada que la lista no diga mejor.
 *
 * 2. Que haya color que mostrar. La carta gana su sitio porque quita los
 *    nombres: si ningún tono tiene color registrado y todos caen en la misma
 *    familia, quitar los nombres deja una cuadrícula de círculos idénticos —
 *    justo el problema contrario al que se venía a resolver. Es el caso real
 *    de Admiss: 75 tonos, cero colores registrados, todos «por clasificar».
 *    Ahí la lista con nombre, código y precio sigue siendo la forma honesta de
 *    elegir, y en cuanto la dueña registre los colores la carta aparece sola.
 */
export function isToneAxis(variants: PurchasableVariant[]) {
  if (variants.length < 8) return false;
  const chromatic = variants.filter(
    (variant) => variant.shade || variant.attributes.some((attribute) => attribute.code === "color_family")
  );
  if (chromatic.length < Math.ceil(variants.length * 0.8)) return false;

  const withColor = chromatic.some((variant) => variant.shade?.referenceColor);
  const families = new Set(
    chromatic.map(
      (variant) => variant.shade?.familyValue
        ?? variant.attributes.find((attribute) => attribute.code === "color_family")?.optionValue
        ?? "por-clasificar"
    )
  );
  return withColor || families.size > 1;
}
