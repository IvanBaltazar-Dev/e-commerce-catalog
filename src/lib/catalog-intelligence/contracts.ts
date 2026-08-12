export const RESEARCH_RUN_KINDS = ["baseline", "delta", "targeted"] as const;
export const RESEARCH_RUN_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export const REFERENCE_LEVELS = ["REFERENCE_LIGHT", "REFERENCE_ENRICHED"] as const;
export const REFERENCE_PRESENCE_STATUSES = [
  "present",
  "missing_from_source",
  "source_unavailable",
  "retired",
] as const;
export const REFERENCE_DELTA_STATUSES = [
  "first_seen",
  "unchanged",
  "changed",
  "missing_from_source",
  "returned",
  "source_unavailable",
] as const;
export const REFERENCE_KNOWLEDGE_STATUSES = [
  "discovered",
  "observed",
  "matched_internal",
  "candidate_new",
  "ready_for_commercial_decision",
  "adopted",
  "rejected",
  "identity_conflict",
  "needs_research",
  "needs_physical_capture",
] as const;

export type ResearchRunKind = (typeof RESEARCH_RUN_KINDS)[number];
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];
export type ReferenceLevel = (typeof REFERENCE_LEVELS)[number];
export type ReferencePresenceStatus = (typeof REFERENCE_PRESENCE_STATUSES)[number];
export type ReferenceDeltaStatus = (typeof REFERENCE_DELTA_STATUSES)[number];
export type ReferenceKnowledgeStatus = (typeof REFERENCE_KNOWLEDGE_STATUSES)[number];

export type JsonObject = Record<string, unknown>;

export interface ResearchRunInput {
  runKey: string;
  kind: ResearchRunKind;
  previousRunId?: string | null;
  actor: {
    kind: "human" | "codex" | "import" | "system";
    userId?: string | null;
    label: string;
  };
  inputFingerprint: string;
  scope: JsonObject;
  brandIds: string[];
  sources: Array<{
    sourceId: string;
    brandId?: string | null;
    scopeKey: string;
    previousRunSourceId?: string | null;
    inputFingerprint: string;
    scope: JsonObject;
  }>;
}

export interface ReferenceProductInput {
  referenceKey: string;
  brandId: string;
  sourceId: string;
  sourceRecordId?: string | null;
  externalId: string;
  name: string;
  normalizedName: string;
  family?: string | null;
  productType?: string | null;
  line?: string | null;
  presentation?: string | null;
  sourceUrl: string;
  imageUrl?: string | null;
  identityFingerprint: string;
  contentFingerprint: string;
  level?: ReferenceLevel;
  metadata?: JsonObject;
}

export interface ReferenceVariantInput {
  referenceKey: string;
  referenceProductId: string;
  sourceId: string;
  sourceRecordId?: string | null;
  externalId: string;
  name: string;
  normalizedName: string;
  sku?: string | null;
  barcode?: string | null;
  shadeName?: string | null;
  presentation?: string | null;
  sourceUrl: string;
  imageUrl?: string | null;
  identityFingerprint: string;
  contentFingerprint: string;
  level?: ReferenceLevel;
  metadata?: JsonObject;
}

export interface ReferenceObservationInput {
  observationKey: string;
  sourceRecordId: string;
  researchRunId: string;
  subject:
    | { kind: "reference_product"; id: string }
    | { kind: "reference_variant"; id: string };
  kind:
    | "attribute"
    | "identity"
    | "code"
    | "type"
    | "presentation"
    | "shade"
    | "technical_attribute"
    | "system"
    | "stage"
    | "class"
    | "relation"
    | "remote_image"
    | "lifecycle";
  predicate: string;
  attributeDefinitionId?: string | null;
  value: {
    text?: string;
    number?: number;
    boolean?: boolean;
    date?: string;
    json?: unknown;
    optionId?: string;
    relatedRef?: {
      kind: "product" | "variant" | "reference_product" | "reference_variant" | "system" | "stage" | "class";
      id: string;
    };
  };
  observedUnit?: string | null;
  observedAt: string;
  extractionMethod:
    | "official_api"
    | "official_page"
    | "authorized_distributor"
    | "internal_document"
    | "physical_packaging"
    | "spreadsheet"
    | "manual_capture"
    | "computer_vision";
  extractor?: string | null;
  confidence: number;
  metadata?: JsonObject;
}

export interface ExternalPriceInput {
  priceKey: string;
  researchRunId: string;
  subject:
    | { kind: "reference_product"; id: string }
    | { kind: "reference_variant"; id: string };
  sourceId: string;
  sourceRecordId?: string | null;
  currency: string;
  amount: number;
  presentation?: string | null;
  availability?: "available" | "out_of_stock" | "preorder" | "unknown" | "unavailable" | null;
  observedAt: string;
  contentFingerprint: string;
  metadata?: JsonObject;
}

export type ReferenceSubject =
  | { kind: "reference_product"; id: string }
  | { kind: "reference_variant"; id: string };

export interface ReferenceIdentifierInput {
  subject: ReferenceSubject;
  sourceId: string;
  sourceRecordId?: string | null;
  kind: "external_id" | "sku" | "barcode" | "mpn" | "source_url" | "handle";
  observedValue: string;
  normalizedValue: string;
  researchRunId: string;
  observedAt: string;
}

export type ReferencePresenceInput =
  | {
      researchRunSourceId: string;
      subject: ReferenceSubject;
      delta: Exclude<ReferenceDeltaStatus, "source_unavailable">;
      previousFingerprint?: string | null;
      currentFingerprint?: string | null;
      observedAt: string;
      metadata?: JsonObject;
    }
  | {
      researchRunSourceId: string;
      delta: "source_unavailable";
      previousFingerprint?: string | null;
      currentFingerprint?: null;
      observedAt: string;
      metadata?: JsonObject;
    };

export interface ReferenceCandidateQuery {
  brandId: string;
  sourceId: string;
  identifierKind?: ReferenceIdentifierInput["kind"] | null;
  identifierValue?: string | null;
  normalizedName?: string | null;
  limit?: number;
}

export interface GraphNodeProjection {
  node_key: string;
  node_type: string;
  entity_id: string;
  label: string;
  layer: "canonical" | "reference" | "evidence" | "candidate";
  properties: JsonObject;
  projection_fingerprint: string;
}

export interface GraphEdgeProjection {
  edge_key: string;
  source_key: string;
  predicate: string;
  target_key: string;
  layer: "canonical" | "reference" | "evidence" | "candidate";
  properties: JsonObject;
  projection_fingerprint: string;
}

export interface GraphVerification {
  missingNodes: string[];
  duplicateNodes: string[];
  orphanNodes: string[];
  missingEdges: string[];
  duplicateEdges: string[];
  orphanEdges: string[];
  invalidReferences: string[];
  staleProjectorNodes: string[];
  staleProjectorEdges: string[];
  unexpectedNodes: string[];
  unexpectedEdges: string[];
}
