import { z } from "zod";
import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import {
  applyCatalogRelationDecision,
  getCatalogRelationDecisionDetail,
  getCatalogRelationDecisionQueue,
  previewCatalogRelationDecision,
  transitionCatalogRelationDecision,
  verifyCatalogRelationDecision,
} from "@/lib/admin/catalog-relation-decision-service";
import { requireAdmin } from "@/lib/auth/admin";
import {
  createGraphDriverFromEnv,
  createPostgresPoolFromEnv,
  GraphProjector,
} from "@/lib/catalog-intelligence/graph-projector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewSchema = z.object({
  command: z.literal("preview"),
  decisionId: z.string().trim().min(1).max(120),
  actionCode: z.enum([
    "ACCEPT_CLASS_RULE", "REJECT_CLASS_RULE", "ACCEPT_MEMBERSHIP_SCOPE",
    "ADJUST_ENDPOINT_PROFILE", "ACCEPT_FALSE_PAIR_RETIREMENT",
  ]),
  comment: z.string().trim().max(1000).nullable(),
  expectedWorkVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
});
const deferSchema = z.object({
  command: z.literal("defer"),
  decisionId: z.string().trim().min(1).max(120),
  expectedWorkVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  deferMinutes: z.number().int().min(5).max(10080),
  idempotencyKey: z.string().trim().min(8).max(200),
});
const resumeSchema = z.object({
  command: z.literal("resume"),
  decisionId: z.string().trim().min(1).max(120),
  expectedWorkVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200),
});
const applySchema = z.object({
  command: z.literal("apply"),
  previewId: z.string().uuid(),
  previewFingerprint: z.string().length(64),
  idempotencyKey: z.string().trim().min(8).max(200),
});
const commandSchema = z.discriminatedUnion("command", [
  previewSchema, deferSchema, resumeSchema, applySchema,
]);

export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const search = new URL(request.url).searchParams;
    const mode = search.get("mode") ?? "queue";
    if (mode === "queue") {
      const limit = Number(search.get("limit") ?? 25);
      const offset = Number(search.get("offset") ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100
          || !Number.isInteger(offset) || offset < 0) {
        throw new HttpError(400, "catalog_relation_decision_pagination_invalid", "La página solicitada no es válida.");
      }
      return ok(await getCatalogRelationDecisionQueue(supabase, {
        status: search.get("status") ?? "pending", limit, offset,
      }));
    }
    if (mode === "detail") {
      const decisionId = search.get("decisionId") ?? "";
      const limit = Number(search.get("limit") ?? 25);
      const offset = Number(search.get("offset") ?? 0);
      return ok(await getCatalogRelationDecisionDetail(supabase, decisionId, limit, offset));
    }
    throw new HttpError(400, "catalog_relation_decision_mode_invalid", "La lectura solicitada no existe.");
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, commandSchema);
    if (input.command === "preview") {
      return ok(await previewCatalogRelationDecision(supabase, input));
    }
    if (input.command === "defer") {
      return ok(await transitionCatalogRelationDecision(supabase, {
        ...input, actionCode: "KEEP_DEFERRED",
      }));
    }
    if (input.command === "resume") {
      return ok(await transitionCatalogRelationDecision(supabase, {
        ...input, actionCode: "RESUME", reason: null, deferMinutes: 1440,
      }));
    }

    const applied = await applyCatalogRelationDecision(supabase, input);
    const driver = createGraphDriverFromEnv(process.env);
    const postgres = createPostgresPoolFromEnv(process.env);
    let graph;
    try {
      graph = await new GraphProjector({
        supabase, postgres, driver, database: process.env.NEO4J_DATABASE || undefined,
      }).sync();
    } finally {
      await driver.close();
      await postgres.end();
    }
    const verification = await verifyCatalogRelationDecision(supabase, applied.decisionId);
    if (!graph.ok || !verification.passed) {
      throw new HttpError(500, "catalog_relation_decision_verify_failed",
        "La decisión quedó registrada, pero la proyección necesita reparación.", { graph, verification });
    }
    return ok({ apply: applied, graph, verification });
  } catch (error) {
    return handleApiError(error);
  }
}
