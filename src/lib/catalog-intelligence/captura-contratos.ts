/**
 * Dos piezas que toda campaña de captura necesita, y que estaban duplicadas o
 * sin escribir.
 *
 * 1. El CIERRE de una corrida. Un snapshot que solo guarda «capturé 640» no
 *    distingue «el catálogo encogió» de «mi crawler falló», que son cosas
 *    opuestas. La primera es un hecho de la fuente; la segunda es un fallo
 *    nuestro que no debe ensuciar la memoria.
 *
 * 2. El parser de CÓDIGOS COMPUESTOS. Una declaración aduanera dice
 *    «SH-607,608» o «LA-302,306,309,310,311», y cada número es después una
 *    ficha comercial distinta. De 499 declaraciones salieron 540 códigos
 *    porque 134 traían más de uno: quedarse con el primero perdía la identidad
 *    que se venía a buscar.
 */

export type CierreDeCaptura =
  /** Se llegó al final y se puede explicar por qué. */
  | "COMPLETE"
  /** Faltan páginas: hubo fallos que no se pudieron recuperar. */
  | "INCOMPLETE_CAPTURE"
  /** La fuente no respondió en absoluto. */
  | "SOURCE_UNAVAILABLE"
  /** Se paró por el tope de seguridad, no por haber terminado. */
  | "STOPPED_AT_LIMIT";

/**
 * Por qué se considera completa. Un cierre sin causa no es una conclusión, es
 * una suposición con nombre bonito.
 *
 *   END_OF_PAGINATION    la fuente devolvió una página correcta y vacía
 *   DECLARED_TOTAL_REACHED  se alcanzó el total que la propia fuente declara
 *   STABLE_REPEATING_SET seguía respondiendo, pero ya no traía nada nuevo
 */
export type CausaDeCierre =
  | "END_OF_PAGINATION"
  | "DECLARED_TOTAL_REACHED"
  | "STABLE_REPEATING_SET";

export interface ContratoDeCaptura {
  /** Lo que la fuente DICE que tiene, cuando lo publica. Null si no lo dice. */
  declared_total: number | null;
  /** Páginas que se esperaban recorrer según lo declarado o lo hallado. */
  pages_expected: number | null;
  pages_completed: number;
  first_page: number;
  last_page: number;
  items_captured: number;
  /** Páginas que fallaron y no se pudieron recuperar. */
  failed_pages: number[];
  retry_count: number;
  http_status_by_page: Record<number, number>;
  captured_at: string;
  content_hash: string;
  closure: CierreDeCaptura;
  closure_reason: string;
}

/**
 * Clasifica el cierre. La regla que importa: un HTTP 400/403/429/5xx NUNCA
 * significa fin de catálogo. Solo una respuesta CORRECTA y vacía lo significa.
 *
 * Y si la fuente declaró un total y capturamos menos, es captura incompleta
 * aunque no haya fallado ninguna página — puede que la paginación cambiara a
 * mitad, y eso también hay que verlo.
 */
export function clasificarCierre(entrada: {
  declaredTotal: number | null;
  itemsCaptured: number;
  pagesCompleted: number;
  failedPages: number[];
  terminoPorVacioCorrecto: boolean;
  terminoPorTope: boolean;
  /**
   * Páginas correctas seguidas que no aportaron ni una declaración nueva.
   * DatosPerú no devuelve vacío al terminar: entra en un bucle repitiendo lo
   * que ya dio. Esperar una página vacía ahí es esperar algo que no va a llegar,
   * y por eso la partida 96 se comió el tope de 60 páginas.
   */
  paginasSinNovedad?: number;
  /** Cuántas hacen falta para dar el conjunto por estable. */
  umbralEstabilidad?: number;
}): { closure: CierreDeCaptura; closure_reason: string; completion_reason: CausaDeCierre | null } {
  const sinNovedad = entrada.paginasSinNovedad ?? 0;
  const umbral = entrada.umbralEstabilidad ?? 3;

  if (entrada.pagesCompleted === 0) {
    return { closure: "SOURCE_UNAVAILABLE", closure_reason: "ninguna página respondió", completion_reason: null };
  }
  if (entrada.failedPages.length) {
    return {
      closure: "INCOMPLETE_CAPTURE",
      closure_reason: `${entrada.failedPages.length} página(s) sin recuperar: ${entrada.failedPages.join(", ")}`,
      completion_reason: null,
    };
  }

  // El conjunto estable se evalúa ANTES que el tope: si el recorrido dejó de
  // traer novedades y luego chocó con el límite, lo que ocurrió de verdad es
  // que había terminado.
  if (sinNovedad >= umbral) {
    return {
      closure: "COMPLETE",
      closure_reason: `${sinNovedad} páginas correctas seguidas sin una sola declaración nueva`,
      completion_reason: "STABLE_REPEATING_SET",
    };
  }

  // El déficit contra el total declarado se comprueba ANTES que el final feliz
  // de la paginación. Si la fuente dice 698 y trajimos 640, no importa que la
  // última página viniera vacía: sabemos que falta algo, y la paginación pudo
  // romperse antes de tiempo. Quedarse con COMPLETE ahí sería declarar entero un
  // catálogo que la propia fuente dice más grande.
  //
  // Al revés no: 91 observados contra 90 declarados NO es déficit. El total
  // declarado puede estar desactualizado o contar con otra granularidad, y
  // «corregir» 91 a 90 descartaría una observación real para cuadrar con una
  // cifra de menor autoridad. Eso se registra como discrepancia, no se resuelve.
  if (entrada.declaredTotal != null && entrada.itemsCaptured < entrada.declaredTotal) {
    return {
      closure: "INCOMPLETE_CAPTURE",
      closure_reason: `la fuente declara ${entrada.declaredTotal} y se capturaron ${entrada.itemsCaptured}`,
      completion_reason: null,
    };
  }

  if (entrada.terminoPorTope) {
    return { closure: "STOPPED_AT_LIMIT", closure_reason: "se alcanzó el tope de seguridad de páginas", completion_reason: null };
  }

  if (entrada.terminoPorVacioCorrecto) {
    return { closure: "COMPLETE", closure_reason: "la fuente devolvió una página correcta y vacía", completion_reason: "END_OF_PAGINATION" };
  }

  if (entrada.declaredTotal != null) {
    return {
      closure: "COMPLETE",
      closure_reason: `se alcanzó el total declarado por la fuente (${entrada.declaredTotal})`,
      completion_reason: "DECLARED_TOTAL_REACHED",
    };
  }

  return {
    closure: "INCOMPLETE_CAPTURE",
    closure_reason: "el recorrido no terminó por ninguna causa verificable",
    completion_reason: null,
  };
}

