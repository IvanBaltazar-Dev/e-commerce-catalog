import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "test-stage2-admiss-acceptance",
});
if (!isLocal) throw new Error("La aceptación de Etapa 2 solo corre contra PostgreSQL local.");
const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rows(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function scalar(sql, params = []) {
  const result = await rows(sql, params);
  return result[0]?.value;
}

try {
  const source = (await rows(`
    select source.id, source.brand_id, source.source_key, source.base_url
    from public.catalog_sources source
    where source.source_key = 'admiss-co-official'
  `))[0];
  assert(source?.brand_id, "La fuente oficial ADMISS no está vinculada a una marca.");

  const report = await scalar(
    "select public.get_catalog_brand_intelligence_report_v1($1::uuid) as value",
    [source.brand_id],
  );
  assert(report.currentCatalog.products === 11 && report.currentCatalog.variants === 85,
    `Catálogo ADMISS inesperado: ${JSON.stringify(report.currentCatalog)}`);
  assert(report.referenceUniverse.products === 121 && report.referenceUniverse.variants === 121,
    `Universo ADMISS inesperado: ${JSON.stringify(report.referenceUniverse)}`);
  assert(report.referenceUniverse.externalPrices === 121 && report.referenceUniverse.remoteMedia === 197,
    "Precios externos o referencias remotas incompletos.");
  assert(report.reconciliation.candidates === 112 && report.reconciliation.contradictions === 1,
    `Señales ADMISS inesperadas: ${JSON.stringify(report.reconciliation)}`);
  assert(report.reconciliation.unmatchedReferences === 8,
    `Referencias sin correspondencia inesperadas: ${report.reconciliation.unmatchedReferences}`);
  assert(report.delta.unchanged === 242 && report.delta.changed === 0 && report.delta.firstSeen === 0,
    `El último delta no es idempotente: ${JSON.stringify(report.delta)}`);
  assert(report.lastResearchRun.result?.commercialGuard?.unchanged === true,
    "La última corrida no conservó la prueba persistida de no contaminación comercial.");

  const latestScopes = await rows(`
    select scope.id, scope.research_run_id, scope.result_fingerprint, scope.source_state,
           run.run_kind, run.status, run.result,
           snapshot.snapshot_id
    from public.catalog_research_run_sources scope
    join public.catalog_research_runs run on run.id = scope.research_run_id
    join public.catalog_research_run_snapshots snapshot on snapshot.research_run_source_id = scope.id
    where scope.source_id = $1 and scope.scope_key = 'official-catalog'
      and scope.status = 'succeeded'
    order by scope.finished_at desc
    limit 2
  `, [source.id]);
  assert(latestScopes.length === 2, "Faltan baseline/delta exitosos para ADMISS.");
  assert(latestScopes[0].result_fingerprint === latestScopes[1].result_fingerprint,
    "Las dos últimas corridas no comparten fingerprint material.");
  assert(latestScopes[0].snapshot_id === latestScopes[1].snapshot_id,
    "La repetición sin cambios no reutilizó el snapshot.");
  assert(latestScopes[0].source_state === "unchanged", "La última fuente no quedó unchanged.");

  const duplicateChecks = await rows(`
    select 'reference_product_external_id' as check_name, count(*)::int as duplicates
    from (
      select primary_source_id, primary_external_id from public.catalog_reference_products
      where primary_source_id = $1 group by primary_source_id, primary_external_id having count(*) > 1
    ) duplicate
    union all
    select 'reference_variant_external_id', count(*)::int from (
      select primary_source_id, primary_external_id from public.catalog_reference_variants
      where primary_source_id = $1 group by primary_source_id, primary_external_id having count(*) > 1
    ) duplicate
    union all
    select 'material_observation', count(*)::int from (
      select observation.target_ref, observation.predicate,
             observation.value_text, observation.value_number, observation.value_boolean,
             observation.value_date, observation.value_json, count(*)
      from public.catalog_observations observation
      join public.catalog_source_records record on record.id = observation.source_record_id
      where record.source_id = $1
      group by observation.target_ref, observation.predicate,
               observation.value_text, observation.value_number, observation.value_boolean,
               observation.value_date, observation.value_json
      having count(*) > 1
    ) duplicate
    union all
    select 'material_external_price', count(*)::int from (
      select price.target_ref, price.source_id, price.currency, price.amount,
             price.external_availability, price.content_fingerprint, count(*)
      from public.catalog_reference_prices price where price.source_id = $1
      group by price.target_ref, price.source_id, price.currency, price.amount,
               price.external_availability, price.content_fingerprint
      having count(*) > 1
    ) duplicate
    union all
    select 'remote_media', count(*)::int from (
      select media.target_ref, media.remote_url, count(*)
      from public.catalog_reference_media media where media.source_id = $1
      group by media.target_ref, media.remote_url having count(*) > 1
    ) duplicate
    union all
    select 'active_identity_case', count(*)::int from (
      select reconciliation.case_key, count(*)
      from public.catalog_reconciliation_cases reconciliation
      where reconciliation.algorithm = 'official_identity_v1'
        and reconciliation.status in ('proposed', 'needs_review', 'approved')
      group by reconciliation.case_key having count(*) > 1
    ) duplicate
    union all
    select 'active_review_case', count(*)::int from (
      select item.source_type, item.source_id, count(*)
      from public.catalog_review_work_items item
      where item.group_key = 'brand:' || $2::text and item.status in ('open', 'in_progress')
      group by item.source_type, item.source_id having count(*) > 1
    ) duplicate
    union all
    select 'graph_node_key', count(*)::int from (
      select node.node_key, count(*) from public.graph_nodes_v2 node
      group by node.node_key having count(*) > 1
    ) duplicate
    union all
    select 'graph_edge_key', count(*)::int from (
      select edge.edge_key, count(*) from public.graph_edges_v2 edge
      group by edge.edge_key having count(*) > 1
    ) duplicate
  `, [source.id, source.brand_id]);
  assert(duplicateChecks.every((check) => check.duplicates === 0),
    `Duplicados materiales: ${JSON.stringify(duplicateChecks.filter((check) => check.duplicates))}`);

  const zac = (await rows(`
    select variant.sku, variant.name, product.name as official_name,
           product.source_url, product.primary_image_url,
           reconciliation.status, reconciliation.score,
           internal_product.code as internal_code,
           internal_product.name as internal_name
    from public.catalog_reference_variants variant
    join public.catalog_reference_products product on product.id = variant.reference_product_id
    left join public.catalog_reconciliation_cases reconciliation
      on reconciliation.reference_product_id = product.id
     and reconciliation.algorithm = 'official_identity_v1'
     and reconciliation.status in ('proposed', 'needs_review', 'approved')
    left join public.products internal_product on internal_product.id = reconciliation.product_id
    where product.primary_source_id = $1 and variant.sku = '314094'
  `, [source.id]))[0];
  assert(zac?.name === "ZAC" && zac.internal_code === "ADM-ESM-CA6EEA" && zac.status === "proposed",
    `Aceptación ZAC falló: ${JSON.stringify(zac)}`);
  const commercialZac = Number(await scalar(`
    select count(*)::int as value
    from public.products product
    left join public.product_variants variant on variant.product_id = product.id
    where product.code = '314094' or variant.sku = '314094'
  `));
  assert(commercialZac === 0, "ZAC SKU 314094 creó un artículo comercial automáticamente.");

  const ajo = (await rows(`
    select reference_variant.sku, reference_product.name as official_name,
           reconciliation.status, reconciliation.evidence,
           internal_variant.name as internal_variant,
           internal_product.code as internal_product_code,
           category.name as internal_category
    from public.catalog_reconciliation_cases reconciliation
    join public.catalog_reference_variants reference_variant on reference_variant.id = reconciliation.reference_variant_id
    join public.catalog_reference_products reference_product on reference_product.id = reference_variant.reference_product_id
    join public.product_variants internal_variant on internal_variant.id = reconciliation.variant_id
    join public.products internal_product on internal_product.id = internal_variant.product_id
    join public.categories category on category.id = internal_product.category_id
    where reconciliation.algorithm = 'official_identity_v1'
      and reconciliation.status = 'needs_review'
      and reference_variant.sku = '310010'
  `))[0];
  assert(ajo?.internal_variant === "Ajo y Limon"
    && ajo.internal_product_code === "ADM-ESM-CA6EEA"
    && ajo.evidence?.classificationContradiction === true
    && normalize(ajo.internal_category) === "esmaltes"
    && ajo.evidence?.officialProductType === "bases",
  `Aceptación AJO Y LIMON falló: ${JSON.stringify(ajo)}`);

  const graphLayers = await rows(`
    select node_type, layer, count(*)::int as total
    from public.graph_nodes_v2
    where node_type in ('ReferenceProduct', 'ReferenceVariant', 'IdentityCandidate', 'IdentityMatch', 'IdentityContradiction')
    group by node_type, layer order by node_type, layer
  `);
  assert(!graphLayers.some((item) => item.node_type.startsWith("Identity") && item.layer === "canonical"),
    `Señales de identidad mezcladas con hechos canónicos: ${JSON.stringify(graphLayers)}`);
  assert(graphLayers.some((item) => item.node_type === "IdentityCandidate" && item.layer === "candidate"),
    "El grafo no distingue candidatas de identidad.");
  assert(graphLayers.some((item) => item.node_type === "IdentityContradiction" && item.layer === "evidence"),
    "El grafo no distingue contradicciones.");

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    source: { sourceKey: source.source_key, baseUrl: source.base_url },
    catalog: report.currentCatalog,
    referenceUniverse: report.referenceUniverse,
    reconciliation: {
      candidates: report.reconciliation.candidates,
      contradictions: report.reconciliation.contradictions,
      unmatchedReferences: report.reconciliation.unmatchedReferences,
      pendingReview: report.reconciliation.pendingReview,
    },
    delta: report.delta,
    duplicateChecks,
    commercialGuard: report.lastResearchRun.result.commercialGuard,
    acceptance: { zac, ajo },
    graphLayers,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

