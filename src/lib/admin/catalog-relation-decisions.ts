export type CatalogRelationDecisionAction = {
  code: string;
  label: string;
  effect: string;
  requiresComment: boolean;
  requiresPreview: boolean;
};

export type CatalogRelationDecision = {
  decisionId: string;
  familyCode: "CLASS_RULE_PROMOTION" | "ENDPOINT_SCOPE_RECLASSIFICATION" | "FALSE_PAIR_RETIREMENT";
  decisionStatus: "pending" | "applied" | "rejected" | "adjustment_requested" | "superseded";
  title: string;
  problem: string;
  recommendation: string;
  solves: string;
  uncertainBehavior: string;
  unchangedBusinessEffects: string;
  decisionQuestion: string;
  actions: CatalogRelationDecisionAction[];
  affectedCount: number;
  affectedProductCount: number;
  evidenceSummary: Record<string, unknown>;
  impactPreview: Record<string, unknown>;
  decisionFingerprint: string;
  workItemId: string;
  workVersion: number;
  workStatus: string;
  queueState: string;
  canResolveNow: boolean;
  isDeferred: boolean;
  deferReason: string | null;
  deferredUntil: string | null;
  resolvedAction: string | null;
  resolutionComment: string | null;
  resolvedAt: string | null;
};

export type CatalogRelationDecisionQueue = {
  contractVersion: string;
  status: string;
  total: number;
  pending: number;
  deferred: number;
  limit: number;
  offset: number;
  decisions: CatalogRelationDecision[];
};

export type CatalogRelationDecisionAffectedItem = {
  position: number;
  candidateId: string;
  sourceProduct: { id: string; name: string; type: string | null };
  targetProduct: { id: string; name: string; type: string | null };
  currentStatus: string;
  proposal: Record<string, unknown>;
  needsTypeConfirmation: boolean;
  evidenceLabel: string;
  audit: Record<string, unknown>;
};

export type CatalogRelationDecisionDetail = {
  contractVersion: string;
  decision: CatalogRelationDecision;
  affectedTotal: number;
  itemLimit: number;
  itemOffset: number;
  affected: CatalogRelationDecisionAffectedItem[];
  history: Array<{
    eventType: string;
    actionCode: string | null;
    actorLabel: string | null;
    payload: Record<string, unknown>;
    occurredAt: string;
  }>;
};

export type CatalogRelationDecisionPreview = {
  contractVersion: string;
  previewId: string;
  status: string;
  decisionId: string;
  actionCode: string;
  previewFingerprint: string;
  expectedWorkVersion: number;
  confirmation: { title: string; question: string; comment: string | null };
  impact: Record<string, unknown>;
  idempotentReplay: boolean;
};

export type CatalogRelationDecisionTransition = {
  contractVersion: string;
  decisionId: string;
  decisionResolved: false;
  transition: {
    workItemId: string;
    status: string;
    rowVersion: number;
    deferredUntil: string | null;
    idempotentReplay: boolean;
  };
};

export type CatalogRelationDecisionApplyResult = {
  apply: {
    decisionId: string;
    status: string;
    actionCode: string;
    impact: Record<string, unknown>;
    idempotentReplay: boolean;
  };
  graph: { ok: boolean; nodes: number; edges: number };
  verification: { passed: boolean; checks: Record<string, boolean> };
};
