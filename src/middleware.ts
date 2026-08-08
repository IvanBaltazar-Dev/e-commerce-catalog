import { NextResponse, type NextRequest } from "next/server";

/**
 * Correlación mínima (Bloque 5, §11): toda petición de API lleva un
 * x-request-id — se adopta el del proxy si viene, se genera si no — y el
 * mismo id vuelve en la respuesta. Un pantallazo de un error alcanza para
 * encontrar su línea de log en el servidor.
 *
 * Autocontenido a propósito: corre en el runtime Edge y no arrastra módulos
 * de Node.
 */
export function middleware(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const requestId =
    incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : globalThis.crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: "/api/:path*"
};
