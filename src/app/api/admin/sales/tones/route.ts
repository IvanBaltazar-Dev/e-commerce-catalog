import { z } from "zod";
import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  branch: z.string().uuid("Falta la sede desde la que se vende."),
  product: z.string().uuid("Falta el producto cuyos tonos se abren.")
});

/**
 * Hoja de tonos del POS: la tercera velocidad de la venta, «la clienta quiere
 * elegir».
 *
 * Devuelve TODOS los tonos del producto de una vez, y eso es deliberado: la
 * cuadrícula no puede recargarse ni reordenarse mientras la vendedora
 * selecciona, así que paginar por servidor rompería la regla de interacción.
 * 164 tonos de Masglo son ~40 KB, y se piden una sola vez al abrir.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) {
      throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Consulta inválida.");
    }

    const { data, error } = await supabase.rpc("pos_product_tones", {
      p_branch_id: parsed.data.branch,
      p_product_id: parsed.data.product
    });

    if (error) {
      // 42501 es el rechazo por sede ajena que levanta assert_branch_access:
      // es una respuesta legítima del dominio, no un fallo del servidor.
      if (error.code === "42501") throw new HttpError(403, "branch_forbidden", error.message);
      throw new HttpError(500, "tones_failed", "No se pudieron abrir los tonos de este producto.");
    }

    return ok(data ?? { product: null, families: [], tones: [] });
  } catch (error) {
    return handleApiError(error);
  }
}
