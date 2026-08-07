import { cookies } from "next/headers";
import { z } from "zod";
import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CART_COOKIE = "br_cart";
const VISITOR_COOKIE = "br_vid";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

const openCartSchema = z.object({
  /** Token explícito (enlace compartido) por encima de la cookie. */
  publicToken: z.string().trim().min(32).max(80).optional().nullable(),
  /** Líneas del localStorage para la migración silenciosa. */
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(999)
  })).max(50).optional().nullable()
});

type CartDetail = {
  publicToken: string;
  [key: string]: unknown;
};

async function persistCartCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(CART_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: YEAR_SECONDS,
    path: "/"
  });
}

/** Detalle del carrito vigente. El precio se reevalúa en la base al leer. */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(CART_COOKIE)?.value;

    if (!token) return ok(null);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("public_cart_detail", { p_public_token: token });

    if (error) throw new HttpError(400, "cart_detail_failed", error.message);

    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Abre o recupera el carrito y, si vienen líneas locales, las sincroniza.
 * El servidor pasa a ser la fuente principal; el localStorage queda como caché
 * de arranque hasta su retiro documentado.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, openCartSchema);
    const cookieStore = await cookies();
    const supabase = await createSupabaseServerClient();

    const requestedToken = input.publicToken ?? cookieStore.get(CART_COOKIE)?.value ?? null;
    const visitorId = cookieStore.get(VISITOR_COOKIE)?.value ?? null;

    const { data: opened, error } = await supabase.rpc("get_or_create_public_cart", {
      p_public_token: requestedToken,
      p_visitor_id: visitorId,
      p_channel_code: "web"
    });

    if (error) throw new HttpError(400, "cart_open_failed", error.message);

    let detail = opened as CartDetail;

    if (input.lines && input.lines.length > 0) {
      const { data: synced, error: syncError } = await supabase.rpc("sync_public_cart", {
        p_public_token: detail.publicToken,
        p_lines: input.lines
      });

      if (syncError) throw new HttpError(400, "cart_sync_failed", syncError.message);
      detail = synced as CartDetail;
    }

    await persistCartCookie(detail.publicToken);

    return ok(detail);
  } catch (error) {
    return handleApiError(error);
  }
}
