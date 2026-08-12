/**
 * Gate de escala del Universo de Referencia.
 *
 * Se ejecuta después de `gate:busqueda -- --keep`: exige al menos 100.000
 * productos comerciales y agrega 150.000 identidades externas, variantes,
 * observaciones y deltas. Mide índices reales y recorre el contrato completo
 * del grafo con cursor de PostgreSQL y memoria acotada.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import QueryStream from "pg-query-stream";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate:reference-scale",
  allowedFlags: ["--referencias"],
});
if (!isLocal) throw new Error("El gate de escala solo puede ejecutarse contra Supabase local.");
const REFERENCES = Number(
  (process.argv.find((argument) => argument.startsWith("--referencias=")) ?? "--referencias=150000").split("=")[1],
);
if (REFERENCES < 100_000) throw new Error("El gate exige al menos 100.000 referencias externas.");
const CONTAINER = "supabase_db_e-commerce-catalog";
const PREFIX = "VOLR-";

function psql(sql, timeoutMs = 900_000) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"],
    {
      input: sql,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    },
  );
  if (result.status !== 0) throw new Error(`psql: ${(result.stderr || result.stdout || "").slice(-4000)}`);
  return result.stdout.trim();
}

function cleanup() {
  psql(`
    begin;
    set local session_replication_role = replica;
    create temporary table volr_products on commit drop as
      select id from public.catalog_reference_products where reference_key like '${PREFIX}%';
    create index on volr_products(id);
    create temporary table volr_variants on commit drop as
      select id from public.catalog_reference_variants
      where reference_product_id in (select id from volr_products);
    create index on volr_variants(id);
    delete from public.catalog_evidence_items where observation_id in (
      select id from public.catalog_observations
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants));
    delete from public.catalog_provenance_observations where observation_id in (
      select id from public.catalog_observations
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants));
    delete from public.catalog_attribute_provenance
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_observations
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_reference_prices
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_reference_media
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_reconciliation_cases
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_reference_identifiers
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants);
    delete from public.catalog_reference_presence_events
      where reference_product_id in (select id from volr_products)
         or reference_variant_id in (select id from volr_variants)
         or research_run_source_id in (
           select id from public.catalog_research_run_sources
           where research_run_id in (select id from public.catalog_research_runs where run_key like '${PREFIX}%'));
    delete from public.catalog_reference_variants where id in (select id from volr_variants);
    delete from public.catalog_reference_products where id in (select id from volr_products);
    delete from public.catalog_source_records where source_id in (
      select id from public.catalog_sources where source_key = 'stage1-volume-reference');
    delete from public.catalog_research_run_snapshots where research_run_source_id in (
      select id from public.catalog_research_run_sources
      where research_run_id in (select id from public.catalog_research_runs where run_key like '${PREFIX}%'));
    delete from public.catalog_source_snapshots where source_id in (
      select id from public.catalog_sources where source_key = 'stage1-volume-reference');
    delete from public.catalog_research_run_brands where research_run_id in (
      select id from public.catalog_research_runs where run_key like '${PREFIX}%');
    delete from public.catalog_research_run_sources where research_run_id in (
      select id from public.catalog_research_runs where run_key like '${PREFIX}%');
    delete from public.catalog_research_runs where run_key like '${PREFIX}%';
    delete from public.catalog_sources where source_key = 'stage1-volume-reference';
    set local session_replication_role = default;
    commit;
    analyze public.catalog_reference_products;
    analyze public.catalog_reference_variants;
    analyze public.catalog_reference_identifiers;
    analyze public.catalog_reference_presence_events;
    analyze public.catalog_observations;
  `);
}

function seed() {
  cleanup();
  console.log(`Sembrando ${REFERENCES.toLocaleString("es-PE")} referencias externas adicionales…`);
  psql(`
    begin;
    set local session_replication_role = replica;

    insert into public.catalog_sources(
      id, source_key, name, authority, adapter, base_url, brand_id
    ) select
      '12000000-0000-4000-8000-000000000001', 'stage1-volume-reference',
      'Volumen sintético de referencia', 'official', 'manual_capture',
      'https://volume.stage1.invalid', id
    from public.brands order by name limit 1;

    insert into public.catalog_research_runs(
      id, run_key, run_kind, actor_kind, actor_label, status, started_at,
      finished_at, input_fingerprint, result_fingerprint, scope, metrics, result
    ) values (
      '12000000-0000-4000-8000-000000000010', '${PREFIX}BASELINE', 'baseline',
      'system', 'gate de escala', 'succeeded', now(), now(), 'volr-input', 'volr-result',
      '{"synthetic":true,"references":${REFERENCES}}'::jsonb,
      '{"references":${REFERENCES}}'::jsonb, '{"gate":"stage1"}'::jsonb
    );

    insert into public.catalog_research_run_sources(
      id, research_run_id, source_id, brand_id, scope_key, status, source_state,
      input_fingerprint, result_fingerprint, scope, metrics, started_at, finished_at
    ) select
      '12000000-0000-4000-8000-000000000011',
      '12000000-0000-4000-8000-000000000010', source.id, source.brand_id,
      'all-products', 'succeeded', 'first_seen', 'volr-scope-input', 'volr-scope-result',
      '{"synthetic":true}'::jsonb, '{"references":${REFERENCES}}'::jsonb, now(), now()
    from public.catalog_sources source where source.id = '12000000-0000-4000-8000-000000000001';

    insert into public.catalog_source_snapshots(
      id, source_id, status, started_at, completed_at, content_hash,
      product_count, variant_count
    ) values (
      '12000000-0000-4000-8000-000000000020',
      '12000000-0000-4000-8000-000000000001', 'succeeded', now(), now(),
      'volr-snapshot', ${REFERENCES}, ${REFERENCES}
    );

    insert into public.catalog_source_records(
      id, snapshot_id, source_id, entity_type, external_id, title,
      normalized_name, sku, source_url, captured_at
    )
    select
      gen_random_uuid(), '12000000-0000-4000-8000-000000000020',
      '12000000-0000-4000-8000-000000000001', 'product',
      'volr-product-' || lpad(n::text, 6, '0'),
      'Producto referencia volumen ' || lpad(n::text, 6, '0'),
      'producto referencia volumen ' || lpad(n::text, 6, '0'),
      '${PREFIX}' || lpad(n::text, 6, '0'),
      'https://volume.stage1.invalid/products/' || n, now()
    from generate_series(1, ${REFERENCES}) n;

    insert into public.catalog_reference_products(
      id, reference_key, brand_id, primary_source_id, primary_source_record_id,
      primary_external_id, name, normalized_name, family, product_type,
      presentation, source_url, identity_fingerprint, content_fingerprint,
      enrichment_level, knowledge_status, presence_status,
      first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
    )
    select
      gen_random_uuid(), '${PREFIX}' || lpad(n::text, 6, '0'), source.brand_id,
      source.id, record.id, record.external_id, record.title, record.normalized_name,
      'Sintético', 'Referencia de volumen', '10 ml', record.source_url,
      md5('identity-' || n), md5('content-' || n), 'REFERENCE_LIGHT',
      'discovered', 'present',
      '12000000-0000-4000-8000-000000000010',
      '12000000-0000-4000-8000-000000000010', now(), now()
    from generate_series(1, ${REFERENCES}) n
    join public.catalog_source_records record
      on record.external_id = 'volr-product-' || lpad(n::text, 6, '0')
     and record.source_id = '12000000-0000-4000-8000-000000000001'
    join public.catalog_sources source on source.id = record.source_id;

    insert into public.catalog_reference_variants(
      id, reference_product_id, reference_key, primary_source_id,
      primary_source_record_id, primary_external_id, name, normalized_name,
      sku, shade_name, presentation, source_url, identity_fingerprint,
      content_fingerprint, enrichment_level, knowledge_status, presence_status,
      first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at
    )
    select
      gen_random_uuid(), product.id, '${PREFIX}V-' || lpad(n::text, 6, '0'),
      product.primary_source_id, product.primary_source_record_id,
      'volr-variant-' || lpad(n::text, 6, '0'),
      'Variante volumen ' || lpad(n::text, 6, '0'),
      'variante volumen ' || lpad(n::text, 6, '0'),
      '${PREFIX}SKU-' || lpad(n::text, 6, '0'),
      (array['Rojo','Rosa','Azul','Natural'])[1 + (n % 4)], '10 ml',
      product.source_url || '/variant', md5('variant-identity-' || n),
      md5('variant-content-' || n), 'REFERENCE_LIGHT', 'observed', 'present',
      '12000000-0000-4000-8000-000000000010',
      '12000000-0000-4000-8000-000000000010', now(), now()
    from generate_series(1, ${REFERENCES}) n
    join public.catalog_reference_products product
      on product.reference_key = '${PREFIX}' || lpad(n::text, 6, '0');

    insert into public.catalog_reference_identifiers(
      reference_product_id, source_id, source_record_id, identifier_kind,
      observed_value, normalized_value, first_seen_run_id, last_seen_run_id,
      first_seen_at, last_seen_at
    )
    select
      product.id, product.primary_source_id, product.primary_source_record_id,
      'sku', '${PREFIX}' || lpad(n::text, 6, '0'),
      lower('${PREFIX}' || lpad(n::text, 6, '0')),
      '12000000-0000-4000-8000-000000000010',
      '12000000-0000-4000-8000-000000000010', now(), now()
    from generate_series(1, ${REFERENCES}) n
    join public.catalog_reference_products product
      on product.reference_key = '${PREFIX}' || lpad(n::text, 6, '0');

    insert into public.catalog_reference_presence_events(
      research_run_source_id, reference_product_id, delta_status,
      current_fingerprint, observed_at
    )
    select
      '12000000-0000-4000-8000-000000000011', product.id, 'first_seen',
      product.content_fingerprint, now()
    from public.catalog_reference_products product
    where product.reference_key like '${PREFIX}%';

    insert into public.catalog_observations(
      observation_key, source_record_id, research_run_id, reference_variant_id,
      observation_kind, predicate, value_text, observed_at,
      extraction_method, confidence
    )
    select
      'volr-observation-' || lpad(n::text, 6, '0'),
      variant.primary_source_record_id,
      '12000000-0000-4000-8000-000000000010', variant.id,
      'shade', 'shade_name', variant.shade_name, now(), 'official_api', 0.95
    from generate_series(1, ${REFERENCES}) n
    join public.catalog_reference_variants variant
      on variant.reference_key = '${PREFIX}V-' || lpad(n::text, 6, '0');

    set local session_replication_role = default;
    commit;

    analyze public.catalog_source_records;
    analyze public.catalog_reference_products;
    analyze public.catalog_reference_variants;
    analyze public.catalog_reference_identifiers;
    analyze public.catalog_reference_presence_events;
    analyze public.catalog_observations;
  `, 1_800_000);
}

function explain(name, sql, expectedIndex, thresholdMs) {
  const plan = psql(`explain (analyze, buffers) ${sql}`);
  const execution = Number(plan.match(/Execution Time: ([0-9.]+) ms/)?.[1] ?? Number.POSITIVE_INFINITY);
  const usesIndex = plan.includes(expectedIndex);
  const passed = usesIndex && execution <= thresholdMs;
  return { name, executionMs: execution, expectedIndex, usesIndex, thresholdMs, passed, plan };
}

async function scanProjection(pool) {
  const client = await pool.connect();
  const started = performance.now();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  let nodes = 0;
  let edges = 0;
  try {
    for (const [sql, kind] of [
      ["select node_key, projection_fingerprint from public.graph_nodes_v2 order by node_key", "nodes"],
      ["select edge_key, projection_fingerprint from public.graph_edges_v2 order by edge_key", "edges"],
    ]) {
      const stream = client.query(new QueryStream(sql, [], { batchSize: 1_000 }));
      for await (const row of stream) {
        if (kind === "nodes") nodes += 1;
        else edges += 1;
        if ((nodes + edges) % 10_000 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
        void row;
      }
    }
    return {
      nodes,
      edges,
      elapsedMs: Math.round(performance.now() - started),
      rssGrowthMb: Math.round(((peakRss - initialRss) / 1024 / 1024) * 10) / 10,
    };
  } finally {
    client.release();
  }
}

const commercialProducts = Number(psql("select count(*) from public.products where code like 'VOLQ-%';"));
if (commercialProducts < 100_000) {
  throw new Error(`Se esperaban 100.000 productos comerciales VOLQ; existen ${commercialProducts}. Ejecuta gate:busqueda con --keep primero.`);
}

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2 });
let report;
try {
  seed();
  const counts = JSON.parse(psql(`
    select json_build_object(
      'commercialProducts', (select count(*) from public.products where code like 'VOLQ-%'),
      'referenceProducts', (select count(*) from public.catalog_reference_products where reference_key like '${PREFIX}%'),
      'referenceVariants', (select count(*) from public.catalog_reference_variants where reference_key like '${PREFIX}%'),
      'observations', (select count(*) from public.catalog_observations where observation_key like 'volr-observation-%'),
      'presenceEvents', (select count(*) from public.catalog_reference_presence_events where research_run_source_id = '12000000-0000-4000-8000-000000000011')
    );
  `));
  const plans = [
    explain(
      "identificador exacto",
      `select target_ref from public.catalog_reference_identifiers
       where source_id = '12000000-0000-4000-8000-000000000001'
         and identifier_kind = 'sku' and normalized_value = 'volr-150000'`,
      "catalog_reference_identifiers_resolution_idx",
      100,
    ),
    explain(
      "similitud acotada por marca",
      `select id from public.catalog_reference_products
       where brand_id = (select brand_id from public.catalog_sources
                         where id = '12000000-0000-4000-8000-000000000001')
       order by normalized_name operator(public.<->) 'producto referencia volumen 150000' limit 20`,
      "catalog_reference_products_brand_name_knn_idx",
      500,
    ),
    explain(
      "observaciones por sujeto",
      `select observation_key from public.catalog_observations
       where reference_variant_id = (
         select id from public.catalog_reference_variants where reference_key = '${PREFIX}V-150000')
       order by observed_at desc`,
      "catalog_observations_reference_variant_idx",
      100,
    ),
    explain(
      "deltas por estado",
      `select id from public.catalog_reference_presence_events
       where delta_status = 'first_seen' order by observed_at desc limit 100`,
      "catalog_reference_presence_events_delta_idx",
      100,
    ),
  ];
  const projection = await scanProjection(pool);
  const sizes = JSON.parse(psql(`
    select json_object_agg(relname, pg_total_relation_size(oid))
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relname in (
        'catalog_reference_products', 'catalog_reference_variants',
        'catalog_reference_identifiers', 'catalog_reference_presence_events',
        'catalog_observations', 'catalog_source_records'
      );
  `));
  report = {
    referencesRequested: REFERENCES,
    counts,
    plans: plans.map((measurement) => ({
      name: measurement.name,
      executionMs: measurement.executionMs,
      expectedIndex: measurement.expectedIndex,
      usesIndex: measurement.usesIndex,
      thresholdMs: measurement.thresholdMs,
      passed: measurement.passed,
    })),
    projection,
    relationBytes: sizes,
    passed:
      Number(counts.commercialProducts) >= 100_000 &&
      Number(counts.referenceProducts) === REFERENCES &&
      Number(counts.referenceVariants) === REFERENCES &&
      Number(counts.observations) === REFERENCES &&
      Number(counts.presenceEvents) === REFERENCES &&
      plans.every((plan) => plan.passed) &&
      projection.rssGrowthMb < 256 &&
      projection.elapsedMs < 180_000,
  };
  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  writeFileSync(path.join(ROOT, "test-results", "reference-scale.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error("El gate de escala del Universo de Referencia no pasó.");
} finally {
  await pool.end();
  cleanup();
}
