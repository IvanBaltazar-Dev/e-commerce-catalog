import { z } from "zod";
import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  branch: z.string().uuid("Falta la sede desde la que se vende."),
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(60).optional()
});

/**
 * Búsqueda del POS: devuelve la VARIANTE, no el producto.
 *
 * La primera velocidad de la venta es «sé qué quiere»: la vendedora teclea
 * «Abrumadora» o escanea un código y necesita la fila exacta, no un esmalte
 * que la obligue a recorrer 200 tonos. El orden y el recorte por sede los
 * resuelve `pos_variant_search` en la base, que es donde está la RLS.
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

    const { data, error } = await supabase.rpc("pos_variant_search", {
      p_branch_id: parsed.data.branch,
      p_query: parsed.data.q,
      p_limit: parsed.data.limit ?? 24
    });

    if (error) {
      // 42501 es el rechazo por sede ajena que levanta assert_branch_access:
      // es una respuesta legítima del dominio, no un fallo del servidor.
      if (error.code === "42501") throw new HttpError(403, "branch_forbidden", error.message);
      throw new HttpError(500, "search_failed", "No se pudo buscar en el catálogo de venta.");
    }

    return ok(data ?? { items: [], total: 0 });
  } catch (error) {
    return handleApiError(error);
  }
}
