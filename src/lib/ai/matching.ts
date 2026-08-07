/**
 * El corazón DETERMINISTA de la asistencia (regla 10 del plan): interpretar
 * un pedido dictado y proponer coincidencias del catálogo funciona sin ningún
 * proveedor de IA. El LLM, cuando existe, solo mejora la segmentación del
 * habla; las coincidencias SIEMPRE salen de este módulo contra productos
 * reales — por construcción no se puede proponer un SKU inventado.
 *
 * Módulo puro a propósito: sin imports de servidor, para poder probarlo con
 * un catálogo de mentira en un script de Node sin levantar nada.
 */

export type CatalogEntry = {
  variantId: string;
  productId: string;
  sku: string | null;
  productName: string;
  variantName: string;
  shadeName: string | null;
  brandName: string | null;
  categoryName: string | null;
  available: boolean;
};

export type OrderLine = {
  variantId: string;
  sku: string | null;
  nombre: string;
  cantidad: number;
  confianza: number;
};

export type OrderAmbiguity = {
  texto: string;
  cantidad: number;
  opciones: { variantId: string; sku: string | null; nombre: string; confianza: number }[];
};

export type OrderProposal = {
  lineas: OrderLine[];
  ambiguedades: OrderAmbiguity[];
  noEncontrado: string[];
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const QUANTITY_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, docena: 12,
  quince: 15, veinte: 20,
  par: 2
};

// Palabras que no distinguen un producto de otro. Los COLORES no están aquí:
// «rojo» es exactamente lo que separa un tono de otro.
const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
  "y", "e", "o", "u", "para", "con", "sin", "en", "que", "por", "al",
  "me", "le", "se", "mi", "su", "quiero", "quisiera", "dame", "ponme",
  "agrega", "agregame", "necesito", "tambien", "mas", "porfavor", "favor",
  "unidades", "unidad", "cajas", "caja", "frascos", "frasco"
]);

