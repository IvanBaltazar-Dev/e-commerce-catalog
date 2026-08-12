import { z } from "zod";
import { handleApiError, ok, readJson } from "@/lib/api/http";
import {
  getCatalogReviewCase,
  resolveCatalogReviewCase,
  transitionCatalogReviewCase,
} from "@/lib/admin/catalog-review-service";
import { requireAdmin } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  command: z.literal("resolve"),
  expectedVersion: z.number().int().positive(),
  actionCode: z.string().trim().min(1).max(80),
  payload: z.record(z.string(), z.unknown()),
  evidence: z.array(z.record(z.string(), z.unknown())).max(100),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const transitionSchema = z.object({
  command: z.literal("transition"),
  expectedVersion: z.number().int().positive(),
  actionCode: z.enum(["start", "defer", "resume"]),
  reason: z.string().trim().max(1000),
  idempotencyKey: z.string().trim().min(8).max(200),
  deferMinutes: z.number().int().min(5).max(10080).optional(),
});

const commandSchema = z.discriminatedUnion("command", [resolveSchema, transitionSchema]);

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireAdmin();
    const { id } = await context.params;
    return ok({ case: await getCatalogReviewCase(supabase, z.string().uuid().parse(id)) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireAdmin();
    const { id } = await context.params;
    const caseId = z.string().uuid().parse(id);
    const input = await readJson(request, commandSchema);

    if (input.command === "resolve") {
      return ok(await resolveCatalogReviewCase(supabase, caseId, input));
    }
    return ok(await transitionCatalogReviewCase(supabase, caseId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
