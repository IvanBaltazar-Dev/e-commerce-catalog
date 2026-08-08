import { z } from "zod";
import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  branch: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reposition: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

/**
 * Existencias y reposición (D1 + D2) desde una sola definición.
 *
 * Las dos pantallas piden a `inventory_board`; lo único que cambia es el flag
 * de reposición. Así no hay dos ideas distintas de «está por agotarse» — que
 * es exactamente lo que pasaba cuando el listado usaba un `<= 5` y el Inicio
 * copiaba ese mismo número por su cuenta.
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

    const { data, error } = await supabase.rpc("inventory_board", {
      p_branch_id: parsed.data.branch ?? null,
      p_query: parsed.data.q ?? null,
      p_from: parsed.data.from ?? null,
      p_to: parsed.data.to ?? null,
      p_only_reposition: parsed.data.reposition === "true",
      p_limit: parsed.data.limit ?? 200
    });

    if (error) throw new HttpError(500, "inventory_board_failed", error.message);
    return ok(data ?? { items: [], total: 0 });
  } catch (error) {
    return handleApiError(error);
  }
}
