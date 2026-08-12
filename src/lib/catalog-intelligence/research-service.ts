import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ExternalPriceInput,
  ReferenceCandidateQuery,
  ReferenceIdentifierInput,
  ReferenceObservationInput,
  ReferencePresenceInput,
  ReferenceProductInput,
  ReferenceVariantInput,
  ResearchRunInput,
} from "./contracts";

type ServiceClient = SupabaseClient;

function assertSuccess<T>(result: { data: T; error: { message: string } | null }, operation: string): T {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

function subjectColumns(subject: { kind: "reference_product" | "reference_variant"; id: string }) {
  return subject.kind === "reference_product"
    ? { reference_product_id: subject.id, reference_variant_id: null }
    : { reference_product_id: null, reference_variant_id: subject.id };
}

export async function beginResearchRun(client: ServiceClient, input: ResearchRunInput) {
  const run = assertSuccess(
    await client
      .from("catalog_research_runs")
      .upsert(
        {
          run_key: input.runKey,
          run_kind: input.kind,
          previous_run_id: input.previousRunId ?? null,
          actor_kind: input.actor.kind,
          actor_user_id: input.actor.userId ?? null,
          actor_label: input.actor.label,
          status: "running",
          input_fingerprint: input.inputFingerprint,
          scope: input.scope,
        },
        { onConflict: "run_key", ignoreDuplicates: true },
      )
      .select("id, run_key, status")
      .maybeSingle(),
    "beginResearchRun",
  );

  const resolved =
    run ??
    assertSuccess(
      await client.from("catalog_research_runs").select("id, run_key, status").eq("run_key", input.runKey).single(),
      "loadResearchRun",
    );

  if (!resolved) throw new Error("loadResearchRun: la corrida no pudo resolverse.");

  if (input.brandIds.length) {
    assertSuccess(
      await client.from("catalog_research_run_brands").upsert(
        input.brandIds.map((brandId) => ({ research_run_id: resolved.id, brand_id: brandId })),
        { onConflict: "research_run_id,brand_id", ignoreDuplicates: true },
      ),
      "attachResearchRunBrands",
    );
  }

  if (input.sources.length) {
    assertSuccess(
      await client.from("catalog_research_run_sources").upsert(
        input.sources.map((source) => ({
          research_run_id: resolved.id,
          source_id: source.sourceId,
          brand_id: source.brandId ?? null,
          scope_key: source.scopeKey,
          previous_run_source_id: source.previousRunSourceId ?? null,
          input_fingerprint: source.inputFingerprint,
          scope: source.scope,
        })),
        { onConflict: "research_run_id,source_id,scope_key", ignoreDuplicates: true },
      ),
      "attachResearchRunSources",
    );
  }

  return resolved;
}

export async function upsertReferenceProduct(
  client: ServiceClient,
  researchRunId: string,
  observedAt: string,
  input: ReferenceProductInput,
) {
  return assertSuccess(
    await client.rpc("upsert_catalog_reference_product_v1", {
      p_research_run_id: researchRunId,
      p_observed_at: observedAt,
      p_payload: input,
    }),
    "upsertReferenceProduct",
  );
}

export async function upsertReferenceVariant(
  client: ServiceClient,
  researchRunId: string,
  observedAt: string,
  input: ReferenceVariantInput,
) {
  return assertSuccess(
    await client.rpc("upsert_catalog_reference_variant_v1", {
      p_research_run_id: researchRunId,
      p_observed_at: observedAt,
      p_payload: input,
    }),
    "upsertReferenceVariant",
  );
}

export async function recordReferenceObservation(client: ServiceClient, input: ReferenceObservationInput) {
  const value = input.value;
  const related = value.relatedRef;
  const relatedColumns = related
    ? {
        related_product_id: related.kind === "product" ? related.id : null,
        related_variant_id: related.kind === "variant" ? related.id : null,
        related_reference_product_id: related.kind === "reference_product" ? related.id : null,
        related_reference_variant_id: related.kind === "reference_variant" ? related.id : null,
        related_system_id: related.kind === "system" ? related.id : null,
        related_stage_id: related.kind === "stage" ? related.id : null,
        related_class_id: related.kind === "class" ? related.id : null,
      }
    : {};

  return assertSuccess(
    await client
      .from("catalog_observations")
      .upsert(
        {
          observation_key: input.observationKey,
          source_record_id: input.sourceRecordId,
          research_run_id: input.researchRunId,
          ...subjectColumns(input.subject),
          observation_kind: input.kind,
          predicate: input.predicate,
          attribute_definition_id: input.attributeDefinitionId ?? null,
          option_id: value.optionId ?? null,
          value_text: value.text ?? null,
          value_number: value.number ?? null,
          value_boolean: value.boolean ?? null,
          value_date: value.date ?? null,
          value_json: value.json ?? null,
          ...relatedColumns,
          observed_unit: input.observedUnit ?? null,
          observed_at: input.observedAt,
          extraction_method: input.extractionMethod,
          extractor: input.extractor ?? null,
          confidence: input.confidence,
          metadata: input.metadata ?? {},
        },
        { onConflict: "observation_key", ignoreDuplicates: true },
      )
      .select("id, observation_key, target_ref")
      .maybeSingle(),
    "recordReferenceObservation",
  );
}

export async function recordExternalPrice(client: ServiceClient, input: ExternalPriceInput) {
  return assertSuccess(
    await client
      .from("catalog_reference_prices")
      .upsert(
        {
          price_key: input.priceKey,
          research_run_id: input.researchRunId,
          ...subjectColumns(input.subject),
          source_id: input.sourceId,
          source_record_id: input.sourceRecordId ?? null,
          currency: input.currency,
          amount: input.amount,
          presentation: input.presentation ?? null,
          external_availability: input.availability ?? null,
          observed_at: input.observedAt,
          content_fingerprint: input.contentFingerprint,
          metadata: input.metadata ?? {},
        },
        { onConflict: "price_key", ignoreDuplicates: true },
      )
      .select("id, price_key, target_ref")
      .maybeSingle(),
    "recordExternalPrice",
  );
}

export async function upsertReferenceIdentifier(client: ServiceClient, input: ReferenceIdentifierInput) {
  return assertSuccess(
    await client.rpc("upsert_catalog_reference_identifier_v1", { p_payload: input }),
    "upsertReferenceIdentifier",
  );
}

export async function recordReferencePresence(client: ServiceClient, input: ReferencePresenceInput) {
  const subject = "subject" in input ? subjectColumns(input.subject) : {};
  return assertSuccess(
    await client
      .from("catalog_reference_presence_events")
      .upsert(
        {
          research_run_source_id: input.researchRunSourceId,
          ...subject,
          delta_status: input.delta,
          previous_fingerprint: input.previousFingerprint ?? null,
          current_fingerprint: input.currentFingerprint ?? null,
          observed_at: input.observedAt,
          metadata: input.metadata ?? {},
        },
        { onConflict: "research_run_source_id,target_ref", ignoreDuplicates: true },
      )
      .select("id, target_ref, delta_status")
      .maybeSingle(),
    "recordReferencePresence",
  );
}

export async function finalizeResearchSource(
  client: ServiceClient,
  input: {
    researchRunSourceId: string;
    status: "succeeded" | "partial" | "failed" | "cancelled";
    resultFingerprint?: string | null;
    metrics?: Record<string, unknown>;
    errors?: unknown[];
  },
) {
  return assertSuccess(
    await client.rpc("finalize_catalog_research_source_v1", {
      p_research_run_source_id: input.researchRunSourceId,
      p_status: input.status,
      p_result_fingerprint: input.resultFingerprint ?? null,
      p_metrics: input.metrics ?? {},
      p_errors: input.errors ?? [],
    }),
    "finalizeResearchSource",
  );
}

export async function finalizeResearchRun(
  client: ServiceClient,
  input: {
    researchRunId: string;
    status: "succeeded" | "partial" | "failed" | "cancelled";
    resultFingerprint: string;
    result?: Record<string, unknown>;
    errors?: unknown[];
  },
) {
  return assertSuccess(
    await client.rpc("finalize_catalog_research_run_v1", {
      p_research_run_id: input.researchRunId,
      p_status: input.status,
      p_result_fingerprint: input.resultFingerprint,
      p_result: input.result ?? {},
      p_errors: input.errors ?? [],
    }),
    "finalizeResearchRun",
  );
}

export async function findReferenceCandidates(client: ServiceClient, input: ReferenceCandidateQuery) {
  return assertSuccess(
    await client.rpc("get_catalog_reference_candidates_v1", {
      p_brand_id: input.brandId,
      p_source_id: input.sourceId,
      p_identifier_kind: input.identifierKind ?? null,
      p_identifier_value: input.identifierValue ?? null,
      p_normalized_name: input.normalizedName ?? null,
      p_limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
    }),
    "findReferenceCandidates",
  );
}

export async function resolveImportRowAgainstReference(
  client: ServiceClient,
  importRowId: string,
  limit = 10,
) {
  return assertSuccess(
    await client.rpc("resolve_catalog_import_reference_v1", {
      p_import_row_id: importRowId,
      p_limit: Math.max(1, Math.min(limit, 100)),
    }),
    "resolveImportRowAgainstReference",
  );
}

export async function getImportReferenceMetrics(client: ServiceClient, batchId: string) {
  return assertSuccess(
    await client.rpc("get_catalog_import_reference_metrics_v1", { p_batch_id: batchId }),
    "getImportReferenceMetrics",
  );
}

export async function getReferenceKnowledge(client: ServiceClient, referenceKey: string) {
  return assertSuccess(
    await client.rpc("get_catalog_reference_knowledge_v1", { p_reference_key: referenceKey }),
    "getReferenceKnowledge",
  );
}
