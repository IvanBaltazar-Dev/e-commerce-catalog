/**
 * Guardas de identidad. El mismo criterio en reconciliación y en cualquier
 * adopción posterior — barcode, medios, SKU, atributos.
 *
 * Existen por un incidente concreto del 2026-08-20. La reconciliación emparejó
 * por SKU dentro de la misma marca, que parecía suficiente, y no lo era: nuestro
 * correlativo interno `CHE011` coincide carácter por carácter con el SKU real
 * `CHE011` de Cherimoya, que es un aceite labial. El matcher lo dio por exacto y
 * la preparación de medios le descargó a nuestro «Gel Paint Blanco» la foto de
 * un labial. Nueve medios, los nueve del mismo choque.
 *
 * La lección no es «añadir una comprobación de nombre». Es que un valor de texto
 * dentro de una columna llamada `sku` NO ES un identificador hasta que se sabe
 * qué clase de identificador es y quién lo emitió. `SAC-4` bajo Konsung Beauty y
 * `SAC-4` bajo Candy Secret son dos códigos distintos que se escriben igual.
 *
 * Por eso la jerarquía de señales no ordena por «fuerza aparente del campo» sino
 * por PROCEDENCIA CONOCIDA del identificador.
 */

export type ClaseIdentificador =
  | "GTIN"
  | "MANUFACTURER_SKU"
  | "SUPPLIER_SKU"
  | "MPN"
  | "SOURCE_EXTERNAL_ID"
  | "BELLAROSHE_SKU"
  | "DESCONOCIDA";

export type Veredicto =
  | "MATCH_EXACT"
  | "MATCH_STRONG"
  | "MATCH_CANDIDATE"
  | "COLLISION_GUARD"
  | "NO_MATCH";

/**
 * Rango de cada clase. Un identificador solo puede sostener un MATCH_EXACT por
 * sí solo si su clase está confirmada y su emisor es conocido.
 *
 * BELLAROSHE_SKU vale cero para emparejar con el exterior: es nuestro, no
 * significa nada fuera de esta base, y ese fue exactamente el vector del
 * incidente. DESCONOCIDA vale cero por definición — no se sabe qué es.
 */
const RANGO: Record<ClaseIdentificador, number> = {
  GTIN: 100,
  MANUFACTURER_SKU: 90,
  SUPPLIER_SKU: 70,
  MPN: 60,
  SOURCE_EXTERNAL_ID: 50,
  BELLAROSHE_SKU: 0,
  DESCONOCIDA: 0,
};

export const puedeSostenerMatchExacto = (clase: ClaseIdentificador): boolean => RANGO[clase] >= 50;

const VACIAS = new Set([
  "de", "del", "la", "el", "los", "las", "con", "sin", "para", "por", "en", "y",
  "ml", "gr", "oz", "und", "pza", "uds", "x", "kit", "set",
]);

