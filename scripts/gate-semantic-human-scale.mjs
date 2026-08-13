/**
 * Gate estructural de escala humana semantica.
 *
 * Duplica miles de detecciones de una misma regla y exige que la Mesa conserve
 * exactamente una excepcion activa de regla. Todo ocurre en una transaccion
 * que se revierte al finalizar.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate:semantic-human-scale",
  allowedFlags: ["--problems"],
});
if (!isLocal) throw new Error("El gate de escala humana solo se ejecuta contra Supabase local.");

const PROBLEMS_PER_WAVE = Number(
  (process.argv.find((argument) => argument.startsWith("--problems=")) ?? "--problems=5000").split("=")[1],
);
if (!Number.isInteger(PROBLEMS_PER_WAVE) || PROBLEMS_PER_WAVE < 1_000) {
  throw new Error("El gate exige al menos 1.000 problemas por ola.");
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const runId = randomUUID();
const baselineRunId = randomUUID();
const runKey = `semantic-human-scale-${runId}`;
const started = performance.now();
let report;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function addWave(from, to) {
  await client.query(`
    with registered as (
      select public.register_catalog_semantic_problem_v1(
        $1::uuid,
        'scale-shared-rule-' || series.n::text,
        product.id,
        'inferred_uncertain',
        'shared_normalization_failure',
        'shared_unit_parser',
        'normalize_shared_unit_v1',
        'synthetic_equipment',
        'voltage',
        null,
        false,
        false
      ) as problem
      from generate_series($2::integer, $3::integer) series(n)
      join public.catalog_reference_products product
        on product.reference_key = 'semantic-human-scale:' || $1::text || ':' || series.n::text
    )
    select count(*) from registered
  `, [runId, from, to]);
}

async function addSyntheticProducts(targetRunId, keyPrefix, count, sourceFixture, seenAt) {
  await client.query(`
    insert into public.catalog_reference_products(
      reference_key, brand_id, primary_source_id, primary_source_record_id,
      primary_external_id, name, normalized_name, family, product_type,
      source_url, identity_fingerprint, content_fingerprint,
      first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
    )
    select
      $2::text || ':' || $1::text || ':' || series.n::text,
      $3::uuid, $4::uuid, $5::uuid,
      $2::text || '-' || $1::text || '-' || series.n::text,
      'Synthetic scale product ' || series.n::text,
      'synthetic scale product ' || series.n::text,
      'Synthetic equipment', 'Electrical equipment',
      'https://semantic-scale.invalid/products/' || series.n::text,
      $2::text || '-identity-' || $1::text || '-' || series.n::text,
      $2::text || '-content-' || $1::text || '-' || series.n::text,
      $1::uuid, $1::uuid, $7::timestamptz, $7::timestamptz
    from generate_series(1, $6::integer) series(n)
  `, [
    targetRunId,
    keyPrefix,
    sourceFixture.brand_id,
    sourceFixture.source_id,
    sourceFixture.source_record_id,
    count,
    seenAt,
  ]);
}

try {
  await client.query("begin");
  const transactionTimestamp = (await client.query("select now() as value")).rows[0].value;
  await client.query(`
    insert into public.catalog_research_runs(
      id, run_key, run_kind, actor_kind, actor_label, status,
      input_fingerprint, scope, metrics, errors, result
    ) values ($1, $2, 'targeted', 'system', 'semantic human scale gate', 'running',
      $3, '{"synthetic":true}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)
  `, [runId, runKey, `input-${runId}`]);

  const sourceFixture = (await client.query(`
    select source.id as source_id, source.brand_id, record.id as source_record_id
    from public.catalog_sources source
    join public.catalog_source_records record on record.source_id = source.id
    where record.entity_type = 'product'
    order by source.id, record.id
    limit 1
  `)).rows[0];
  assert(sourceFixture, "El gate necesita una fuente y registro estructural sembrados.");

  const baselineStartedAt = new Date(Date.now() - 120_000);
  const baselineFinishedAt = new Date(Date.now() - 60_000);
  await client.query(`
    insert into public.catalog_research_runs(
      id, run_key, run_kind, actor_kind, actor_label, status,
      started_at, finished_at, input_fingerprint, result_fingerprint,
      scope, metrics, errors, result
    ) values ($1, $2, 'targeted', 'system', 'semantic human scale baseline', 'succeeded',
      $3, $4, $5, $6, '{"synthetic":true,"baseline":true}'::jsonb,
      '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)
  `, [
    baselineRunId,
    `semantic-human-scale-baseline-${baselineRunId}`,
    baselineStartedAt,
    baselineFinishedAt,
    `baseline-input-${baselineRunId}`,
    `baseline-result-${baselineRunId}`,
  ]);
  await addSyntheticProducts(
    baselineRunId,
    "semantic-human-baseline",
    100,
    sourceFixture,
    new Date(Date.now() - 90_000),
  );
  await client.query(`
    with registered as (
      select public.register_catalog_semantic_problem_v1(
        $1::uuid, 'baseline-shared-rule-' || series.n::text, product.id,
        'inferred_uncertain', 'shared_normalization_failure', 'baseline_unit_parser',
        'normalize_baseline_unit_v1', 'synthetic_equipment', 'voltage',
        null, false, false
      )
      from generate_series(1, 100) series(n)
      join public.catalog_reference_products product
        on product.reference_key = 'semantic-human-baseline:' || $1::text || ':' || series.n::text
    ) select count(*) from registered
  `, [baselineRunId]);
  await client.query(`
    select public.register_catalog_semantic_problem_v1(
      $1::uuid, 'baseline-blocker',
      (select id from public.catalog_reference_products
       where reference_key = 'semantic-human-baseline:' || $1::text || ':1'),
      'contradicted', 'baseline_blocking_ambiguity', 'baseline_unit_parser',
      'normalize_baseline_unit_v1', 'synthetic_equipment', 'voltage',
      null, true, true
    )
  `, [baselineRunId]);
  const baselineGroupId = (await client.query(
    "select id from public.catalog_semantic_problem_groups where research_run_id = $1",
    [baselineRunId],
  )).rows[0].id;
  await client.query(`
    select public.escalate_catalog_semantic_problem_group_v1(
      $1, 'Which baseline rule resolves this shared ambiguity?',
      'Resolve the baseline rule once.', 'normal', 'normal'
    )
  `, [baselineGroupId]);

  await addSyntheticProducts(
    runId,
    "semantic-human-scale",
    PROBLEMS_PER_WAVE * 2,
    sourceFixture,
    transactionTimestamp,
  );

  await addWave(1, PROBLEMS_PER_WAVE);
  const beforeEscalation = (await client.query(`
    select
      (select count(*)::integer from public.catalog_semantic_problems where research_run_id = $1) as problems,
      (select count(*)::integer from public.catalog_semantic_problem_groups where research_run_id = $1) as groups,
      (select count(*)::integer from public.catalog_review_work_items work
       join public.catalog_semantic_problem_groups problem_group on problem_group.id = work.source_id
       where problem_group.research_run_id = $1 and work.context->>'semanticOrigin' = 'problem_group') as human_work
  `, [runId])).rows[0];
  assert(beforeEscalation.problems === PROBLEMS_PER_WAVE, "La primera ola no persistio todos los problemas.");
  assert(beforeEscalation.groups === 1, "Una regla compartida produjo mas de un grupo.");
  assert(beforeEscalation.human_work === 0, "La incertidumbre no bloqueante creo trabajo humano.");

  await client.query(`
    select public.register_catalog_semantic_problem_v1(
      $1::uuid, 'scale-blocking-ambiguity',
      (select id from public.catalog_reference_products
       where reference_key = 'semantic-human-scale:' || ($1::uuid)::text || ':1'),
      'contradicted', 'shared_rule_blocks_canonical_decision', 'shared_unit_parser',
      'normalize_shared_unit_v1', 'synthetic_equipment', 'voltage',
      null, true, true
    )
  `, [runId]);
  const groupId = (await client.query(
    "select id from public.catalog_semantic_problem_groups where research_run_id = $1",
    [runId],
  )).rows[0].id;
  await client.query(`
    select public.escalate_catalog_semantic_problem_group_v1(
      $1, 'Which rule resolves this shared blocking ambiguity?',
      'Resolve the rule once and reprocess the complete affected set.', 'high', 'high'
    )
  `, [groupId]);

  await addWave(PROBLEMS_PER_WAVE + 1, PROBLEMS_PER_WAVE * 2);
  await client.query(`
    select public.escalate_catalog_semantic_problem_group_v1(
      $1, 'Which rule resolves this shared blocking ambiguity?',
      'Resolve the rule once and reprocess the complete affected set.', 'high', 'high'
    )
  `, [groupId]);

  const measured = (await client.query(`
    select
      funnel.products_investigated,
      funnel.problems_detected,
      funnel.problems_grouped,
      funnel.rules_affected,
      funnel.human_exceptions,
      funnel.human_exceptions_per_1000_products,
      funnel.individual_review_avoidance_ratio,
      (select count(*)::integer from public.catalog_review_work_items work
       where work.source_id = $2 and work.status in ('open', 'in_progress')) as active_human_work,
      (select count(*)::integer from public.catalog_review_work_items work
       where work.source_id = $2) as versioned_human_work,
      (select count(*)::integer from public.catalog_review_work_items work
       where work.source_id = $2 and work.subject_type = 'product') as product_level_work
    from public.catalog_semantic_campaign_funnel_v1 funnel
    where funnel.research_run_id = $1
  `, [runId, groupId])).rows[0];

  const expectedProblems = PROBLEMS_PER_WAVE * 2 + 1;
  assert(Number(measured.problems_detected) === expectedProblems, "El embudo perdio problemas detectados.");
  assert(Number(measured.products_investigated) === PROBLEMS_PER_WAVE * 2, "El embudo perdio productos investigados.");
  assert(Number(measured.problems_grouped) === 1, "La segunda ola fragmento la regla compartida.");
  assert(Number(measured.rules_affected) === 1, "El gate esperaba una sola regla afectada.");
  assert(Number(measured.human_exceptions) === 1, "La excepcion humana crecio con los problemas.");
  assert(measured.active_human_work === 1, "Debe existir exactamente una excepcion humana activa.");
  assert(measured.versioned_human_work === 2, "El cambio del conjunto debe versionar, no mutar, el trabajo.");
  assert(measured.product_level_work === 0, "La Mesa recibio trabajo individual por producto.");
  assert(Number(measured.human_exceptions_per_1000_products)
      <= 1000 / (PROBLEMS_PER_WAVE * 2),
    "La densidad humana crecio por encima de una excepcion para todo el conjunto compartido.");
  assert(Number(measured.individual_review_avoidance_ratio) > 0.999, "La evitacion de revision individual es insuficiente.");

  const campaignReport = (await client.query(
    "select public.get_catalog_semantic_campaign_report_v1($1::uuid) as report",
    [runId],
  )).rows[0].report;
  assert(Number(campaignReport.humanScale.referenceUniverseSize) >= PROBLEMS_PER_WAVE * 2,
    "El indicador longitudinal no incorporo el universo investigado de la campana activa.");
  assert(campaignReport.humanScale.indicator === "passes",
    "Las excepciones humanas no crecieron de forma sublineal frente al universo.");

  report = {
    passed: true,
    problemsPerWave: PROBLEMS_PER_WAVE,
    problemsDetected: expectedProblems,
    productsAffected: Number(measured.products_investigated),
    problemGroups: Number(measured.problems_grouped),
    rulesAffected: Number(measured.rules_affected),
    activeHumanExceptions: measured.active_human_work,
    versionedHumanExceptions: measured.versioned_human_work,
    productLevelWork: measured.product_level_work,
    humanExceptionsPer1000Products: Number(measured.human_exceptions_per_1000_products),
    referenceUniverseSize: Number(campaignReport.humanScale.referenceUniverseSize),
    exceptionToUniverseGrowthRatio: Number(campaignReport.humanScale.exceptionToUniverseGrowthRatio),
    sublinearGrowthIndicator: campaignReport.humanScale.indicator,
    individualReviewAvoidanceRatio: Number(measured.individual_review_avoidance_ratio),
    elapsedMs: Math.round(performance.now() - started),
  };
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}

mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
writeFileSync(
  path.join(ROOT, "test-results", "semantic-human-scale.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