/**
 * La discrepancia con el total declarado se registra, no se resuelve. 90 contra
 * 91 es un hecho sobre las dos fuentes, y quien lo lea decidirá cuál pesa más.
 */
export function discrepanciaDeTotal(declarado: number | null, observado: number) {
  if (declarado == null) return { declared_total_mismatch: false, declared_total_delta: null };
  return {
    declared_total_mismatch: declarado !== observado,
    declared_total_delta: observado - declarado,
  };
}

/** Solo una captura COMPLETE puede promoverse como si fuera el catálogo entero. */
export const puedePromoverseComoCompleta = (c: CierreDeCaptura): boolean => c === "COMPLETE";

/**
 * Códigos compuestos. Expande solo cuando el formato es inequívoco: un prefijo
 * seguido de números separados por comas, donde todos los números comparten el
 * mismo prefijo. Nada más se expande — inventar una expansión es peor que
 * quedarse con el texto tal cual.
 *
 *   "SH-607,608"                → SH-607, SH-608
 *   "LA-302,306,309,310,311"    → LA-302, LA-306, LA-309, LA-310, LA-311
 *   "#601007"                   → #601007
 *   "SH-577 y otros"            → SH-577          (no inventa «otros»)
 *   "SH-607, LA-302"            → SH-607, LA-302  (dos prefijos, sin expandir)
 */
export function expandirCodigos(texto: string | null | undefined): string[] {
  const bruto = (texto ?? "").replace(/\s+/g, " ").trim();
  if (!bruto) return [];
  const encontrados = new Set<string>();

  // Prefijo + una lista que puede mezclar números sueltos y RANGOS:
  //
  //   "SH-633,634,642 AL 647,649 AL 653,658"
  //     → 633, 634, 642..647, 649..653, 658   (quince códigos)
  //
  // «AL» es inequívoco y por eso se expande. Lo que no lo sea —«y otros», «etc»,
  // «varios»— no se toca: inventar un código es peor que perderlo, porque un
  // código inventado empareja con algo.
  for (const m of bruto.matchAll(/\b([A-Z]{2,4})\s?-?\s?(\d{2,5}(?:\s?(?:,|AL)\s?\d{2,5})*)/gi)) {
    const prefijo = m[1].toUpperCase();
    const lista = m[2];
    // Se trocea por comas y cada trozo puede ser «N» o «N AL M».
    for (const trozo of lista.split(",").map((x) => x.trim()).filter(Boolean)) {
      const rango = trozo.match(/^(\d{2,5})\s*AL\s*(\d{2,5})$/i);
      if (rango) {
        const desde = Number(rango[1]);
        const hasta = Number(rango[2]);
        // Un rango invertido o desmesurado no se expande: es texto que no
        // sabemos leer, no una serie de doscientos códigos.
        if (hasta >= desde && hasta - desde <= 60) {
          const ancho = rango[1].length;
          for (let n = desde; n <= hasta; n += 1) {
            encontrados.add(`${prefijo}-${String(n).padStart(ancho, "0")}`);
          }
        }
        continue;
      }
      if (/^\d{2,5}$/.test(trozo)) encontrados.add(`${prefijo}-${trozo}`);
    }
  }

  // Referencias numéricas con almohadilla, que también pueden venir en lista.
  for (const m of bruto.matchAll(/#\s?(\d{4,8})((?:\s?,\s?#?\s?\d{4,8})+)?/g)) {
    encontrados.add(`#${m[1]}`);
    if (!m[2]) continue;
    for (const extra of m[2].split(",").map((x) => x.replace(/[#\s]/g, "")).filter(Boolean)) {
      if (extra.length >= 4 && extra.length <= 8) encontrados.add(`#${extra}`);
    }
  }

  return [...encontrados];
}

/** Forma de comparación: sin guiones, espacios ni almohadilla, en mayúsculas. */
export const normalizarCodigo = (codigo: string | null | undefined): string =>
  (codigo ?? "").toString().trim().toUpperCase().replace(/[-\s#._]/g, "");
