import "server-only";

/**
 * Observabilidad mínima del Bloque 5: lo justo para responder «¿qué pasó?»
 * después de un incidente, sin convertirse en un proyecto de observabilidad.
 *
 * Una línea JSON por evento hacia stdout/stderr — que es exactamente lo que
 * Vercel y Supabase capturan y dejan buscar. Sin transportes, sin agentes.
 *
 * Clases de evento (para poder FILTRAR un incidente):
 *   http_5xx        errores de servidor en rutas API
 *   http_error      4xx relevantes que emitió el servidor (no del cliente)
 *   rpc_error       fallo de una función/RPC de PostgreSQL
 *   ai_failure      fallo del PROVEEDOR de IA — distinto de fallo operacional,
 *                   porque la regla 10 exige poder distinguirlos de un vistazo
 *   pdf_failure     fallo de generación del catálogo PDF
 *   storage_failure fallo de Storage (subidas, firmas)
 *
 * Correlación: cada petición lleva un requestId (o adopta x-request-id del
 * proxy). El mismo id viaja en el header de respuesta `x-request-id`, así un
 * pantallazo de la clienta alcanza para encontrar la línea del servidor.
 *
 * Regla de oro (§44): JAMÁS payloads sensibles ni secretos en una línea de
 * log. Códigos, rutas, ids y mensajes; nunca cuerpos completos.
 */

export type LogClass =
  | "http_5xx"
  | "http_error"
  | "rpc_error"
  | "ai_failure"
  | "pdf_failure"
  | "storage_failure";

export function newRequestId(incoming?: string | null): string {
  if (incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming)) return incoming;
  return globalThis.crypto.randomUUID();
}

export function logServerEvent(
  clazz: LogClass,
  fields: {
    requestId?: string | null;
    route?: string;
    code?: string;
    message: string;
    status?: number;
    detail?: string | null;
  }
) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    class: clazz,
    requestId: fields.requestId ?? undefined,
    route: fields.route,
    status: fields.status,
    code: fields.code,
    message: fields.message.slice(0, 500),
    detail: fields.detail?.slice(0, 500) ?? undefined
  });

  if (clazz === "http_5xx" || clazz === "rpc_error") {
    console.error(line);
  } else {
    console.warn(line);
  }
}
