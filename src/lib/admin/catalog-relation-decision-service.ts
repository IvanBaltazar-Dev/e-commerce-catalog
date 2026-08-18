import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import type {
  CatalogRelationDecision,
  CatalogRelationDecisionApplyResult,
  CatalogRelationDecisionDetail,
  CatalogRelationDecisionPreview,
  CatalogRelationDecisionQueue,
  CatalogRelationDecisionTransition,
} from "@/lib/admin/catalog-relation-decisions";

type JsonObject = Record<string, unknown>;
type Supabase = SupabaseClient;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rpcFailure(error: { code?: string; message: string }, fallbackCode: string): never {
  if (error.code === "40001") {
    throw new HttpError(409, "catalog_relation_decision_stale", error.message, { supabaseCode: error.code });
  }
  if (error.code === "23514" || error.code === "23505") {
    throw new HttpError(409, "catalog_relation_decision_conflict", error.message, { supabaseCode: error.code });
  }
  if (error.code === "22023") {
    throw new HttpError(422, "catalog_relation_decision_invalid", error.message, { supabaseCode: error.code });
  }
  if (error.code === "42501") {
    throw new HttpError(403, "catalog_relation_decision_forbidden", error.message, { supabaseCode: error.code });
  }
  throw new HttpError(400, fallbackCode, error.message, { supabaseCode: error.code });
}

function presentDecision(value: unknown): CatalogRelationDecision {
  const row = object(value);
  return {
    decisionId: text(row.decision_id) ?? "",
    familyCode: (text(row.family_code) ?? "CLASS_RULE_PROMOTION") as CatalogRelationDecision["familyCode"],
    decisionStatus: (text(row.decision_status) ?? "pending") as CatalogRelationDecision["decisionStatus"],
    title: text(row.title) ?? "Decisión de catálogo",
    problem: text(row.problem) ?? "Hay una relación que necesita revisión.",
    recommendation: text(row.recommendation) ?? "Revisar el alcance propuesto.",
    solves: text(row.solves) ?? "Aclara cómo debe comportarse el catálogo.",
    uncertainBehavior: text(row.uncertain_behavior) ?? "Lo que no esté confirmado seguirá pendiente.",
    unchangedBusinessEffects: text(row.unchanged_business_effects) ?? "No cambia precio, stock ni publicación.",
    decisionQuestion: text(row.decision_question) ?? "¿Quieres aplicar esta recomendación?",
    actions: Array.isArray(row.actions) ? row.actions as CatalogRelationDecision["actions"] : [],
    affectedCount: number(row.affected_count),
    affectedProductCount: number(row.affected_product_count),
    evidenceSummary: object(row.evidence_summary),
    impactPreview: object(row.impact_preview),
    decisionFingerprint: text(row.decision_fingerprint) ?? "",
    workItemId: text(row.work_item_id) ?? "",
    workVersion: number(row.work_version),
    workStatus: text(row.work_status) ?? "open",
    queueState: text(row.queue_state) ?? "reviewable",
    canResolveNow: row.can_resolve_now === true,
    isDeferred: row.is_deferred === true,
    deferReason: text(row.defer_reason),
    deferredUntil: text(row.deferred_until),
    resolvedAction: text(row.resolved_action),
    resolutionComment: text(row.resolution_comment),
    resolvedAt: text(row.resolved_at),
  };
}

export async function getCatalogRelationDecisionQueue(
  supabase: Supabase,
  options: { status?: string; limit?: number; offset?: number } = {},
): Promise<CatalogRelationDecisionQueue> {
  const result = await supabase.rpc("get_catalog_relation_decision_queue_v1", {
    p_status: options.status ?? "pending",
    p_limit: options.limit ?? 25,
    p_offset: options.offset ?? 0,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_queue_failed");
  const data = object(result.data);
  return {
    contractVersion: text(data.contractVersion) ?? "stage4e-v1",
    status: text(data.status) ?? "pending",
    total: number(data.total),
    pending: number(data.pending),
    deferred: number(data.deferred),
    limit: number(data.limit),
    offset: number(data.offset),
    decisions: Array.isArray(data.decisions) ? data.decisions.map(presentDecision) : [],
  };
}

export async function getCatalogRelationDecisionDetail(
  supabase: Supabase,
  decisionId: string,
  itemLimit = 25,
  itemOffset = 0,
): Promise<CatalogRelationDecisionDetail> {
  const result = await supabase.rpc("get_catalog_relation_decision_detail_v1", {
    p_decision_id: decisionId,
    p_item_limit: itemLimit,
    p_item_offset: itemOffset,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_detail_failed");
  const data = object(result.data);
  return {
    contractVersion: text(data.contractVersion) ?? "stage4e-v1",
    decision: presentDecision(data.decision),
    affectedTotal: number(data.affectedTotal),
    itemLimit: number(data.itemLimit),
    itemOffset: number(data.itemOffset),
    affected: Array.isArray(data.affected)
      ? data.affected as CatalogRelationDecisionDetail["affected"]
      : [],
    history: Array.isArray(data.history)
      ? data.history as CatalogRelationDecisionDetail["history"]
      : [],
  };
}

export async function previewCatalogRelationDecision(
  supabase: Supabase,
  input: {
    decisionId: string;
    actionCode: string;
    comment: string | null;
    expectedWorkVersion: number;
    idempotencyKey: string;
  },
): Promise<CatalogRelationDecisionPreview> {
  const result = await supabase.rpc("preview_catalog_relation_decision_v1", {
    p_decision_id: input.decisionId,
    p_action_code: input.actionCode,
    p_comment: input.comment,
    p_expected_work_version: input.expectedWorkVersion,
    p_idempotency_key: input.idempotencyKey,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_preview_failed");
  return result.data as CatalogRelationDecisionPreview;
}

export async function transitionCatalogRelationDecision(
  supabase: Supabase,
  input: {
    decisionId: string;
    expectedWorkVersion: number;
    actionCode: "KEEP_DEFERRED" | "RESUME";
    reason: string | null;
    deferMinutes: number;
    idempotencyKey: string;
  },
): Promise<CatalogRelationDecisionTransition> {
  const result = await supabase.rpc("transition_catalog_relation_decision_v1", {
    p_decision_id: input.decisionId,
    p_expected_work_version: input.expectedWorkVersion,
    p_action_code: input.actionCode,
    p_reason: input.reason,
    p_defer_minutes: input.deferMinutes,
    p_idempotency_key: input.idempotencyKey,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_transition_failed");
  return result.data as CatalogRelationDecisionTransition;
}

export async function applyCatalogRelationDecision(
  supabase: Supabase,
  input: { previewId: string; previewFingerprint: string; idempotencyKey: string },
): Promise<CatalogRelationDecisionApplyResult["apply"]> {
  const result = await supabase.rpc("apply_catalog_relation_decision_v1", {
    p_preview_id: input.previewId,
    p_preview_fingerprint: input.previewFingerprint,
    p_idempotency_key: input.idempotencyKey,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_apply_failed");
  return result.data as CatalogRelationDecisionApplyResult["apply"];
}

export async function verifyCatalogRelationDecision(supabase: Supabase, decisionId: string) {
  const result = await supabase.rpc("verify_catalog_relation_decision_v1", {
    p_decision_id: decisionId,
  });
  if (result.error) rpcFailure(result.error, "catalog_relation_decision_verify_failed");
  return result.data as CatalogRelationDecisionApplyResult["verification"];
}
