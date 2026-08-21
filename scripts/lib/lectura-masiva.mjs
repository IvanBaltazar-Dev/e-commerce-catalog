/**
 * Lectura masiva paginada con orden estable obligatorio y verificación de que
 * no se pierde ni se repite nada.
 *
 * El invariante nace de un fallo medido, no de una precaución teórica. Al leer
 * catalog_observations con OFFSET/LIMIT sin ORDER BY:
 *
 *   18.836 filas devueltas · 10.808 llaves distintas · 8.028 repetidas
 *
 * El 43% de las filas no salía nunca. Y lo peor: el TOTAL era correcto. Cualquier
 * comprobación basada en contar filas —incluido un count(*) contra la tabla— da
 * verde. Solo contar llaves DISTINTAS lo detecta.
 *
 * Dos decisiones que se siguen de ahí:
 *
 *   · el orden es un argumento obligatorio, no un valor por defecto. Elegirlo
 *     implícitamente es cómo se coló: nadie decidió no ordenar, simplemente
 *     nadie decidió ordenar.
 *
 *   · se valida por página y al final. Por página, porque una página que ya
 *     trae repetidos delata el problema antes de acumular 18.000 filas; al
 *     final, porque el solapamiento entre páginas solo se ve al juntarlas.
 */

/** Error con el detalle necesario para saber qué conjunto quedó ambiguo. */
export class LecturaAmbiguaError extends Error {
  constructor(mensaje, detalle) {
    super(mensaje);
    this.name = "LecturaAmbiguaError";
    this.detalle = detalle;
  }
}

/**
 * @param {object} opciones
 * @param {() => any} opciones.consulta      fábrica de consulta (sin order ni range)
 * @param {string[]} opciones.orden          columnas de orden estable. Obligatorio.
 * @param {(fila:any)=>string} opciones.clave  identidad de la fila, para contar distintos
 * @param {string} [opciones.nombre]         para los mensajes de error
 * @param {number} [opciones.tamanoPagina]
 */
export async function leerTodo({ consulta, orden, clave, nombre = "lectura", tamanoPagina = 1000 }) {
  if (!Array.isArray(orden) || orden.length === 0) {
    throw new LecturaAmbiguaError(
      `${nombre}: paginar sin orden estable no está permitido.\n` +
      `OFFSET/LIMIT sobre un resultado sin ordenar no está definido: PostgreSQL puede\n` +
      `devolver las filas en distinto orden en cada página, y entonces unas se repiten\n` +
      `y otras no salen nunca. Declara las columnas de orden.`,
      { nombre },
    );
  }
  if (typeof clave !== "function") {
    throw new LecturaAmbiguaError(
      `${nombre}: hace falta una función de clave para poder comprobar que no se pierde nada.\n` +
      `Contar filas no basta: el total puede ser correcto y faltar el 43% de las identidades.`,
      { nombre },
    );
  }

  const filas = [];
  const vistas = new Set();
  let pagina = 0;

  for (let desde = 0; ; desde += tamanoPagina, pagina += 1) {
    let q = consulta();
    for (const columna of orden) q = q.order(columna);
    const { data, error } = await q.range(desde, desde + tamanoPagina - 1);
    if (error) throw new Error(`${nombre} página ${pagina}: ${error.message}`);
    const lote = data ?? [];

    // Por página: repetidos dentro del mismo lote, o filas ya vistas antes.
    const clavesLote = lote.map(clave);
    const distintasEnLote = new Set(clavesLote);
    const yaVistas = clavesLote.filter((k) => vistas.has(k));
    if (distintasEnLote.size !== lote.length || yaVistas.length) {
      throw new LecturaAmbiguaError(
        `${nombre}: la página ${pagina} devuelve filas ambiguas.\n` +
        `  filas en la página:      ${lote.length}\n` +
        `  distintas en la página:  ${distintasEnLote.size}\n` +
        `  ya devueltas antes:      ${yaVistas.length}\n` +
        `El orden declarado (${orden.join(", ")}) no es estable para esta consulta.`,
        { nombre, pagina, filas: lote.length, distintas: distintasEnLote.size, repetidas: yaVistas.length },
      );
    }
    for (const k of clavesLote) vistas.add(k);
    filas.push(...lote);
    if (lote.length < tamanoPagina) break;
  }

  // Al final: la comprobación que el recuento de filas nunca habría hecho.
  if (filas.length !== vistas.size) {
    throw new LecturaAmbiguaError(
      `${nombre}: ${filas.length} filas pero solo ${vistas.size} identidades distintas.\n` +
      `Se perdieron ${filas.length - vistas.size} identidades.`,
      { nombre, filas: filas.length, distintas: vistas.size },
    );
  }
  return filas;
}

/**
 * Comprueba que el conjunto paginado coincide con la consulta completa ordenada.
 * Es más caro que leerTodo y se usa como verificación de campaña, no en cada
 * lectura: confirma que no solo las páginas son coherentes entre sí, sino que
 * juntas dan lo mismo que pedir todo de una vez.
 */
export async function verificarConjunto({ consulta, orden, clave, nombre = "conjunto", total }) {
  const porPaginas = await leerTodo({ consulta, orden, clave, nombre });
  if (typeof total === "number" && porPaginas.length !== total) {
    throw new LecturaAmbiguaError(
      `${nombre}: la lectura paginada trae ${porPaginas.length} y la fuente declara ${total}.`,
      { nombre, paginado: porPaginas.length, declarado: total },
    );
  }
  return { filas: porPaginas, distintas: new Set(porPaginas.map(clave)).size };
}
