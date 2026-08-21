import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import {
  discoverShopifyOfficialCatalog,
  normalizeOfficialText,
  parseOfficialProduct,
} from "../src/lib/catalog-intelligence/shopify-official-adapter.mjs";
import {
  extractOfficialProductSemantics,
  OFFICIAL_SEMANTIC_NORMALIZER_VERSION,
} from "../src/lib/catalog-intelligence/official-semantic-normalizer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Súbela cuando cambie qué se registra o cómo se clasifica una observación. Al
// subirla se emiten observaciones nuevas y las anteriores quedan como historia,
// que es lo que exige que sean inmutables.
const CONTRATO_OBSERVACION = "v2-epistemico";
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "research-official-brand",
  allowedFlags: ["--source-key", "--brand", "--summary"],
});
if (!isLocal) throw new Error("La campaña de Etapa 2 está autorizada únicamente contra el entorno local.");

function option(name) {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1] ?? null;
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const sourceKey = option("--source-key");
if (!sourceKey) throw new Error("Usa --source-key=<fuente registrada>. La URL raíz se toma de PostgreSQL.");
const requestedBrand = option("--brand");
const summaryOnly = process.argv.includes("--summary");

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function must(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function count(table) {
  const result = await admin.from(table).select("*", { count: "exact", head: true });
  must(result, `count ${table}`);
  return result.count ?? 0;
}

async function protectedCounts() {
  return Object.fromEntries(await Promise.all([
    "products",
    "product_variants",
    "variant_prices",
    "inventory_stock",
    "product_media",
  ].map(async (table) => [table, await count(table)])));
}

async function upsertBatches(table, rows, onConflict, { ignoreDuplicates = false, size = 300 } = {}) {
  for (let offset = 0; offset < rows.length; offset += size) {
    const result = await admin.from(table).upsert(rows.slice(offset, offset + size), {
      onConflict,
      ignoreDuplicates,
    });
    must(result, `${table} batch ${offset}`);
  }
}

async function insertBatches(table, rows, size = 300) {
  for (let offset = 0; offset < rows.length; offset += size) {
    must(await admin.from(table).insert(rows.slice(offset, offset + size)), `${table} batch ${offset}`);
  }
}

/**
 * Paginado CON ORDEN ESTABLE. El orden no es cosmético: sin él, OFFSET/LIMIT
 * sobre un resultado sin ordenar no está definido, y PostgreSQL puede devolver
 * las filas en distinto orden en cada página.
 *
 * Medido sobre catalog_observations filtrando por observation_kind: 18.836 filas
 * devueltas pero solo 10.808 llaves distintas. 8.028 filas repetidas y otras
 * tantas que no salían nunca — el 43%. Con ORDER BY, las 18.836 únicas.
 *
 * Lo insidioso es que el TOTAL salía bien. Un recuento de filas no detecta esto:
 * hay que contar llaves distintas. Y no falla siempre: catalog_reference_products
 * con 4.079 filas y sin filtro paginaba perfecto. Aparece cuando el planificador
 * elige un plan no determinista, que con filtro y tabla grande es lo normal.
 *
 * De ahí venía «No se resolvió el claim» en Masglo, Acrylove y MC Nails: la
 * observación estaba escrita y el término existía, pero la relectura paginada no
 * la devolvía. Bigen y Admiss pasaban porque necesitan resolver pocas llaves y
 * les tocaba caer en la mitad que sí volvía.
 */
async function selectAll(queryFactory, operation, pageSize = 1000, orderBy = "id") {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = must(
      await queryFactory().order(orderBy).range(offset, offset + pageSize - 1),
      `${operation} page ${offset}`,
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function mapConcurrent(values, worker, concurrency = 12) {
  let cursor = 0;
  const output = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
}

function availability(value) {
  if (value === true) return "available";
  if (value === false) return "out_of_stock";
  return "unknown";
}

function contentHash(value) {
  return sha256(JSON.stringify(value));
}

function productUrl(source, product) {
  return new URL(`/products/${encodeURIComponent(product.handle)}`, source.base_url).toString();
}

function variantUrl(source, product, variant) {
  const url = new URL(productUrl(source, product));
  url.searchParams.set("variant", String(variant.id));
  return url.toString();
}

function observationRow({
  key, sourceRecordId, runId, subject, kind, predicate, value, observedAt, metadata = {},
  // Procedencia de la conclusión. Sin esto, un valor que produjo nuestro regex
  // llega indistinguible de uno que publicó la fuente, y la autoridad no puede
  // toparse por clase epistémica porque no sabe qué clase es.
  epistemic = "OBSERVATION_LITERAL", dimension = null, rule = null, ruleVersion = null,
  derivedFrom = null, role = null, note = null,
}) {
  const esDerivado = epistemic === "DERIVED_INFERRED";
  const esNormalizado = epistemic === "NORMALIZED_SOURCE_CLAIM";
  const row = {
    observation_key: key,
    source_record_id: sourceRecordId,
    research_run_id: runId,
    reference_product_id: subject.kind === "product" ? subject.id : null,
    reference_variant_id: subject.kind === "variant" ? subject.id : null,
    observation_kind: kind,
    predicate,
    observed_at: observedAt,
    // El método ya no es siempre «official_api»: lo que sale de un regex nuestro
    // no lo trajo la API, lo dedujimos del texto que sí trajo.
    extraction_method: esDerivado ? "rule_inference" : esNormalizado ? "rule_normalization" : "official_api",
    extractor: rule ? `${rule}-v${ruleVersion ?? 1}` : "shopify-official-discovery-v1",
    // Una inferencia no puede entrar con confianza 1. La suya es la de su regla,
    // que se mide aparte y varía del 0% al 99% según la fuente.
    confidence: esDerivado ? 0.5 : esNormalizado ? 0.8 : 1,
    metadata: {
      ...metadata,
      epistemic_class: epistemic,
      ...(dimension ? { dimension_code: dimension } : {}),
      ...(rule ? { rule_code: rule, rule_version: ruleVersion ?? 1 } : {}),
      ...(derivedFrom ? { derived_from: derivedFrom } : {}),
      ...(role ? { role } : {}),
      ...(note ? { note } : {}),
    },
  };
  if (typeof value === "string") row.value_text = value;
  else if (typeof value === "number") row.value_number = value;
  else if (typeof value === "boolean") row.value_boolean = value;
  else row.value_json = value;
  return row;
}

function addObservation(rows, input) {
  if (input.value === null || input.value === undefined || input.value === "") return;
  const material = contentHash({ predicate: input.predicate, value: input.value, epistemic: input.epistemic ?? "OBSERVATION_LITERAL" });
  // La clase epistémica entra en la llave: semantic.type declarado por la tienda
  // y semantic.type deducido de los tags son dos observaciones distintas sobre el
  // mismo predicado, y fundirlas perdería justo la que hay que poder descartar.
  rows.push(observationRow({ ...input, key: `official-observation-${CONTRATO_OBSERVACION}:${input.referenceKey}:${input.predicate}:${input.epistemic ?? "LIT"}:${material}` }));
}

async function resolveSource() {
  let source = must(
    await admin
      .from("catalog_sources")
      .select("id, source_key, name, authority, adapter, base_url, brand_id, is_active, metadata")
      .eq("source_key", sourceKey)
      .single(),
    "catalog source",
  );
  if (!source.is_active || source.authority !== "official") {
    throw new Error("La campaña requiere una fuente oficial activa.");
  }
  if (source.adapter !== "shopify_products_json") {
    throw new Error(`El adaptador ${source.adapter} todavía no está implementado por este ejecutor.`);
  }
  let brand;
  if (source.brand_id) {
    brand = must(await admin.from("brands").select("id, name, slug").eq("id", source.brand_id).single(), "brand");
    if (requestedBrand && normalizeOfficialText(requestedBrand) !== normalizeOfficialText(brand.name)) {
      throw new Error(`La fuente ya pertenece a ${brand.name}, no a ${requestedBrand}.`);
    }
  } else {
    if (!requestedBrand) throw new Error("La fuente aún no tiene marca: usa --brand=<nombre exacto> para registrarla.");
    const brands = must(await admin.from("brands").select("id, name, slug"), "brands");
    brand = brands.find((item) => normalizeOfficialText(item.name) === normalizeOfficialText(requestedBrand));
    if (!brand) throw new Error(`No existe la marca ${requestedBrand} en el catálogo interno.`);
    source = must(await admin.from("catalog_sources")
      .update({ brand_id: brand.id })
      .eq("id", source.id)
      .select("id, source_key, name, authority, adapter, base_url, brand_id, is_active, metadata")
      .single(), "bind source brand");
  }
  return { source, brand };
}

async function previousSuccessfulScope(sourceId) {
  const rows = must(
    await admin
      .from("catalog_research_run_sources")
      .select("id, research_run_id, result_fingerprint, source_state, finished_at, catalog_research_runs!inner(id, status, run_kind)")
      .eq("source_id", sourceId)
      .eq("scope_key", "official-catalog")
      .in("status", ["succeeded", "partial"])
      .order("finished_at", { ascending: false })
      .limit(1),
    "previous research scope",
  );
  return rows[0] ?? null;
}

async function createRun({ source, brand, capture, previous }) {
  const runKind = previous ? "delta" : "baseline";
  const inputFingerprint = contentHash({
    sourceKey: source.source_key,
    sourceRoot: source.base_url,
    adapter: source.adapter,
    discoveryContract: "official-root-discovery-v1",
  });
  const runKey = `${source.source_key}:${runKind}:${capture.capturedAt}:${capture.contentFingerprint.slice(0, 16)}`;
  const run = must(await admin.from("catalog_research_runs").insert({
    run_key: runKey,
    run_kind: runKind,
    previous_run_id: previous?.research_run_id ?? null,
    actor_kind: "codex",
    actor_label: "Codex · campaña oficial por marca y fuente",
    status: "running",
    input_fingerprint: inputFingerprint,
    scope: {
      brandId: brand.id,
      brandName: brand.name,
      sourceKey: source.source_key,
      sourceRoot: source.base_url,
      discovery: capture.discovery,
      rawStorageReference: capture.storage.storageReference,
      rawManifestSha256: capture.storage.manifestSha256,
    },
  }).select("id, run_key, run_kind").single(), "research run");
  must(await admin.from("catalog_research_run_brands").insert({
    research_run_id: run.id,
    brand_id: brand.id,
  }), "research run brand");

  const sourceState = !previous
    ? "first_seen"
    : previous.result_fingerprint === capture.contentFingerprint ? "unchanged" : "changed";
  const scope = must(await admin.from("catalog_research_run_sources").insert({
    research_run_id: run.id,
    source_id: source.id,
    brand_id: brand.id,
    scope_key: "official-catalog",
    previous_run_source_id: previous?.id ?? null,
    status: "running",
    source_state: sourceState,
    input_fingerprint: inputFingerprint,
    scope: {
      discovery: capture.discovery,
      rawStorageReference: capture.storage.storageReference,
      rawFingerprint: capture.rawFingerprint,
    },
  }).select("id, source_state").single(), "research run source");
  return { run, scope, sourceState };
}

async function resolveSnapshot({ source, capture }) {
  const existing = must(
    await admin
      .from("catalog_source_snapshots")
      .select("id, content_hash, raw_storage_path")
      .eq("source_id", source.id)
      .eq("content_hash", capture.contentFingerprint)
      .in("status", ["succeeded", "partial"])
      .maybeSingle(),
    "snapshot lookup",
  );
  if (existing) return { snapshot: existing, reused: true };

  const snapshot = must(await admin.from("catalog_source_snapshots").insert({
    source_id: source.id,
    status: "running",
    started_at: capture.capturedAt,
    content_hash: capture.contentFingerprint,
    raw_storage_path: capture.storage.storageReference,
    product_count: capture.counts.products,
    variant_count: capture.counts.variants,
    image_count: capture.counts.images,
    metadata: {
      capture: "official-root-discovery-v1",
      rawFingerprint: capture.rawFingerprint,
      rawManifestSha256: capture.storage.manifestSha256,
      discovery: capture.discovery,
    },
  }).select("id, content_hash, raw_storage_path").single(), "snapshot insert");

  const records = [];
  for (const product of capture.products) {
    const parsed = parseOfficialProduct(product);
    const imageUrl = product.images?.[0]?.src ?? null;
    const rawReference = `${capture.storage.storageReference}#products-page`;
    records.push({
      snapshot_id: snapshot.id,
      source_id: source.id,
      entity_type: "product",
      external_id: `shopify-product:${product.id}`,
      title: String(product.title),
      normalized_name: normalizeOfficialText(product.title),
      source_url: productUrl(source, product),
      primary_image_url: imageUrl,
      payload: {
        handle: product.handle,
        vendor: product.vendor,
        productType: product.product_type,
        tags: parsed.tags,
        publishedAt: product.published_at,
        createdAt: product.created_at,
        updatedAt: product.updated_at,
        descriptionSha256: sha256(String(product.body_html ?? "")),
        rawReference,
      },
      captured_at: capture.capturedAt,
    });
    for (const variant of product.variants ?? []) {
      records.push({
        snapshot_id: snapshot.id,
        source_id: source.id,
        entity_type: "variant",
        external_id: `shopify-variant:${variant.id}`,
        external_parent_id: `shopify-product:${product.id}`,
        title: variant.title === "Default Title" ? String(product.title) : `${product.title} / ${variant.title}`,
        normalized_name: normalizeOfficialText(variant.title === "Default Title" ? product.title : `${product.title} ${variant.title}`),
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        source_url: variantUrl(source, product, variant),
        primary_image_url: variant.featured_image?.src ?? imageUrl,
        payload: {
          productId: String(product.id),
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compare_at_price,
          available: variant.available,
          position: variant.position,
          optionValues: [variant.option1, variant.option2, variant.option3].filter(Boolean),
          updatedAt: variant.updated_at,
          rawReference,
        },
        captured_at: capture.capturedAt,
      });
    }
  }
  await insertBatches("catalog_source_records", records);
  must(await admin.from("catalog_source_snapshots").update({
    status: "succeeded",
    completed_at: capture.capturedAt,
  }).eq("id", snapshot.id), "snapshot completion");
  return { snapshot, reused: false };
}

async function loadRecords(snapshotId) {
  // Paginado. Estaba con .range(0, 999) y PostgREST corta ahí: para MC Nails, con
  // 2.069 registros, el mapa salía con la mitad y los productos que faltaban
  // reventaban después con «Cannot read properties of undefined». Bigen funcionaba
  // solo porque cabía por debajo del tope, que es la peor forma de estar roto:
  // parece que funciona hasta que la fuente crece.
  //
  // El helper selectAll existía desde el principio; había cuatro llamadas que lo
  // esquivaban.
  const rows = await selectAll(
    () => admin.from("catalog_source_records")
      .select("id, entity_type, external_id, external_parent_id, sku, barcode, source_url, primary_image_url")
      .eq("snapshot_id", snapshotId),
    "source records",
  );
  return new Map(rows.map((row) => [`${row.entity_type}:${row.external_id}`, row]));
}

async function existingReferences(sourceId) {
  const products = await selectAll(() => admin.from("catalog_reference_products")
    .select("id, reference_key, primary_external_id, content_fingerprint, presence_status")
    .eq("primary_source_id", sourceId), "existing reference products");
  const variants = await selectAll(() => admin.from("catalog_reference_variants")
    .select("id, reference_key, primary_external_id, content_fingerprint, presence_status")
    .eq("primary_source_id", sourceId), "existing reference variants");
  return {
    products: new Map(products.map((row) => [row.reference_key, row])),
    variants: new Map(variants.map((row) => [row.reference_key, row])),
  };
}

async function ingestOfficialSemantics({ source, brand, capture, run, productByExternalId }) {
  const collectionsByProduct = new Map();
  for (const collection of capture.collectionMemberships ?? []) {
    for (const productId of collection.productIds ?? []) {
      const memberships = collectionsByProduct.get(String(productId)) ?? [];
      memberships.push(collection);
      collectionsByProduct.set(String(productId), memberships);
    }
  }

  const extracted = [];
  for (const product of capture.products) {
    const reference = productByExternalId.get(String(product.id));
    const claims = extractOfficialProductSemantics({
      product,
      sourceKey: source.source_key,
      brandName: brand.name,
      collectionMemberships: collectionsByProduct.get(String(product.id)) ?? [],
    });
    for (const claim of claims) extracted.push({ product, reference, claim });
  }

  const uniqueTerms = new Map();
  for (const { claim } of extracted) {
    uniqueTerms.set(`${claim.dimension}:${claim.code}`, {
      dimension: claim.dimension,
      code: claim.code,
      label: claim.label,
      metadata: {
        vocabularyKind: "normalized_source_vocabulary",
        isCanonicalTechnicalFact: false,
        normalizerVersion: OFFICIAL_SEMANTIC_NORMALIZER_VERSION,
      },
      updated_at: capture.capturedAt,
    });
  }
  await upsertBatches("catalog_semantic_terms", [...uniqueTerms.values()], "dimension,code");
  const terms = await selectAll(
    () => admin.from("catalog_semantic_terms").select("id,dimension,code"),
    "semantic terms",
  );
  const termByKey = new Map(terms.map((term) => [`${term.dimension}:${term.code}`, term]));

  const observationRows = extracted.map(({ reference, claim }) => ({
    observation_key: `official-semantic-observation-${CONTRATO_OBSERVACION}:${reference.referenceKey}:${claim.dimension}:${claim.code}:${claim.evidenceFingerprint}`,
    source_record_id: reference.record.id,
    research_run_id: run.id,
    reference_product_id: reference.id,
    reference_variant_id: null,
    observation_kind: "semantic_claim",
    predicate: `semantic.${claim.dimension}`,
    value_json: {
      termCode: claim.code,
      termLabel: claim.label,
      claimKind: claim.claimKind,
      claimStatus: "source_claim",
      sourceField: claim.sourceField,
      sourceValue: claim.sourceValue,
      sourceExcerpt: claim.sourceExcerpt,
      ruleCode: claim.ruleCode,
      evidenceFingerprint: claim.evidenceFingerprint,
      rawStorageReference: capture.storage.storageReference,
      metadata: claim.metadata,
    },
    observed_at: capture.capturedAt,
    // Estas afirmaciones no vienen en un campo de la ficha: las extrae un
    // normalizador del texto libre de la descripción y los tags. Entraban como
    // «official_api» y sin clase epistémica, así que llegaban indistinguibles de
    // un campo que la tienda sí publica — 9.418 observaciones en esa situación.
    extraction_method: "rule_inference",
    extractor: OFFICIAL_SEMANTIC_NORMALIZER_VERSION,
    confidence: claim.confidence,
    metadata: {
      sourceKey: source.source_key,
      // El vocabulario canónico del checkpoint, no uno paralelo. «source_claim»
      // describía de quién es la afirmación; epistemic_class describe cómo la
      // obtuvimos, que es lo que decide el tope de autoridad.
      epistemic_class: "DERIVED_INFERRED",
      dimension_code: claim.dimension,
      rule_code: claim.ruleCode,
      rule_version: OFFICIAL_SEMANTIC_NORMALIZER_VERSION,
      derived_from: { field: claim.sourceField, excerpt: claim.sourceExcerpt },
      epistemicStatus: "source_claim",
      isCanonicalTechnicalFact: false,
      ruleCode: claim.ruleCode,
    },
  }));
  await upsertBatches("catalog_observations", observationRows, "observation_key", { ignoreDuplicates: true });

  const currentKeys = new Set(observationRows.map((row) => row.observation_key));
  const existing = (await selectAll(
    () => admin.from("catalog_reference_product_semantics_v1")
      .select("reference_key,observation_id,observation_key,normalization_status"),
    "existing source semantics", 1000, "observation_key",
  )).filter((row) => row.reference_key.startsWith(`${source.source_key}:`));
  const observationByKey = new Map(existing.map((row) => [row.observation_key, row]));
  const missingKeys = [...currentKeys].filter((key) => !observationByKey.has(key));
  if (missingKeys.length) {
    const missingSet = new Set(missingKeys);
    const rows = await selectAll(
      () => admin.from("catalog_observations")
        .select("id,observation_key")
        .eq("observation_kind", "semantic_claim"),
      "new semantic observations",
    );
    for (const row of rows) {
      if (missingSet.has(row.observation_key)) {
        observationByKey.set(row.observation_key, { observation_id: row.id, observation_key: row.observation_key });
      }
    }
  }

  const now = new Date().toISOString();
  const links = extracted.map(({ reference, claim }) => {
    const observationKey = `official-semantic-observation-${CONTRATO_OBSERVACION}:${reference.referenceKey}:${claim.dimension}:${claim.code}:${claim.evidenceFingerprint}`;
    const observation = observationByKey.get(observationKey);
    const term = termByKey.get(`${claim.dimension}:${claim.code}`);
    if (!observation || !term) throw new Error(`No se resolvio el claim ${observationKey}.`);
    return {
      observation_id: observation.observation_id,
      semantic_term_id: term.id,
      normalization_status: "observed",
      normalization_method: OFFICIAL_SEMANTIC_NORMALIZER_VERSION,
      confidence: claim.confidence,
      metadata: {
        sourceKey: source.source_key,
        ruleCode: claim.ruleCode,
        isCanonicalTechnicalFact: false,
      },
      updated_at: now,
    };
  });
  // Lotes pequeños: esta tabla tiene un trigger que materializa la cadena
  // epistémica fila a fila, así que un lote de 300 agota el tiempo de la petición
  // en la fuente más grande. MC Nails caía justo aquí con «statement timeout».
  await upsertBatches("catalog_observation_semantic_terms", links, "observation_id", { size: 50 });

  const staleIds = existing
    .filter((row) => !currentKeys.has(row.observation_key) && row.normalization_status !== "superseded")
    .map((row) => row.observation_id);
  for (let offset = 0; offset < staleIds.length; offset += 100) {
    must(await admin.from("catalog_observation_semantic_terms").update({
      normalization_status: "superseded",
      updated_at: now,
      metadata: {
        sourceKey: source.source_key,
        supersededByRunId: run.id,
        reason: "not_observed_in_latest_official_capture",
        isCanonicalTechnicalFact: false,
      },
    }).in("observation_id", staleIds.slice(offset, offset + 100)), `supersede semantic observations ${offset}`);
  }

  const byDimension = {};
  for (const { claim } of extracted) byDimension[claim.dimension] = (byDimension[claim.dimension] ?? 0) + 1;
  return {
    claims: links.length,
    terms: uniqueTerms.size,
    productsWithClaims: new Set(extracted.map(({ reference }) => reference.id)).size,
    superseded: staleIds.length,
    byDimension,
    observationIds: links.map((link) => link.observation_id),
  };
}

async function ingestReferences({ source, brand, capture, run, scope, records }) {
  const before = await existingReferences(source.id);
  const productInputs = capture.products.map((product) => {
    const parsed = parseOfficialProduct(product);
    const record = records.get(`product:shopify-product:${product.id}`);
    const referenceKey = `${source.source_key}:product:${product.id}`;
    const fingerprintPayload = {
      id: String(product.id),
      title: product.title,
      handle: product.handle,
      productType: product.product_type,
      tags: parsed.tags,
      presentation: parsed.presentation,
      variants: (product.variants ?? []).map((variant) => ({
        id: String(variant.id), sku: variant.sku, price: variant.price, available: variant.available,
      })),
      images: (product.images ?? []).map((image) => image.src),
    };
    return {
      product,
      parsed,
      record,
      referenceKey,
      contentFingerprint: contentHash(fingerprintPayload),
      payload: {
        referenceKey,
        brandId: brand.id,
        sourceId: source.id,
        sourceRecordId: record.id,
        externalId: String(product.id),
        name: String(product.title),
        normalizedName: normalizeOfficialText(product.title),
        family: product.product_type || null,
        productType: product.product_type || null,
        line: parsed.line,
        presentation: parsed.presentation,
        sourceUrl: productUrl(source, product),
        imageUrl: product.images?.[0]?.src ?? null,
        identityFingerprint: contentHash({ brandId: brand.id, sourceId: source.id, externalId: String(product.id) }),
        contentFingerprint: contentHash(fingerprintPayload),
        level: "REFERENCE_LIGHT",
        metadata: {
          handle: product.handle,
          finish: parsed.finish,
          gamut: parsed.gamut,
          tags: parsed.tags,
          officialUpdatedAt: product.updated_at,
          rawStorageReference: capture.storage.storageReference,
        },
      },
    };
  });

  const productResults = await mapConcurrent(productInputs, async (input) => {
    return must(await admin.rpc("upsert_catalog_reference_product_v1", {
      p_research_run_id: run.id,
      p_observed_at: capture.capturedAt,
      p_payload: input.payload,
    }), `reference product ${input.referenceKey}`);
  });
  const productByExternalId = new Map(productInputs.map((input, index) => [
    String(input.product.id),
    { ...input, id: productResults[index].id },
  ]));

  const variantInputs = [];
  for (const input of productInputs) {
    const referenceProduct = productByExternalId.get(String(input.product.id));
    for (const variant of input.product.variants ?? []) {
      const record = records.get(`variant:shopify-variant:${variant.id}`);
      const referenceKey = `${source.source_key}:variant:${variant.id}`;
      const name = variant.title === "Default Title"
        ? input.parsed.shadeName || String(input.product.title)
        : String(variant.title);
      const fingerprintPayload = {
        id: String(variant.id),
        productId: String(input.product.id),
        name,
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price,
        available: variant.available,
        image: variant.featured_image?.src ?? input.product.images?.[0]?.src ?? null,
      };
      variantInputs.push({
        product: input.product,
        parsed: input.parsed,
        variant,
        record,
        referenceKey,
        contentFingerprint: contentHash(fingerprintPayload),
        payload: {
          referenceKey,
          referenceProductId: referenceProduct.id,
          sourceId: source.id,
          sourceRecordId: record.id,
          externalId: String(variant.id),
          name,
          normalizedName: normalizeOfficialText(name),
          sku: variant.sku || null,
          barcode: variant.barcode || null,
          shadeName: input.parsed.shadeName,
          presentation: input.parsed.presentation,
          sourceUrl: variantUrl(source, input.product, variant),
          imageUrl: variant.featured_image?.src ?? input.product.images?.[0]?.src ?? null,
          identityFingerprint: contentHash({ referenceProductId: referenceProduct.id, externalId: String(variant.id) }),
          contentFingerprint: contentHash(fingerprintPayload),
          level: "REFERENCE_LIGHT",
          metadata: {
            officialTitle: variant.title,
            optionValues: [variant.option1, variant.option2, variant.option3].filter(Boolean),
            rawStorageReference: capture.storage.storageReference,
          },
        },
      });
    }
  }
  const variantResults = await mapConcurrent(variantInputs, async (input) => {
    return must(await admin.rpc("upsert_catalog_reference_variant_v1", {
      p_research_run_id: run.id,
      p_observed_at: capture.capturedAt,
      p_payload: input.payload,
    }), `reference variant ${input.referenceKey}`);
  });
  const variantByExternalId = new Map(variantInputs.map((input, index) => [
    String(input.variant.id),
    { ...input, id: variantResults[index].id },
  ]));

  const identifierInputs = [];
  for (const input of productInputs) {
    const reference = productByExternalId.get(String(input.product.id));
    for (const [kind, observedValue] of [
      ["external_id", String(input.product.id)],
      ["handle", String(input.product.handle)],
      ["source_url", productUrl(source, input.product)],
    ]) {
      identifierInputs.push({ reference, kind, observedValue, subjectKind: "reference_product" });
    }
  }
  for (const input of variantInputs) {
    const reference = variantByExternalId.get(String(input.variant.id));
    for (const [kind, observedValue] of [
      ["external_id", String(input.variant.id)],
      ["sku", input.variant.sku || null],
      ["barcode", input.variant.barcode || null],
      ["source_url", variantUrl(source, input.product, input.variant)],
    ]) {
      if (observedValue) identifierInputs.push({ reference, kind, observedValue, subjectKind: "reference_variant" });
    }
  }
  await mapConcurrent(identifierInputs, async (input) => {
    must(await admin.rpc("upsert_catalog_reference_identifier_v1", { p_payload: {
      subject: { kind: input.subjectKind, id: input.reference.id },
      sourceId: source.id,
      sourceRecordId: input.reference.record.id,
      kind: input.kind,
      observedValue: String(input.observedValue),
      normalizedValue: normalizeOfficialText(input.observedValue),
      researchRunId: run.id,
      observedAt: capture.capturedAt,
    } }), `identifier ${input.reference.referenceKey}/${input.kind}`);
  });

  const presenceRows = [];
  const deltaCounts = { first_seen: 0, unchanged: 0, changed: 0, returned: 0 };
  for (const [kind, inputs, resolved, previous] of [
    ["product", productInputs, productByExternalId, before.products],
    ["variant", variantInputs, variantByExternalId, before.variants],
  ]) {
    for (const input of inputs) {
      const externalId = String(kind === "product" ? input.product.id : input.variant.id);
      const current = resolved.get(externalId);
      const prior = previous.get(input.referenceKey);
      const delta = !prior
        ? "first_seen"
        : ["missing_from_source", "source_unavailable"].includes(prior.presence_status)
          ? "returned"
          : prior.content_fingerprint === input.contentFingerprint ? "unchanged" : "changed";
      deltaCounts[delta] += 1;
      presenceRows.push({
        research_run_source_id: scope.id,
        reference_product_id: kind === "product" ? current.id : null,
        reference_variant_id: kind === "variant" ? current.id : null,
        delta_status: delta,
        previous_fingerprint: prior?.content_fingerprint ?? null,
        current_fingerprint: input.contentFingerprint,
        observed_at: capture.capturedAt,
        metadata: { sourceKey: source.source_key },
      });
    }
  }
  await upsertBatches("catalog_reference_presence_events", presenceRows, "research_run_source_id,target_ref", { ignoreDuplicates: true });

  const observations = [];
  const priceRows = [];
  const mediaRows = [];
  for (const input of productInputs) {
    const reference = productByExternalId.get(String(input.product.id));
    const common = {
      sourceRecordId: input.record.id,
      runId: run.id,
      subject: { kind: "product", id: reference.id },
      observedAt: capture.capturedAt,
      referenceKey: input.referenceKey,
      metadata: { sourceKey: source.source_key },
    };
    // Predicados CANÓNICOS, no del namespace del crawler.
    //
    // Esto emitía official.title, official.sku, official.line… y «official» no es
    // ninguna de las 22 dimensiones registradas: era el nombre del adaptador. El
    // sistema de autoridad trabaja sobre identity.*, media.* y semantic.<dimensión>,
    // así que nada de lo que salía de aquí resolvía contra ninguna regla. Y darle
    // autoridad a official.* habría institucionalizado un segundo vocabulario, con
    // shopify.sku, woocommerce.sku y pdf.sku detrás.
    //
    // Cada observación lleva además su clase epistémica, porque de ella depende el
    // tope de autoridad: la fuente manda sobre el texto que publica, no sobre lo
    // que nuestro parser concluya de él.
    addObservation(observations, { ...common, kind: "identity", predicate: "identity.name",
      value: input.product.title, dimension: "identity", epistemic: "OBSERVATION_LITERAL" });
    addObservation(observations, { ...common, kind: "identity", predicate: "identity.brand_declared",
      value: input.product.vendor, dimension: "identity", epistemic: "OBSERVATION_LITERAL",
      // Sin resolver a entidad: la misma marca aparece como MASGLO, Masglo y
      // Masglo España, y Bigen como «bigen-usa.com». Resolverlo sería DERIVED.
      note: "etiqueta de tienda, no marca resuelta" });
    addObservation(observations, { ...common, kind: "type", predicate: "semantic.type",
      value: input.product.product_type, dimension: "type", epistemic: "OBSERVATION_LITERAL" });

    // Derivados: conservan la regla, su versión y el texto del que salieron, para
    // que la conclusión pueda rehacerse cuando la regla cambie.
    addObservation(observations, { ...common, kind: "type", predicate: "semantic.type",
      value: input.parsed.line, dimension: "type", epistemic: "DERIVED_INFERRED",
      rule: "NAIL_ES_PRODUCT_SEMANTICS", ruleVersion: 1, derivedFrom: { field: "tags", value: input.parsed.tags } });
    addObservation(observations, { ...common, kind: "type", predicate: "semantic.finish",
      value: input.parsed.finish, dimension: "finish", epistemic: "DERIVED_INFERRED",
      rule: "NAIL_ES_PRODUCT_SEMANTICS", ruleVersion: 1, derivedFrom: { field: "tags", value: input.parsed.tags } });
    addObservation(observations, { ...common, kind: "presentation", predicate: "semantic.packaging",
      value: input.parsed.presentation, dimension: "packaging", epistemic: "NORMALIZED_SOURCE_CLAIM",
      rule: "PRESENTACION_CANTIDAD_UNIDAD", ruleVersion: 1,
      derivedFrom: { field: "title+product_type+tags", value: input.product.title } });
    addObservation(observations, { ...common, kind: "shade", predicate: "semantic.subtype",
      value: input.parsed.shadeName, dimension: "subtype", epistemic: "DERIVED_INFERRED",
      rule: "TONO_POR_SEGMENTO_DE_TITULO", ruleVersion: 1,
      derivedFrom: { field: "title", value: input.product.title } });

    const imageUrl = input.product.images?.[0]?.src ?? null;
    addObservation(observations, { ...common, kind: "remote_image", predicate: "media.image",
      value: imageUrl, dimension: "media", epistemic: "OBSERVATION_LITERAL", role: "primary" });
    for (const [position, image] of (input.product.images ?? []).entries()) {
      mediaRows.push({
        media_key: `official-media-v1:${input.referenceKey}:${contentHash(image.src)}`,
        reference_product_id: reference.id,
        reference_variant_id: null,
        source_id: source.id,
        source_record_id: input.record.id,
        media_kind: "image",
        remote_url: image.src,
        content_hash: null,
        mime_type: null,
        validation_status: "remote_reference",
        first_seen_run_id: run.id,
        last_seen_run_id: run.id,
        first_seen_at: capture.capturedAt,
        last_seen_at: capture.capturedAt,
        metadata: { position: position + 1, width: image.width, height: image.height, downloaded: false },
      });
    }
  }
  for (const input of variantInputs) {
    const reference = variantByExternalId.get(String(input.variant.id));
    const common = {
      sourceRecordId: input.record.id,
      runId: run.id,
      subject: { kind: "variant", id: reference.id },
      observedAt: capture.capturedAt,
      referenceKey: input.referenceKey,
      metadata: { sourceKey: source.source_key },
    };
    // El SKU de fábrica manda dentro del espacio de nombres de su marca y no
    // fuera; el id interno de la tienda no identifica nada fuera de ella. Son
    // predicados distintos a propósito, porque identidad-guardas.ts ya los ordena
    // 90 y 50 y la autoridad tenía que decir lo mismo.
    addObservation(observations, { ...common, kind: "code", predicate: "identity.manufacturer_sku",
      value: input.variant.sku || null, dimension: "identity", epistemic: "OBSERVATION_LITERAL" });
    addObservation(observations, { ...common, kind: "code", predicate: "identity.source_external_id",
      value: input.variant.id ? String(input.variant.id) : null, dimension: "identity", epistemic: "OBSERVATION_LITERAL" });
    addObservation(observations, { ...common, kind: "code", predicate: "identity.gtin",
      value: input.variant.barcode || null, dimension: "identity", epistemic: "OBSERVATION_LITERAL" });
    addObservation(observations, { ...common, kind: "shade", predicate: "semantic.subtype",
      value: input.parsed.shadeName, dimension: "subtype", epistemic: "DERIVED_INFERRED",
      rule: "TONO_POR_SEGMENTO_DE_TITULO", ruleVersion: 1 });
    addObservation(observations, { ...common, kind: "presentation", predicate: "semantic.packaging",
      value: input.parsed.presentation, dimension: "packaging", epistemic: "NORMALIZED_SOURCE_CLAIM",
      rule: "PRESENTACION_CANTIDAD_UNIDAD", ruleVersion: 1 });
    const amount = Number.parseFloat(input.variant.price);
    if (Number.isFinite(amount)) {
      // La moneda sale de la fuente, no de una constante. Estuvo quemada a "COP"
      // aquí y a PEN en la tabla, y el resultado fue que 2.011 precios de cinco
      // países se guardaron como soles: los 3.900–15.900 de Admiss son pesos
      // colombianos, y leídos como soles convierten un producto de S/15 en uno
      // de S/15.900. El importe estaba bien; la etiqueta, no.
      const moneda = source.metadata?.currency;
      if (!moneda) {
        throw new Error(
          `${source.source_key} no declara moneda en catalog_sources.metadata.currency.
` +
          `Un precio sin mercado no es interpretable: declárala antes de capturar.`
        );
      }
      const priceFingerprint = contentHash({ amount, currency: moneda, availability: availability(input.variant.available) });
      priceRows.push({
        price_key: `official-price-v1:${input.referenceKey}:${priceFingerprint}`,
        research_run_id: run.id,
        reference_product_id: null,
        reference_variant_id: reference.id,
        source_id: source.id,
        source_record_id: input.record.id,
        currency: moneda,
        amount,
        presentation: input.parsed.presentation,
        external_availability: availability(input.variant.available),
        observed_at: capture.capturedAt,
        content_fingerprint: priceFingerprint,
        metadata: { sourceKey: source.source_key },
      });
    }
  }
  await upsertBatches("catalog_observations", observations, "observation_key", { ignoreDuplicates: true });
  await upsertBatches("catalog_reference_prices", priceRows, "price_key", { ignoreDuplicates: true });
  // La llave natural de un medio es (a qué apunta, qué URL), no media_key.
  //
  // media_key se construye a partir de referenceKey, y referenceKey cambió de
  // formato: al reejecutar, el upsert generaba una llave nueva, no encontraba
  // conflicto por ella e intentaba insertar, chocando con el índice único real
  // catalog_reference_media_target_url_idx. Es el mismo fallo que en
  // catalog_reference_products, y la misma lección: apuntar el ON CONFLICT a lo
  // que de verdad identifica la fila, no a la etiqueta derivada.
  await upsertBatches("catalog_reference_media", mediaRows, "target_ref,remote_url");
  const semantics = await ingestOfficialSemantics({
    source, brand, capture, run, productByExternalId,
  });
  const { observationIds: semanticObservationIds, ...semanticCounts } = semantics;

  return {
    productByExternalId,
    variantByExternalId,
    deltaCounts,
    counts: {
      products: productInputs.length,
      variants: variantInputs.length,
      identifiers: identifierInputs.length,
      observations: observations.length,
      prices: priceRows.length,
      media: mediaRows.length,
      semantics: semanticCounts,
    },
    semanticObservationIds,
  };
}

async function attachEvidence({ source, capture, records, semanticObservationIds = [] }) {
  const evidenceKey = `official-source:${source.source_key}:${capture.contentFingerprint}`;
  let evidence = must(await admin.from("catalog_evidence_sets")
    .select("id")
    .eq("evidence_key", evidenceKey)
    .eq("version", 1)
    .maybeSingle(), "evidence lookup");
  if (!evidence) {
    evidence = must(await admin.from("catalog_evidence_sets").insert({
      evidence_key: evidenceKey,
      version: 1,
      evidence_type: "official_sources",
      decision_status: "proposed",
      confidence: 1,
      metadata: {
        sourceKey: source.source_key,
        contentFingerprint: capture.contentFingerprint,
        rawStorageReference: capture.storage.storageReference,
      },
    }).select("id").single(), "evidence set");
  }
  const items = [...records.values()].map((record) => ({
    evidence_set_id: evidence.id,
    source_record_id: record.id,
    observation_id: null,
    stance: "supports",
    notes: "Registro descubierto desde la raíz oficial y conservado en snapshot verificable.",
  }));
  const existingItems = await selectAll(() => admin.from("catalog_evidence_items")
    .select("source_record_id")
    .eq("evidence_set_id", evidence.id)
    .eq("stance", "supports")
    .not("source_record_id", "is", null), "evidence items lookup");
  const knownRecordIds = new Set(existingItems.map((item) => item.source_record_id));
  const missingItems = items.filter((item) => !knownRecordIds.has(item.source_record_id));
  if (missingItems.length) await insertBatches("catalog_evidence_items", missingItems);
  const existingObservationItems = await selectAll(
    () => admin.from("catalog_evidence_items")
      .select("observation_id")
      .eq("evidence_set_id", evidence.id)
      .eq("stance", "supports")
      .not("observation_id", "is", null),
    "semantic evidence items lookup",
  );
  const knownObservationIds = new Set(existingObservationItems.map((item) => item.observation_id));
  const missingObservationItems = [...new Set(semanticObservationIds)]
    .filter((observationId) => !knownObservationIds.has(observationId))
    .map((observationId) => ({
      evidence_set_id: evidence.id,
      source_record_id: null,
      observation_id: observationId,
      stance: "supports",
      notes: "Claim normalizado desde evidencia oficial RAW; conserva excerpt y no constituye un hecho tecnico canonico.",
    }));
  if (missingObservationItems.length) await insertBatches("catalog_evidence_items", missingObservationItems);
  return evidence.id;
}

async function finalize({ source, brand, capture, run, scope, snapshot, snapshotReused, ingest, reconciliation, evidenceSetId }) {
  must(await admin.from("catalog_research_run_snapshots").upsert({
    research_run_source_id: scope.id,
    snapshot_id: snapshot.id,
    snapshot_role: snapshotReused ? "reused" : run.run_kind === "baseline" ? "baseline" : "captured",
  }, { onConflict: "research_run_source_id,snapshot_id", ignoreDuplicates: true }), "run snapshot");

  const sourceMetrics = {
    ...capture.counts,
    ...ingest.counts,
    rawFingerprint: capture.rawFingerprint,
    snapshotReused,
    deltas: ingest.deltaCounts,
  };
  must(await admin.rpc("finalize_catalog_research_source_v1", {
    p_research_run_source_id: scope.id,
    p_status: "succeeded",
    p_result_fingerprint: capture.contentFingerprint,
    p_metrics: sourceMetrics,
    p_errors: [],
  }), "finalize research source");
  const result = {
    sourceKey: source.source_key,
    brand: brand.name,
    sourceRoot: source.base_url,
    discovery: capture.discovery,
    rawStorageReference: capture.storage.storageReference,
    rawManifestSha256: capture.storage.manifestSha256,
    snapshotId: snapshot.id,
    snapshotReused,
    evidenceSetId,
    ingestion: ingest.counts,
    reconciliation,
    publicationEffects: 0,
  };
  must(await admin.rpc("finalize_catalog_research_run_v1", {
    p_research_run_id: run.id,
    p_status: "succeeded",
    p_result_fingerprint: capture.contentFingerprint,
    p_result: result,
    p_errors: [],
  }), "finalize research run");
  must(await admin.from("catalog_sources").update({ last_success_at: capture.capturedAt }).eq("id", source.id), "source success");
  return result;
}

const protectedBefore = await protectedCounts();
const { source, brand } = await resolveSource();
const storageRoot = catalogResearchStorageRoot(ROOT);
const previous = await previousSuccessfulScope(source.id);
const capture = await discoverShopifyOfficialCatalog({
  sourceKey: source.source_key,
  sourceRoot: source.base_url,
  storageRoot,
});
const { run, scope, sourceState } = await createRun({ source, brand, capture, previous });

try {
  const { snapshot, reused } = await resolveSnapshot({ source, capture });
  const records = await loadRecords(snapshot.id);
  const ingest = await ingestReferences({ source, brand, capture, run, scope, records });
  const evidenceSetId = await attachEvidence({
    source,
    capture,
    records,
    semanticObservationIds: ingest.semanticObservationIds,
  });
  const reconciliation = must(await admin.rpc("stage_catalog_brand_reconciliation_v1", {
    p_research_run_id: run.id,
    p_brand_id: brand.id,
    p_source_id: source.id,
  }), "brand reconciliation");
  const result = await finalize({
    source, brand, capture, run, scope, snapshot,
    snapshotReused: reused, ingest, reconciliation, evidenceSetId,
  });
  const report = must(await admin.rpc("get_catalog_brand_intelligence_report_v1", { p_brand_id: brand.id }), "brand report");
  const protectedAfter = await protectedCounts();
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) {
    throw new Error(`Contaminación comercial detectada: ${JSON.stringify({ protectedBefore, protectedAfter })}`);
  }
  result.commercialGuard = { before: protectedBefore, after: protectedAfter, unchanged: true };
  must(await admin.from("catalog_research_runs").update({ result }).eq("id", run.id), "persist commercial guard");
  report.lastResearchRun.result = result;
  const output = {
    run: { id: run.id, key: run.run_key, kind: run.run_kind, sourceState },
    capture: { ...capture.counts, contentFingerprint: capture.contentFingerprint, rawFingerprint: capture.rawFingerprint },
    protectedTables: protectedAfter,
    result,
    report,
  };
  process.stdout.write(`${JSON.stringify(summaryOnly ? {
    run: output.run,
    capture: output.capture,
    protectedTables: output.protectedTables,
    result: {
      snapshotId: result.snapshotId,
      snapshotReused: result.snapshotReused,
      ingestion: result.ingestion,
      reconciliation: result.reconciliation,
      publicationEffects: result.publicationEffects,
    },
    report: {
      currentCatalog: report.currentCatalog,
      referenceUniverse: report.referenceUniverse,
      reconciliation: {
        candidates: report.reconciliation.candidates,
        contradictions: report.reconciliation.contradictions,
        unmatchedReferences: report.reconciliation.unmatchedReferences,
        pendingReview: report.reconciliation.pendingReview,
      },
      progress: report.progress,
      delta: report.delta,
    },
  } : output, null, 2)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  await admin.from("catalog_research_run_sources").update({
    status: "failed",
    source_state: "source_unavailable",
    errors: [detail],
    finished_at: new Date().toISOString(),
  }).eq("id", scope.id);
  await admin.from("catalog_research_runs").update({
    status: "failed",
    errors: [detail],
    result_fingerprint: capture.contentFingerprint,
    finished_at: new Date().toISOString(),
  }).eq("id", run.id);
  throw error;
}
