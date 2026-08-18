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

function registerWriteTool(server, name, config, handler, { destructive = false } = {}) {
  server.registerTool(name, {
    ...config,
    annotations: {
      readOnlyHint: false,
      destructiveHint: destructive,
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

registerReadTool(server, "semantic_campaign_report", {
  title: "Escala Humana de Campaña Semántica",
  description: "Reporta productos investigados, claims, problemas, grupos, reglas y excepciones humanas sin exponer trabajo por producto.",
  inputSchema: { runKey: z.string().min(1).max(200) },
}, async ({ runKey }) => {
  const run = must(await database.from("catalog_research_runs")
    .select("id,run_key,status")
    .eq("run_key", runKey)
    .maybeSingle(), "semantic campaign run");
  if (!run) throw new Error(`No existe la campaña ${runKey}.`);
  return must(
    await database.rpc("get_catalog_semantic_campaign_report_v1", { p_research_run_id: run.id }),
    "semantic campaign report",
  );
});

registerReadTool(server, "semantic_checkpoint_report", {
  title: "Checkpoint Semantico Universal",
  description: "Consulta contrato epistemologico, registros dirigidos por datos, violaciones y ultima certificacion; confirma que la certificacion no se autoautoriza aunque exista autorizacion humana externa.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_semantic_checkpoint_report_v1"),
  "universal semantic checkpoint report",
));

registerReadTool(server, "stage4a_system_class_report", {
  title: "Etapa 4A · Sistemas y Clases",
  description: "Consulta el contrato universal sistema-etapa-rol-clase-requisito, su fixture real y el checkpoint intacto de 323 relaciones diferidas.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_stage4a_report_v1"),
  "stage4a universal system class report",
));

registerReadTool(server, "stage4b_relation_reprocess_report", {
  title: "Etapa 4B · Reprocesamiento Universal de Relaciones",
  description: "Consulta la clasificacion explicable de las 323 relaciones, la compresion clase vs par directo y las guardas de preview/fingerprint sin promover conocimiento.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_relation_reprocess_report_v1"),
  "stage4b universal relation reprocess report",
));

registerReadTool(server, "stage4c_decision_report", {
  title: "Etapa 4C · Contrato de Decisiones",
  description: "Reporta familias reales, decisiones agrupadas, reducción de revisión individual y guardas comerciales del read model.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_stage4c_report_v1"),
  "stage4c decision report",
));

registerReadTool(server, "stage4c_decision_queue", {
  title: "Etapa 4C · Cola de Decisiones Agrupadas",
  description: "Devuelve casos listos para frontend con explicación, recomendación, afectados, evidencia, impacto y acciones; no aplica decisiones.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  },
}, async ({ limit, offset }) => must(
  await database.rpc("get_catalog_decision_queue_v1", {
    p_limit: limit,
    p_offset: offset,
  }),
  "stage4c decision queue",
));

registerReadTool(server, "stage4e_decision_report", {
  title: "Etapa 4E · Estado del Contrato de Aplicación",
  description: "Certifica expedientes agrupados, aplazamientos, previews, decisiones aplicadas y guardas de precio, stock, publicación y conocimiento canónico.",
  inputSchema: {},
}, async () => must(
  await database.rpc("get_catalog_stage4e_report_v1"),
  "stage4e decision report",
));

registerReadTool(server, "stage4e_decision_queue", {
  title: "Etapa 4E · Cola Operativa de Decisiones",
  description: "Devuelve la cola real de Catálogo → Revisar con lenguaje humano, estado, versión, aplazamiento y acciones definidas por backend.",
  inputSchema: {
    status: z.enum([
      "pending", "applied", "rejected", "adjustment_requested", "superseded", "all",
    ]).default("pending"),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  },
}, async ({ status, limit, offset }) => must(
  await database.rpc("get_catalog_relation_decision_queue_v1", {
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  }),
  "stage4e decision queue",
));

registerReadTool(server, "stage4e_decision_detail", {
  title: "Etapa 4E · Detalle de Decisión",
  description: "Abre un caso con afectados paginados, explicación natural, evidencia bajo demanda, propuesta exacta y trazabilidad técnica.",
  inputSchema: {
    decisionId: z.string().min(1).max(120),
    itemLimit: z.number().int().min(1).max(100).default(25),
    itemOffset: z.number().int().min(0).default(0),
  },
}, async ({ decisionId, itemLimit, itemOffset }) => must(
  await database.rpc("get_catalog_relation_decision_detail_v1", {
    p_decision_id: decisionId,
    p_item_limit: itemLimit,
    p_item_offset: itemOffset,
  }),
  "stage4e decision detail",
));

registerReadTool(server, "stage4e_decision_verify", {
  title: "Etapa 4E · Verificar Decisión Aplicada",
  description: "Comprueba resolución, evento inmutable y capa del grafo después de sincronizar; no modifica el catálogo.",
  inputSchema: { decisionId: z.string().min(1).max(120) },
}, async ({ decisionId }) => must(
  await database.rpc("verify_catalog_relation_decision_v1", {
    p_decision_id: decisionId,
  }),
  "stage4e decision verify",
));

