export type CatalogReviewSummary = {
  reviewable: number;
  capture: number;
  waiting: number;
  completed: number;
  blocked: number;
  potentialUnlocks: number;
  automaticDebt: number;
  humanShareOfActive: number;
};

export type CatalogReviewActivity = {
  decisionsToday: number;
  unlockedToday: number;
  entitiesAdvancedToday: number;
};

export type CatalogReviewEvidence = {
  id: string;
  kind: "fact" | "link" | "image" | "warning";
  label: string;
  value: string;
  url?: string;
  imageUrl?: string;
};

export type CatalogReviewOption = {
  id: string;
  actionCode: string;
  label: string;
  description: string;
  tone: "confirm" | "reject" | "neutral";
  requiresReason: boolean;
  payload?: Record<string, unknown>;
};

export type CatalogReviewEntity = {
  id: string | null;
  type: string;
  name: string;
  code: string | null;
  brand: string | null;
  description: string | null;
  imageUrl: string | null;
  parent: { id: string; name: string; code: string | null } | null;
  facts: Array<{
    label: string;
    value: string;
    group: "record" | "catalog" | "source";
    status?: "known" | "missing" | "warning";
  }>;
  sourceSnapshot: {
    fileName: string;
    sheet: string;
    rowNumber: number | null;
    fields: Array<{ label: string; value: string }>;
  } | null;
};

export type CatalogReviewDecisionScope = {
  resolves: string;
  approveEffect: string;
  rejectEffect: string;
  doesNotResolve: string[];
};

export type CatalogReviewTarget = {
  id: string;
  entityType: "product" | "variant";
  productId: string;
  name: string;
  productName: string;
  code: string | null;
  brand: string | null;
  detail: string;
  imageUrl: string | null;
};

export type CatalogReviewHistoryEvent = {
  id: string;
  title: string;
  detail: string;
  actor: string;
  occurredAt: string;
  tone: "neutral" | "success" | "warning";
};

export type CatalogReviewCase = {
  id: string;
  workKey: string;
  rowVersion: number;
  caseKind:
    | "identity_match"
    | "identity_conflict"
    | "image_review"
    | "classification"
    | "relation_evidence"
    | "source_verification"
    | "general_decision";
  title: string;
  eyebrow: string;
  question: string;
  findingSummary: string;
  entity: CatalogReviewEntity;
  decisionScope: CatalogReviewDecisionScope;
  evidence: CatalogReviewEvidence[];
  options: CatalogReviewOption[];
  recommendedAction: string | null;
  impact: {
    unlockCount: number;
    blockedByCount: number;
    invalidatedByCount: number;
  };
  warnings: string[];
  risk: "critical" | "high" | "normal" | "low";
  hasContradiction: boolean;
  canSkip: boolean;
  canRequestCapture: boolean;
  history: CatalogReviewHistoryEvent[];
  relatedOpenWork: Array<{ purpose: string; label: string; count: number }>;
};

export type CatalogReviewBootstrap = {
  summary: CatalogReviewSummary;
  activity: CatalogReviewActivity;
  nextCase: CatalogReviewCase | null;
};

export type CatalogReviewResolveInput = {
  expectedVersion: number;
  actionCode: string;
  payload: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  idempotencyKey: string;
};

export type CatalogReviewTransitionInput = {
  expectedVersion: number;
  actionCode: "start" | "defer" | "resume";
  reason: string;
  idempotencyKey: string;
  deferMinutes?: number;
};

export type CatalogReviewCommandResult = {
  workItemId: string;
  status: string;
  rowVersion: number;
  unlockedCount: number;
  invalidatedCount: number;
  deferredUntil: string | null;
  idempotentReplay: boolean;
};

export type CatalogReviewListResult = {
  items: CatalogReviewCase[];
  nextCursor: string | null;
};
