import { NextResponse } from "next/server";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
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

export function handleApiError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
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
          details: error.flatten()
        }
      },
      { status: 422 }
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error.";

  return NextResponse.json(
    {
      error: {
        code: "internal_error",
        message
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