export function normalizar(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fichas(texto: string | null | undefined): Set<string> {
  return new Set(
    normalizar(texto).split(" ").filter((palabra) => palabra.length > 2 && !VACIAS.has(palabra)),
  );
}

/** Alguna palabra con contenido en común. No mide parecido: mide si se tocan. */
export function seCorroboran(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = fichas(a);
  const B = fichas(b);
  for (const ficha of A) if (B.has(ficha)) return true;
  return false;
}

/**
 * Clases de producto leídas del nombre. Compartidas con los auditores para que
 * el sistema no tenga tres lecturas distintas del mismo concepto.
 */
export function claseDeProducto(texto: string | null | undefined): string | null {
  const n = normalizar(texto);
  if (/\bbrillo\b|^top coat|^matificador|^sellante/.test(n)) return "BRILLO";
  if (/^base\b|\bbase\b/.test(n)) return "BASE";
  if (/^lima|\blima\b|^pulidor|^buffer/.test(n)) return "LIMA";
  if (/^removedor|^limpiador|^cleanser|^dilusor/.test(n)) return "REMOVEDOR";
  if (/^pincel|^brocha/.test(n)) return "PINCEL";
  if (/^aceite|^crema|^serum/.test(n)) return "CUIDADO";
  if (/\bpolvo acrilico\b|\bmonomero\b|\bacrilico\b/.test(n)) return "ACRILICO";
  if (/\bdecoracion\b/.test(n)) return "DECORACION";
  if (/\besmalte\b/.test(n)) return "ESMALTE";
  if (/\blabial\b|\blipstick\b|\blip\b/.test(n)) return "LABIAL";
  if (/\bsombra\b|\bpolvo compacto\b|\bcorrector\b|\brubor\b/.test(n)) return "MAQUILLAJE";
  return null;
}

export function clasesIncompatibles(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = claseDeProducto(a);
  const y = claseDeProducto(b);
  return Boolean(x && y && x !== y);
}

export interface LadoInterno {
  /** El valor que coincidió. */
  valor: string;
  /** Qué clase de identificador es ESE valor, no qué columna lo guarda. */
  clase: ClaseIdentificador;
  /** Quién lo emitió. Sin emisor, dos numeraciones distintas parecen la misma. */
  emisor?: string | null;
  nombre: string;
}

export interface LadoExterno {
  valor: string;
  clase: ClaseIdentificador;
  emisor?: string | null;
  nombre: string;
}

export interface Resultado {
  veredicto: Veredicto;
  razon: string;
}

/**
 * ¿Puede este emparejamiento sostener una identidad exacta?
 *
 * El orden importa y no es negociable:
 *
 *   1. si los valores no coinciden, no hay nada que decidir;
 *   2. si el emisor es conocido en ambos lados y difiere, es un choque —el caso
 *      `SAC-4` de Konsung contra `SAC-4` de Candy Secret;
 *   3. si la clase de NUESTRO identificador no puede sostener identidad
 *      —correlativo interno o desconocida— hace falta corroboración;
 *   4. sin corroboración, COLLISION_GUARD: no se descarta en silencio, se
 *      nombra, para que aparezca en el informe y no como un hueco.
 */
export function evaluarIdentidadPorIdentificador(
  interno: LadoInterno,
  externo: LadoExterno,
): Resultado {
  const iguales = normalizarCodigo(interno.valor) === normalizarCodigo(externo.valor);
  if (!iguales) return { veredicto: "NO_MATCH", razon: "los valores no coinciden" };

  // El emisor solo se compara entre identificadores EXTERNOS. Nuestro
  // correlativo lo emitimos nosotros por definición, así que su emisor siempre
  // difiere del de la ficha oficial — compararlos declararía choque en todos los
  // casos normales, incluido el emparejamiento legítimo de una lima.
  //
  // Donde sí discrimina es entre dos códigos externos: `SAC-4` emitido bajo
  // Konsung Beauty no es `SAC-4` emitido bajo Candy Secret, aunque el texto
  // coincida y ambos sean SUPPLIER_SKU.
  const ambosExternos = interno.clase !== "BELLAROSHE_SKU" && interno.clase !== "DESCONOCIDA";
  if (ambosExternos && interno.emisor && externo.emisor
      && normalizar(interno.emisor) !== normalizar(externo.emisor)) {
    return {
      veredicto: "COLLISION_GUARD",
      razon: `mismo valor con emisores distintos: «${interno.emisor}» y «${externo.emisor}»`,
    };
  }

  const corrobora = seCorroboran(interno.nombre, externo.nombre);
  const incompatible = clasesIncompatibles(interno.nombre, externo.nombre);

  if (incompatible) {
    return {
      veredicto: "COLLISION_GUARD",
      razon: `el código coincide pero las clases de producto son incompatibles: «${claseDeProducto(interno.nombre)}» contra «${claseDeProducto(externo.nombre)}»`,
    };
  }

  if (puedeSostenerMatchExacto(interno.clase)) {
    return { veredicto: "MATCH_EXACT", razon: `${interno.clase} confirmado` };
  }

  if (corrobora) {
    return {
      veredicto: "MATCH_EXACT",
      razon: `${interno.clase} no confirmado, pero los nombres se corroboran`,
    };
  }

  return {
    veredicto: "COLLISION_GUARD",
    razon: `«${interno.valor}» es ${interno.clase} y los nombres no se tocan: probable choque de numeraciones`,
  };
}

export const normalizarCodigo = (valor: string | null | undefined): string =>
  (valor ?? "").toString().trim().toUpperCase().replace(/[\s\-_.]/g, "");

/**
 * ¿Puede adoptarse un dato derivado —barcode, medio, atributo— de este
 * emparejamiento? Solo desde una identidad exacta. La misma puerta para todos:
 * la foto de un labial llegó a un gel paint porque la adopción confiaba en el
 * caso sin volver a preguntar por su calidad.
 */
export function puedeAdoptarDerivado(veredicto: Veredicto): boolean {
  return veredicto === "MATCH_EXACT";
}