registerWriteTool(server, "stage4e_decision_preview", {
  title: "Etapa 4E · Preparar Decisión",
  description: "Congela el efecto exacto de una acción y devuelve la huella que la persona debe confirmar antes de aplicar.",
  inputSchema: {
    decisionId: z.string().min(1).max(120),
    actionCode: z.enum([
      "ACCEPT_CLASS_RULE", "REJECT_CLASS_RULE", "ACCEPT_MEMBERSHIP_SCOPE",
      "ADJUST_ENDPOINT_PROFILE", "ACCEPT_FALSE_PAIR_RETIREMENT",
    ]),
    comment: z.string().max(1000).nullable().default(null),
    expectedWorkVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(200),
    actorId: z.string().uuid(),
  },
}, async ({ decisionId, actionCode, comment, expectedWorkVersion, idempotencyKey, actorId }) => must(
  await database.rpc("preview_catalog_relation_decision_v1", {
    p_decision_id: decisionId,
    p_action_code: actionCode,
    p_comment: comment,
    p_expected_work_version: expectedWorkVersion,
    p_idempotency_key: idempotencyKey,
    p_actor_id: actorId,
  }),
  "stage4e decision preview",
));

registerWriteTool(server, "stage4e_decision_defer", {
  title: "Etapa 4E · Anotar y Guardar Pendiente",
  description: "Guarda una nota y fecha de retorno sin resolver el caso ni cambiar candidatas o conocimiento.",
  inputSchema: {
    decisionId: z.string().min(1).max(120),
    expectedWorkVersion: z.number().int().positive(),
    reason: z.string().min(1).max(1000),
    deferMinutes: z.number().int().min(5).max(10080).default(1440),
    idempotencyKey: z.string().min(8).max(200),
    actorId: z.string().uuid(),
  },
}, async ({ decisionId, expectedWorkVersion, reason, deferMinutes, idempotencyKey, actorId }) => must(
  await database.rpc("transition_catalog_relation_decision_v1", {
    p_decision_id: decisionId,
    p_expected_work_version: expectedWorkVersion,
    p_action_code: "KEEP_DEFERRED",
    p_reason: reason,
    p_defer_minutes: deferMinutes,
    p_idempotency_key: idempotencyKey,
    p_actor_id: actorId,
  }),
  "stage4e decision defer",
));

registerWriteTool(server, "stage4e_decision_resume", {
  title: "Etapa 4E · Reanudar Decisión",
  description: "Devuelve un caso aplazado a la cola activa conservando su historia.",
  inputSchema: {
    decisionId: z.string().min(1).max(120),
    expectedWorkVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(200),
    actorId: z.string().uuid(),
  },
}, async ({ decisionId, expectedWorkVersion, idempotencyKey, actorId }) => must(
  await database.rpc("transition_catalog_relation_decision_v1", {
    p_decision_id: decisionId,
    p_expected_work_version: expectedWorkVersion,
    p_action_code: "RESUME",
    p_reason: null,
    p_defer_minutes: 1440,
    p_idempotency_key: idempotencyKey,
    p_actor_id: actorId,
  }),
  "stage4e decision resume",
));

registerWriteTool(server, "stage4e_decision_apply", {
  title: "Etapa 4E · Aplicar Decisión Exacta",
  description: "Aplica únicamente el preview confirmado, sincroniza la proyección Neo4j y verifica auditoría y capa epistemológica.",
  inputSchema: {
    previewId: z.string().uuid(),
    previewFingerprint: z.string().length(64),
    idempotencyKey: z.string().min(8).max(200),
    actorId: z.string().uuid(),
  },
}, async ({ previewId, previewFingerprint, idempotencyKey, actorId }) => {
  const applied = must(await database.rpc("apply_catalog_relation_decision_v1", {
    p_preview_id: previewId,
    p_preview_fingerprint: previewFingerprint,
    p_idempotency_key: idempotencyKey,
    p_actor_id: actorId,
  }), "stage4e decision apply");

  // Sync también corre en un replay idempotente. Si Neo4j falla después del
  // commit PostgreSQL, repetir el mismo comando repara la proyección sin volver
  // a decidir ni duplicar el evento.
  const driver = createGraphDriverFromEnv(env);
  const postgres = createPostgresPoolFromEnv(env);
  let graph;
  try {
    graph = await new GraphProjector({
      supabase: database,
      postgres,
      driver,
      database: env.NEO4J_DATABASE || undefined,
    }).sync();
  } finally {
    await driver.close();
    await postgres.end();
  }
  const verification = must(await database.rpc("verify_catalog_relation_decision_v1", {
    p_decision_id: applied.decisionId,
  }), "stage4e decision verify after graph sync");
  if (!verification.passed || !graph.ok) {
    throw new Error(`La decisión se aplicó pero la verificación final falló: ${JSON.stringify({ graph, verification })}`);
  }
  return { apply: applied, graph, verification };
}, { destructive: true });

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
