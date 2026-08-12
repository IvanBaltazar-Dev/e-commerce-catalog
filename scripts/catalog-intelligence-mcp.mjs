import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import {
  createGraphDriverFromEnv,
  createPostgresPoolFromEnv,
  GraphProjector,
} from "../src/lib/catalog-intelligence/graph-projector.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "catalog-intelligence-mcp",
  quiet: true,
});
const database = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function must(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function resolveBrand(brandName) {
  const brands = must(await database.from("brands").select("id, name, slug").order("name"), "brands");
  const expected = normalize(brandName);
  const brand = brands.find((item) => normalize(item.name) === expected || normalize(item.slug) === expected);
  if (!brand) throw new Error(`Marca no encontrada: ${brandName}`);
  return brand;
}

async function brandReport(brandName) {
  const brand = await resolveBrand(brandName);
  return must(
    await database.rpc("get_catalog_brand_intelligence_report_v1", { p_brand_id: brand.id }),
    "brand intelligence report",
  );
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function registerReadTool(server, name, config, handler) {
  server.registerTool(name, {
    ...config,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    try {
      return result(await handler(input));
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
}

const server = new McpServer({
  name: "bellaroshe-catalog-intelligence",
  version: "1.0.0",
});

registerReadTool(server, "catalog_status", {
  title: "Estado de Inteligencia de Catálogo",
  description: "Resume catálogo comercial, Universo de Referencia, investigaciones, señales de identidad y Mesa sin modificar datos.",
  inputSchema: {},
}, async () => {
  const tables = [
    "products",
    "product_variants",
    "catalog_reference_products",
    "catalog_reference_variants",
    "catalog_research_runs",
    "catalog_reconciliation_cases",
    "catalog_review_work_items",
  ];
  const counts = {};
  for (const table of tables) {
    const response = await database.from(table).select("*", { count: "exact", head: true });
    must(response, `count ${table}`);
    counts[table] = response.count ?? 0;
  }
  return {
    authority: "PostgreSQL",
    graphRole: "derived_rebuildable_projection",
    aiApiUsed: false,
    transport: "local_stdio",
    counts,
  };
});

registerReadTool(server, "brand_context", {
  title: "Contexto de Marca",
  description: "Devuelve el contexto consolidado de una marca: catálogo actual, fuentes, universo, reconciliación, brechas y progreso.",
  inputSchema: { brand: z.string().min(1).max(120) },
}, async ({ brand }) => brandReport(brand));

registerReadTool(server, "last_research_run", {
  title: "Última Investigación",
  description: "Consulta la última corrida persistida de una marca y su delta; nunca lee archivos manuales ni memoria de conversación.",
  inputSchema: { brand: z.string().min(1).max(120) },
}, async ({ brand }) => {
  const report = await brandReport(brand);
  return { brand: report.brand, lastResearchRun: report.lastResearchRun, delta: report.delta };
});

registerReadTool(server, "reference_universe_search", {
  title: "Buscar Universo de Referencia",
  description: "Busca productos y variantes externos persistidos por nombre o SKU dentro de una marca.",
  inputSchema: {
    brand: z.string().min(1).max(120),
    query: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  },
}, async ({ brand: brandName, query = "", limit }) => {
  const brand = await resolveBrand(brandName);
  const needle = query.replace(/[%_(),]/g, " ").trim();
  let productQuery = database.from("catalog_reference_products")
    .select("id, reference_key, name, product_type, line, presentation, source_url, primary_image_url, enrichment_level, knowledge_status, presence_status, last_seen_at")
    .eq("brand_id", brand.id)
    .order("name")
    .limit(limit);
  if (needle) productQuery = productQuery.ilike("name", `%${needle}%`);
  const products = must(await productQuery, "reference products");

  const productIds = must(await database.from("catalog_reference_products")
    .select("id")
    .eq("brand_id", brand.id)
    .range(0, 999), "reference product ids").map((item) => item.id);
  let variants = [];
  if (productIds.length) {
    const byName = needle
      ? must(await database.from("catalog_reference_variants")
        .select("id, reference_key, reference_product_id, name, sku, barcode, shade_name, presentation, source_url, primary_image_url, enrichment_level, knowledge_status, presence_status, last_seen_at")
        .in("reference_product_id", productIds)
        .ilike("name", `%${needle}%`)
        .order("name")
        .limit(limit), "reference variants by name")
      : must(await database.from("catalog_reference_variants")
        .select("id, reference_key, reference_product_id, name, sku, barcode, shade_name, presentation, source_url, primary_image_url, enrichment_level, knowledge_status, presence_status, last_seen_at")
        .in("reference_product_id", productIds)
        .order("name")
        .limit(limit), "reference variants");
    const bySku = needle
      ? must(await database.from("catalog_reference_variants")
        .select("id, reference_key, reference_product_id, name, sku, barcode, shade_name, presentation, source_url, primary_image_url, enrichment_level, knowledge_status, presence_status, last_seen_at")
        .in("reference_product_id", productIds)
        .ilike("sku", `%${needle}%`)
        .order("sku")
        .limit(limit), "reference variants by SKU")
      : [];
    variants = [...new Map([...byName, ...bySku].map((item) => [item.id, item])).values()].slice(0, limit);
  }
  return { brand, query, products, variants };
});

registerReadTool(server, "brand_differences", {
  title: "Diferencias de Marca",
  description: "Expone delta, coincidencias confirmadas, candidatas, pendientes y referencias sin correspondencia.",
  inputSchema: { brand: z.string().min(1).max(120) },
}, async ({ brand }) => {
  const report = await brandReport(brand);
  return {
    brand: report.brand,
    currentCatalog: report.currentCatalog,
    referenceUniverse: report.referenceUniverse,
    delta: report.delta,
    reconciliation: report.reconciliation,
  };
});

registerReadTool(server, "knowledge_gaps_and_contradictions", {
  title: "Brechas y Contradicciones",
  description: "Lista contradicciones estructurales, referencias sin destino y huecos del catálogo interno.",
  inputSchema: { brand: z.string().min(1).max(120) },
}, async ({ brand }) => {
  const report = await brandReport(brand);
  return {
    brand: report.brand,
    contradictions: report.reconciliation.cases.filter((item) => item.signal === "contradiction"),
    unmatchedReferences: report.reconciliation.unmatched,
    knowledgeGaps: report.knowledgeGaps,
  };
});

registerReadTool(server, "review_cases", {
  title: "Casos de Mesa",
  description: "Consulta casos persistidos de revisión para una marca, incluidas candidatas de identidad y contradicciones, sin resolverlos.",
  inputSchema: {
    brand: z.string().min(1).max(120),
    status: z.enum(["open", "in_progress", "resolved", "superseded", "cancelled"]).optional(),
    handlingClass: z.enum([
      "human_exception", "automatic_debt", "physical_capture", "waiting_external",
    ]).default("human_exception"),
    limit: z.number().int().min(1).max(100).default(50),
  },
}, async ({ brand: brandName, status, handlingClass, limit }) => {
  const brand = await resolveBrand(brandName);
  let query = database.from("catalog_review_operational_queue_v1")
    .select("id, work_key, source_type, source_id, work_kind, purpose, status, handling_class, queue_state, human_actionable, priority_tier, risk_level, has_contradiction, business_relevance, question, recommendation, context, created_at, updated_at")
    .eq("group_key", `brand:${brand.id}`)
    .eq("handling_class", handlingClass)
    .order("has_contradiction", { ascending: false })
    .order("business_relevance", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  return { brand, cases: must(await query, "review cases") };
});

registerReadTool(server, "review_reprocess_status", {
  title: "Estado del Reprocesamiento de Mesa",
  description: "Consulta métricas, huellas, clasificación y último preview/apply de la Mesa; no resuelve decisiones.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_review_reprocess_report_v1"),
  "review reprocess report",
));

registerReadTool(server, "research_report", {
  title: "Informe de Investigación",
  description: "Devuelve el informe agregado y trazable de una marca desde contratos PostgreSQL.",
  inputSchema: { brand: z.string().min(1).max(120) },
}, async ({ brand }) => brandReport(brand));

registerReadTool(server, "graph_status", {
  title: "Estado del Grafo",
  description: "Consulta Neo4j y el último registro de proyección; no acepta Cypher ni ejecuta sincronización.",
  inputSchema: {},
}, async () => {
  const lastProjection = must(await database.from("catalog_graph_projection_runs")
    .select("id, action, projector_version, research_run_id, status, started_at, finished_at, postgres_fingerprint, graph_fingerprint, counts, errors, verification")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle(), "last graph projection");
  const driver = createGraphDriverFromEnv(env);
  const postgres = createPostgresPoolFromEnv(env);
  try {
    const projector = new GraphProjector({
      supabase: database,
      postgres,
      driver,
      database: env.NEO4J_DATABASE || undefined,
    });
    return { live: await projector.status(), lastProjection };
  } finally {
    await driver.close();
    await postgres.end();
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
