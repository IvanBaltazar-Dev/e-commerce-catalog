import { z } from "zod";
import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { loadInventoryBoard } from "@/lib/admin/inventory-board-service";
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

    const data = await loadInventoryBoard(supabase, {
      branchId: parsed.data.branch,
      query: parsed.data.q,
      from: parsed.data.from,
      to: parsed.data.to,
      onlyReposition: parsed.data.reposition === "true",
      limit: parsed.data.limit,
    });
    return ok(data);
  } catch (error) {
    return handleApiError(error);
  }
}
