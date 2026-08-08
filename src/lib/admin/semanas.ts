/**
 * La regla temporal del negocio, aislada y sin dependencias.
 *
 * Vive sola a propósito: es la invariante más fácil de romper sin que nadie lo
 * note —basta escribir `interval '7 days'` para que «la semana pasada» pase a
 * significar «los últimos siete días»— y así puede probarse sin arrastrar la
 * cadena de autenticación ni un navegador.
 *
 * Una semana es de lunes a domingo, siete días completos. Nunca una ventana
 * móvil.
 */

const LIMA = "America/Lima";

/** Hoy en Lima como fecha civil, sin arrastrar la hora del servidor. */
export function todayInLima(now = new Date()): Date {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: LIMA, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  return new Date(`${partes}T00:00:00Z`);
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export const iso = (date: Date) => date.toISOString().slice(0, 10);

export type Rango = { desde: string; hasta: string };

/**
 * La última semana CERRADA y la anterior, ambas de lunes a domingo.
 *
 * Para el sábado 08/08/2026 devuelve 27/07–02/08 contra 20/07–26/07: la semana
 * en curso NO entra, porque comparar tres días contra siete miente. El título
 * del bloque va en pasado justamente por esto.
 */
export function semanasCerradas(hoy: Date): { pasada: Rango; anterior: Rango } {
  // getUTCDay: 0 domingo, 1 lunes. Se busca el lunes de la semana en curso.
  const diaSemana = hoy.getUTCDay();
  const desdeElLunes = diaSemana === 0 ? 6 : diaSemana - 1;
  const lunesEnCurso = addDays(hoy, -desdeElLunes);

  const finPasada = addDays(lunesEnCurso, -1);
  const inicioPasada = addDays(finPasada, -6);
  const finAnterior = addDays(inicioPasada, -1);
  const inicioAnterior = addDays(finAnterior, -6);

  return {
    pasada: { desde: iso(inicioPasada), hasta: iso(finPasada) },
    anterior: { desde: iso(inicioAnterior), hasta: iso(finAnterior) }
  };
}