function tokensOf(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

// Muletillas que preceden al pedido real y taparían la cantidad si no se
// retiran ANTES de leerla: «quiero dos rojos» empieza en «dos», no en «quiero».
const LEADING_FILLERS = new Set([
  "quiero", "quisiera", "dame", "ponme", "pon", "agrega", "agregame",
  "necesito", "me", "seria", "sera", "por", "favor", "porfavor", "hola",
  "tambien", "ademas", "el", "la", "los", "las"
]);

/**
 * Parte un dictado en ítems con cantidad. «quiero dos esmaltes rojos y un
 * kit de gel» → [{cantidad: 2, descripcion: "esmaltes rojos"}, {cantidad: 1,
 * descripcion: "kit de gel"}]. La puntuación separa ítems, así que se parte
 * ANTES de normalizar (normalizar borra las comas). Es deliberadamente
 * simple: el habla real la segmenta mejor el LLM, pero este camino jamás se
 * apaga.
 */
export function segmentOrder(text: string): { cantidad: number; descripcion: string }[] {
  const lowered = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  const pieces = lowered
    .split(/\s*(?:[,;.]|\by\b|\be\b|\btambien\b|\bademas\b|\bmas\b)\s*/)
    .map((piece) => normalizeText(piece))
    .filter(Boolean);

  const items: { cantidad: number; descripcion: string }[] = [];
  for (const piece of pieces) {
    const words = piece.split(" ").filter(Boolean);

    let index = 0;
    while (index < words.length && LEADING_FILLERS.has(words[index])) {
      index += 1;
    }

    let cantidad = 1;
    const first = words[index] ?? "";
    if (/^\d{1,3}$/.test(first)) {
      cantidad = Math.min(999, Math.max(1, Number.parseInt(first, 10)));
      index += 1;
    } else if (first === "media" && words[index + 1] === "docena") {
      cantidad = 6;
      index += 2;
    } else if (QUANTITY_WORDS[first] != null) {
      cantidad = QUANTITY_WORDS[first];
      index += 1;
    }

    const descripcion = words.slice(index).join(" ").trim();
    if (descripcion.length > 0) {
      items.push({ cantidad, descripcion });
    }
  }
  return items;
}

export type Match = { entry: CatalogEntry; score: number };

/**
 * Puntúa el catálogo contra una descripción. SKU exacto gana siempre; después
 * pesan más el tono y la variante (lo específico) que el producto y la marca
 * (lo general). El puntaje se normaliza por token pedido, así «esmalte rojo»
 * y «esmalte semipermanente rojo cereza de masglo» compiten en la misma
 * escala.
 */
export function matchCandidates(descripcion: string, catalog: CatalogEntry[]): Match[] {
  const queryTokens = tokensOf(descripcion);
  if (queryTokens.length === 0) return [];

  const queryNormalized = normalizeText(descripcion);
  const results: Match[] = [];

  for (const entry of catalog) {
    if (entry.sku && normalizeText(entry.sku) === queryNormalized) {
      results.push({ entry, score: 100 });
      continue;
    }

    const fields: { text: string | null; weight: number }[] = [
      { text: entry.shadeName, weight: 4 },
      { text: entry.variantName, weight: 3.5 },
      { text: entry.productName, weight: 3 },
      { text: entry.brandName, weight: 2 },
      { text: entry.categoryName, weight: 2 },
      { text: entry.sku, weight: 3 }
    ];

    let score = 0;
    for (const token of queryTokens) {
      let best = 0;
      for (const field of fields) {
        if (!field.text) continue;
        const fieldTokens = tokensOf(field.text);
        if (fieldTokens.includes(token)) {
          best = Math.max(best, field.weight);
        } else if (fieldTokens.some((ft) => ft.startsWith(token) || token.startsWith(ft))) {
          // «esmaltes» debe encontrar «esmalte»: prefijo vale un poco menos.
          best = Math.max(best, field.weight * 0.7);
        }
      }
      score += best;
    }

    const normalized = score / queryTokens.length;
    if (normalized > 0.9) {
      results.push({ entry, score: Number(normalized.toFixed(3)) });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

const DIRECT_THRESHOLD = 2.4;
const AMBIGUITY_GAP = 0.35;

/**
 * Interpreta el pedido completo: cada ítem termina como línea directa (una
 * coincidencia clara), ambigüedad declarada (varias plausibles: decide la
 * persona) o «no encontrado» (jamás se inventa nada parecido).
 */
export function interpretOrderItems(
  items: { cantidad: number; descripcion: string }[],
  catalog: CatalogEntry[]
): OrderProposal {
  const lineas: OrderLine[] = [];
  const ambiguedades: OrderAmbiguity[] = [];
  const noEncontrado: string[] = [];

  for (const item of items) {
    const matches = matchCandidates(item.descripcion, catalog);

    if (matches.length === 0) {
      noEncontrado.push(item.descripcion);
      continue;
    }

    const [top, second] = matches;
    const isClear =
      top.score >= DIRECT_THRESHOLD &&
      (second == null || top.score - second.score >= AMBIGUITY_GAP || second.score < DIRECT_THRESHOLD * 0.8);

    if (isClear) {
      const existing = lineas.find((line) => line.variantId === top.entry.variantId);
      if (existing) {
        existing.cantidad = Math.min(999, existing.cantidad + item.cantidad);
      } else {
        lineas.push({
          variantId: top.entry.variantId,
          sku: top.entry.sku,
          nombre: displayName(top.entry),
          cantidad: item.cantidad,
          confianza: Math.min(1, Number((top.score / 4).toFixed(2)))
        });
      }
    } else {
      ambiguedades.push({
        texto: item.descripcion,
        cantidad: item.cantidad,
        opciones: matches.slice(0, 3).map((match) => ({
          variantId: match.entry.variantId,
          sku: match.entry.sku,
          nombre: displayName(match.entry),
          confianza: Math.min(1, Number((match.score / 4).toFixed(2)))
        }))
      });
    }
  }

  return { lineas, ambiguedades, noEncontrado };
}

export function displayName(entry: CatalogEntry): string {
  const tone = entry.shadeName ?? (entry.variantName !== entry.productName ? entry.variantName : null);
  return tone ? `${entry.productName} · ${tone}` : entry.productName;
}

/** El camino 100 % determinista, de texto a propuesta. */
export function interpretOrderText(text: string, catalog: CatalogEntry[]): OrderProposal {
  return interpretOrderItems(segmentOrder(text), catalog);
}
