import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { HttpError } from "@/lib/api/errors";
import { logServerEvent } from "@/lib/observability/log";

export { HttpError };

/** El id que el middleware estampó en la petición; null fuera de una ruta. */
async function currentRequestId(): Promise<string | null> {
  try {
    return (await headers()).get("x-request-id");
  } catch {
    return null;
  }
}

export function ok<T>(data: T, init?: ResponseInit | number) {
  const responseInit = typeof init === "number" ? { status: init } : init;
  return NextResponse.json({ data }, responseInit);
}

export function created<T>(data: T) {
  return ok(data, 201);
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export async function readJson<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }

  return schema.parse(body);
}

export async function handleApiError(error: unknown) {
  const requestId = await currentRequestId();

  if (error instanceof HttpError) {
    // Un HttpError con código de PostgreSQL adjunto ES un fallo de RPC: se
    // clasifica aparte para poder filtrar incidentes de base de datos.
    const supabaseCode = (error.details as { supabaseCode?: string } | undefined)?.supabaseCode;
    if (error.status >= 500) {
      logServerEvent("http_5xx", {
        requestId, code: error.code, status: error.status, message: error.message
      });
    } else if (supabaseCode || error.code.endsWith("_failed")) {
      logServerEvent("rpc_error", {
        requestId, code: error.code, status: error.status, message: error.message, detail: supabaseCode ?? null
      });
    }

    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId
        }
      },
      { status: error.status }
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "Invalid input.",
          details: error.flatten(),
          requestId
        }
      },
      { status: 422 }
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error.";

  logServerEvent("http_5xx", { requestId, code: "internal_error", status: 500, message });

  return NextResponse.json(
    {
      error: {
        code: "internal_error",
        message,
        requestId
      }
    },
    { status: 500 }
  );
}

export function requireSupabaseData<T>(
  result: { data: T | null; error: { message: string; code?: string } | null },
  options: { status?: number; code: string }
): T {
  if (result.error) {
    throw new HttpError(options.status ?? 400, options.code, result.error.message, {
      supabaseCode: result.error.code
    });
  }

  if (result.data === null) {
    throw new HttpError(404, "not_found", "Resource not found.");
  }

  return result.data;
}
