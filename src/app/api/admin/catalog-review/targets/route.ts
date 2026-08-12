import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/http";
import { searchCatalogReviewTargets } from "@/lib/admin/catalog-review-service";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(12),
});

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireAdmin();
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    return ok({ items: await searchCatalogReviewTargets(supabase, input.q, input.limit) });
  } catch (error) {
    return handleApiError(error);
  }
}
