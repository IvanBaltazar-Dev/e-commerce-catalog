import { cookies } from "next/headers";
import { z } from "zod";
import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CART_COOKIE = "br_cart";

const setItemSchema = z.object({
  variantId: z.string().uuid(),
  /** Cantidad ABSOLUTA; cero retira la línea. */
  quantity: z.coerce.number().int().min(0).max(999),
  /** Versión conocida por el cliente: el conflicto responde 409 con la vigente. */
  expectedVersion: z.coerce.number().int().min(1).optional().nullable()
});

export async function POST(request: Request) {
  try {
    const input = await readJson(request, setItemSchema);
    const cookieStore = await cookies();
    const token = cookieStore.get(CART_COOKIE)?.value;

    if (!token) {
      throw new HttpError(400, "cart_missing", "No hay carrito abierto: sincroniza primero.");
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("set_public_cart_item", {
      p_public_token: token,
      p_variant_id: input.variantId,
      p_quantity: input.quantity,
      p_expected_version: input.expectedVersion ?? null
    });

    if (error) {
      // Versionado optimista: el conflicto NO es un error del cliente sino una
      // señal de que otro dispositivo escribió antes. 409 + refetch.
      if (error.code === "P0409" || /cart_version_conflict/.test(error.message)) {
        throw new HttpError(409, "cart_version_conflict", error.message);
      }
      throw new HttpError(400, "cart_item_failed", error.message);
    }

    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}
