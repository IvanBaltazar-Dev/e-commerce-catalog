import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "audit-admiss-taxonomy-semantics",
});
if (!isLocal) throw new Error("La auditoria ADMISS solo puede ejecutarse contra PostgreSQL local.");

const SOURCE_KEY = "admiss-co-official";
const DIMENSIONS = [
  "type", "subtype", "concern", "benefit", "ingredient", "use",
  "role", "stage", "system", "formulation", "finish", "relation",
];
const REPORT_DIR = path.join(ROOT, "research", "catalog-master", "reports", "admiss-semantic-audit");
const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rows(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rowsToWrite, columns) {
  return `\uFEFF${[columns, ...rowsToWrite.map((row) => columns.map((column) => row[column]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

function percent(count, total) {
  return Number(((100 * count) / total).toFixed(2));
}

function markdownTable(headers, tableRows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...tableRows.map((row) => `| ${row.map((cell) => String(cell ?? "").replaceAll("|", "\\|")).join(" | ")} |`),
  ].join("\n");
}

try {
  const source = (await rows(`
    select source.id, source.brand_id, source.source_key, source.base_url, brand.name as brand_name
    from public.catalog_sources source
    join public.brands brand on brand.id = source.brand_id
    where source.source_key = $1
  `, [SOURCE_KEY]))[0];
  assert(source, `No existe la fuente ${SOURCE_KEY}.`);

  const baselineDistribution = await rows(`
    select observation.predicate, observation.observation_kind,
           count(*)::int as observations,
           count(distinct observation.reference_product_id)::int as products,
           count(distinct observation.reference_variant_id)::int as variants
    from public.catalog_observations observation
    join public.catalog_source_records record on record.id = observation.source_record_id
    where record.source_id = $1
      and observation.observation_kind <> 'semantic_claim'
      and observation.observation_key like 'official-observation-v1:%'
    group by observation.predicate, observation.observation_kind
    order by observation.predicate, observation.observation_kind
  `, [source.id]);
  const baselineObservationCount = baselineDistribution.reduce((total, item) => total + item.observations, 0);
  assert(baselineObservationCount === 1134,
    `La auditoria basal esperaba 1.134 observaciones y encontro ${baselineObservationCount}.`);

  const products = await rows(`
    select reference.id, reference.reference_key, reference.primary_external_id,
           reference.name, reference.family as official_type, reference.presentation,
           reference.source_url, reference.primary_image_url,
           string_agg(distinct variant.sku, ' | ' order by variant.sku) filter (where variant.sku is not null) as sku,
           min(price.amount) as price_cop,
           bool_or(media.id is not null) as has_remote_media
    from public.catalog_reference_products reference
    left join public.catalog_reference_variants variant on variant.reference_product_id = reference.id
    left join public.catalog_reference_prices price on price.reference_variant_id = variant.id
    left join public.catalog_reference_media media on media.reference_product_id = reference.id
    where reference.primary_source_id = $1
    group by reference.id
    order by reference.name, reference.reference_key
  `, [source.id]);
  assert(products.length === 121, `La matriz esperaba 121 productos y encontro ${products.length}.`);

  const semanticRows = await rows(`
    select semantics.reference_product_id, semantics.reference_key, semantics.product_name,
           semantics.dimension, semantics.term_code, semantics.term_label,
           semantics.normalization_status, semantics.normalization_method,
           semantics.normalization_confidence, semantics.observation_id,
           semantics.observation_key, semantics.claim_kind, semantics.claim_status,
           semantics.source_field, semantics.source_excerpt,
           semantics.evidence_fingerprint, semantics.raw_storage_reference,
           semantics.claim_metadata
    from public.catalog_reference_product_semantics_v1 semantics
    join public.catalog_reference_products reference on reference.id = semantics.reference_product_id
    where reference.primary_source_id = $1
    order by semantics.reference_key, semantics.dimension, semantics.term_code, semantics.evidence_fingerprint
  `, [source.id]);
  const activeSemantics = semanticRows.filter((row) => ["observed", "reviewed"].includes(row.normalization_status));
  assert(activeSemantics.length === 1587,
    `La capa semantica esperaba 1.587 claims activos y encontro ${activeSemantics.length}.`);
  assert(activeSemantics.every((row) => row.claim_status === "source_claim"),
    "Existe un claim semantico sin claimStatus=source_claim.");

  const claimsByProduct = new Map(products.map((product) => [product.id, new Map()]));
  for (const claim of activeSemantics) {
    const dimensions = claimsByProduct.get(claim.reference_product_id);
    const values = dimensions.get(claim.dimension) ?? [];
    values.push(claim);
    dimensions.set(claim.dimension, values);
  }

  const matrix = products.map((product) => {
    const dimensions = claimsByProduct.get(product.id);
    const row = {
      reference_key: product.reference_key,
      external_id: product.primary_external_id,
      product_name: product.name,
      sku: product.sku,
      official_type: product.official_type,
      presentation: product.presentation,
      price_cop: product.price_cop,
      image_status: product.primary_image_url && product.has_remote_media ? "remote_reference" : "missing",
      image_url: product.primary_image_url,
      source_url: product.source_url,
      active_claims: [...dimensions.values()].reduce((total, values) => total + values.length, 0),
    };
    for (const dimension of DIMENSIONS) {
      row[dimension] = (dimensions.get(dimension) ?? []).map((claim) => claim.term_label);
    }
    return row;
  });

  const coverage = DIMENSIONS.map((dimension) => {
    const dimensionClaims = activeSemantics.filter((claim) => claim.dimension === dimension);
    const covered = new Set(dimensionClaims.map((claim) => claim.reference_product_id)).size;
    return {
      dimension,
      products_covered: covered,
      total_products: products.length,
      coverage_percent: percent(covered, products.length),
      active_claims: dimensionClaims.length,
      distinct_terms: new Set(dimensionClaims.map((claim) => claim.term_code)).size,
    };
  });

  const basicCoverage = [
    ["identity", (product) => Boolean(product.name)],
    ["sku", (product) => Boolean(product.sku)],
    ["type", (product) => Boolean(product.official_type)],
    ["price", (product) => product.price_cop !== null],
    ["image", (product) => Boolean(product.primary_image_url && product.has_remote_media)],
  ].map(([dimension, predicate]) => {
    const covered = products.filter(predicate).length;
    return { dimension, products_covered: covered, total_products: products.length, coverage_percent: percent(covered, products.length) };
  });

  const queryDefinitions = [
    { key: "fragile_nails", label: "Productos para unas fragiles", dimension: "concern", codes: ["fragile_nails"] },
    { key: "weak_damaged_nails", label: "Productos para unas debiles/maltratadas", dimension: "concern", codes: ["weak_damaged_nails"] },
    { key: "declared_strengthening", label: "Productos que declaran fortalecimiento", dimension: "benefit", codes: ["strengthening"] },
    { key: "biotin_urea", label: "Productos con Biotina/Urea", dimension: "ingredient", codes: ["biotin", "urea"] },
    { key: "garlic_lemon", label: "Productos con extracto de ajo/limon", dimension: "ingredient", codes: ["garlic_extract", "lemon_extract"] },
    { key: "base_role", label: "Productos que pueden funcionar como base", dimension: "role", codes: ["base_coat"] },
    { key: "admiss_system", label: "Productos relacionados con el sistema ADMISS", dimension: "system", codes: [`official_brand_system:${SOURCE_KEY}`] },
    { key: "collection_type_mismatch", label: "Coleccion comercial que no coincide con tipo real", dimension: "relation", codePrefix: `commercial_collection_type_mismatch:${SOURCE_KEY}:` },
  ];
  const requestedQueries = queryDefinitions.map((definition) => {
    const matches = activeSemantics.filter((claim) => claim.dimension === definition.dimension
      && (definition.codes?.includes(claim.term_code) || (definition.codePrefix && claim.term_code.startsWith(definition.codePrefix))));
    const grouped = new Map();
    for (const claim of matches) {
      const entry = grouped.get(claim.reference_product_id) ?? {
        reference_product_id: claim.reference_product_id,
        reference_key: claim.reference_key,
        product_name: claim.product_name,
        terms: [],
        source_excerpts: [],
      };
      entry.terms.push(claim.term_label);
      if (claim.source_excerpt) entry.source_excerpts.push(claim.source_excerpt);
      grouped.set(claim.reference_product_id, entry);
    }
    return { key: definition.key, label: definition.label, count: grouped.size, products: [...grouped.values()] };
  });

  const latestRuns = await rows(`
    select run.id, run.run_key, run.result_fingerprint, run.result,
           scope.source_state, snapshot.snapshot_id
    from public.catalog_research_runs run
    join public.catalog_research_run_sources scope on scope.research_run_id = run.id
    join public.catalog_research_run_snapshots snapshot on snapshot.research_run_source_id = scope.id
    where scope.source_id = $1 and run.status = 'succeeded'
    order by run.finished_at desc
    limit 2
  `, [source.id]);
  assert(latestRuns.length === 2, "Faltan dos corridas exitosas para probar idempotencia.");
  const semanticFingerprint = hash(JSON.stringify(activeSemantics.map((claim) => ({
    observationKey: claim.observation_key,
    dimension: claim.dimension,
    termCode: claim.term_code,
    status: claim.normalization_status,
    evidenceFingerprint: claim.evidence_fingerprint,
  }))));
  const duplicateSemanticMaterial = Number((await rows(`
    select count(*)::int as total from (
      select observation.reference_product_id, observation.predicate,
             observation.value_json->>'termCode', observation.value_json->>'evidenceFingerprint', count(*)
      from public.catalog_observations observation
      join public.catalog_source_records record on record.id = observation.source_record_id
      where record.source_id = $1 and observation.observation_kind = 'semantic_claim'
      group by observation.reference_product_id, observation.predicate,
               observation.value_json->>'termCode', observation.value_json->>'evidenceFingerprint'
      having count(*) > 1
    ) duplicate
  `, [source.id]))[0].total);
  const idempotency = {
    latest_two_material_fingerprints_equal: latestRuns[0].result_fingerprint === latestRuns[1].result_fingerprint,
    latest_two_snapshots_equal: latestRuns[0].snapshot_id === latestRuns[1].snapshot_id,
    latest_two_source_states: latestRuns.map((run) => run.source_state),
    latest_two_semantic_claim_counts: latestRuns.map((run) => run.result?.ingestion?.semantics?.claims),
    latest_two_semantic_superseded_counts: latestRuns.map((run) => run.result?.ingestion?.semantics?.superseded),
    active_semantic_claims: activeSemantics.length,
    semantic_state_fingerprint_sha256: semanticFingerprint,
    duplicate_semantic_material: duplicateSemanticMaterial,
  };
  assert(idempotency.latest_two_material_fingerprints_equal, "Las dos corridas no comparten fingerprint material.");
  assert(idempotency.latest_two_snapshots_equal, "Las dos corridas no reutilizaron el mismo snapshot material.");
  assert(idempotency.latest_two_semantic_claim_counts.every((count) => count === 1587), "El conteo semantico cambio entre corridas.");
  assert(idempotency.latest_two_semantic_superseded_counts.every((count) => count === 0), "La repeticion supersedio claims sin cambios.");
  assert(duplicateSemanticMaterial === 0, "Existen claims semanticamente duplicados.");

  const operationalImpact = (await rows(`
    select
      (select count(*)::int from public.products) as products,
      (select count(*)::int from public.product_variants) as variants,
      (select count(*)::int from public.variant_prices) as prices,
      (select count(*)::int from public.inventory_stock) as stock,
      (select count(*)::int from public.product_media) as commercial_media,
      (select count(*)::int from public.catalog_review_work_items) as mesa_total,
      (select count(*)::int from public.catalog_review_work_items where status in ('open','in_progress')) as mesa_active,
      (select count(*)::int from public.catalog_review_work_items where context->>'semanticAudit' = 'admiss') as mesa_created_by_audit,
      (select count(*)::int from public.graph_semantic_term_nodes_v1) as semantic_graph_nodes,
      (select count(*)::int from public.graph_semantic_term_edges_v1) as semantic_graph_edges
  `))[0];
  assert(operationalImpact.mesa_created_by_audit === 0, "La auditoria creo trabajo en Mesa.");
  assert(latestRuns[0].result?.commercialGuard?.unchanged === true, "Falta guard comercial persistido.");

  const graphProjection = (await rows(`
    select projector_version, counts, verification, postgres_fingerprint,
           graph_fingerprint, finished_at
    from public.catalog_graph_projection_runs
    where action = 'verify' and status = 'succeeded'
    order by finished_at desc
    limit 1
  `))[0];
  assert(graphProjection, "No existe un graph verify exitoso para la auditoria.");
  const graphDifferenceCount = Object.values(graphProjection.verification)
    .reduce((total, values) => total + values.length, 0);
  assert(graphProjection.postgres_fingerprint === graphProjection.graph_fingerprint,
    "Los fingerprints PostgreSQL/Neo4j no coinciden.");
  assert(graphDifferenceCount === 0, "Graph verify conserva divergencias.");

  const sourceFieldDistribution = Object.entries(activeSemantics.reduce((accumulator, claim) => {
    accumulator[claim.source_field] = (accumulator[claim.source_field] ?? 0) + 1;
    return accumulator;
  }, {})).map(([source_field, claims]) => ({ source_field, claims }));

  const rawStorageReference = activeSemantics[0]?.raw_storage_reference;
  const relativeManifest = String(rawStorageReference).replace(/^local-storage:\/\//, "");
  const rawProductPath = path.join(
    path.dirname(path.join(catalogResearchStorageRoot(ROOT), ...relativeManifest.split("/"))),
    "products-page-1.json",
  );
  const rawProducts = JSON.parse(fs.readFileSync(rawProductPath, "utf8")).products;
  const rawAudit = {
    storage_reference: rawStorageReference,
    product_payloads: rawProducts.length,
    descriptions_present: rawProducts.filter((product) => String(product.body_html ?? "").trim()).length,
    descriptions_missing: rawProducts.filter((product) => !String(product.body_html ?? "").trim()).length,
    tags_present: rawProducts.filter((product) => Array.isArray(product.tags) && product.tags.length).length,
    source_field_distribution: sourceFieldDistribution,
  };

  const gaps = [
    {
      gap: "Claims funcionales no revisados tecnicamente",
      count: activeSemantics.filter((claim) => claim.claim_kind === "manufacturer_declared").length,
      disposition: "Se conservan como source_claim; revision humana/tecnica solo si se pretende canonizar.",
    },
    {
      gap: "Productos sin pertenencia a coleccion oficial capturada",
      count: products.length - new Set(activeSemantics
        .filter((claim) => claim.dimension === "relation" && claim.term_code.startsWith(`commercial_collection:${SOURCE_KEY}:`))
        .map((claim) => claim.reference_product_id)).size,
      disposition: "Gap real de superficie comercial; no inferir coleccion.",
    },
    {
      gap: "Productos sin formulacion declarada",
      count: products.length - coverage.find((item) => item.dimension === "formulation").products_covered,
      disposition: "Ausencia en fuente, no completar por similitud.",
    },
    {
      gap: "Productos sin acabado declarado/normalizable",
      count: products.length - coverage.find((item) => item.dimension === "finish").products_covered,
      disposition: "Esperable en liquidos/herramientas; revisar solo si el tipo requiere acabado.",
    },
    {
      gap: "Contradicciones coleccion comercial versus tipo oficial",
      count: requestedQueries.find((query) => query.key === "collection_type_mismatch").count,
      disposition: "Conservar como contradiccion de fuente; no reclasificar automaticamente ni abrir Mesa.",
    },
  ];

  const report = {
    generated_at: new Date().toISOString(),
    source: source,
    scope: { products: products.length, baseline_observations: baselineObservationCount, active_semantic_claims: activeSemantics.length },
    baseline_observation_distribution: baselineDistribution,
    basic_coverage: basicCoverage,
    semantic_coverage: coverage,
    raw_audit: rawAudit,
    requested_queries: requestedQueries,
    gaps,
    operational_impact: operationalImpact,
    graph_projection: { ...graphProjection, difference_count: graphDifferenceCount },
    commercial_guard: latestRuns[0].result.commercialGuard,
    idempotency,
    epistemic_contract: {
      claim_status: "source_claim",
      semantic_layer: "evidence",
      canonical_technical_fact: false,
      rule: "La fuente declara X; X no se convierte automaticamente en verdad tecnica universal.",
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, "admiss-121-semantic-matrix.csv"), csv(matrix, [
    "reference_key", "external_id", "product_name", "sku", "official_type", "presentation",
    "price_cop", "image_status", "image_url", "source_url", "active_claims", ...DIMENSIONS,
  ]));
  fs.writeFileSync(path.join(REPORT_DIR, "admiss-semantic-audit.json"), `${JSON.stringify({ ...report, matrix }, null, 2)}\n`);

  const reportMarkdown = `# Auditoria de Cobertura Taxonomica y Semantica ADMISS\n\n`
    + `Generada: ${report.generated_at}\n\n`
    + `Etapa 4 permanece detenida. Alcance: **${products.length} productos oficiales**, **${baselineObservationCount.toLocaleString("es-PE")} observaciones basales** y **${activeSemantics.length.toLocaleString("es-PE")} claims semanticos activos**.\n\n`
    + `## Contrato epistemico\n\nLa memoria conserva que **la fuente oficial declara X**. Los terminos normalizados viven en capa \`evidence\`, llevan procedencia y estado, y no son hechos tecnicos universales ni hechos comerciales canonicos.\n\n`
    + `## Auditoria de las 1.134 observaciones existentes\n\n`
    + markdownTable(["Predicado", "Clase", "Observaciones", "Productos", "Variantes"], baselineDistribution.map((item) => [item.predicate, item.observation_kind, item.observations, item.products, item.variants]))
    + `\n\nSolo contenian ocho predicados: identidad, SKU, tipo, linea, presentacion, tono, acabado e imagen. Concern, beneficio, ingrediente, uso, rol, etapa, sistema, formulacion y relaciones no estaban estructurados.\n\n`
    + `## Cobertura basica\n\n`
    + markdownTable(["Dimension", "Productos", "Total", "Cobertura"], basicCoverage.map((item) => [item.dimension, item.products_covered, item.total_products, `${item.coverage_percent}%`]))
    + `\n\n## Cobertura semantica\n\n`
    + markdownTable(["Dimension", "Productos", "Cobertura", "Claims", "Terminos"], coverage.map((item) => [item.dimension, item.products_covered, `${item.coverage_percent}%`, item.active_claims, item.distinct_terms]))
    + `\n\nLa cobertura baja de concern o ingrediente significa que la fuente solo lo declara para algunos productos; no debe rellenarse por inferencia.\n\n`
    + `## Consultas demostradas desde memoria propia\n\n`
    + markdownTable(["Consulta", "Productos"], requestedQueries.map((query) => [query.label, query.count]))
    + `\n\n## Gaps reales y disposicion\n\n`
    + markdownTable(["Gap", "Cantidad", "Disposicion"], gaps.map((gap) => [gap.gap, gap.count, gap.disposition]))
    + `\n\n## Idempotencia e impacto\n\n`
    + `- Dos corridas exitosas consecutivas comparten fingerprint material: **${idempotency.latest_two_material_fingerprints_equal}**.\n`
    + `- Reutilizaron el mismo snapshot material: **${idempotency.latest_two_snapshots_equal}**.\n`
    + `- Claims activos: **${idempotency.active_semantic_claims}**; duplicados materiales: **${idempotency.duplicate_semantic_material}**; superseded en ambas: **${idempotency.latest_two_semantic_superseded_counts.join(", ")}**.\n`
    + `- Mesa creada por la auditoria: **${operationalImpact.mesa_created_by_audit}**. El guard comercial persistido confirma productos, variantes, precios, stock y media sin cambios.\n`
    + `- Neo4j recibe ${operationalImpact.semantic_graph_nodes} terminos y ${operationalImpact.semantic_graph_edges} aristas \`NORMALIZES_TO\`, siempre en capa evidence.\n\n`
    + `- Graph Projector ${graphProjection.projector_version}: **${graphProjection.counts.graphNodes} nodos**, **${graphProjection.counts.graphEdges} aristas**, fingerprints PostgreSQL/Neo4j iguales y **${graphDifferenceCount} divergencias**.\n\n`
    + `## Archivos\n\nLa matriz completa de 121 filas esta en \`admiss-121-semantic-matrix.csv\`; el detalle reproducible de consultas, excerpts, fingerprints y matriz esta en \`admiss-semantic-audit.json\`.\n`;
  fs.writeFileSync(path.join(REPORT_DIR, "README.md"), reportMarkdown);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    reportDirectory: REPORT_DIR,
    scope: report.scope,
    coverage,
    requestedQueries: requestedQueries.map(({ key, label, count }) => ({ key, label, count })),
    gaps,
    operationalImpact,
    graphProjection: report.graph_projection,
    idempotency,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
