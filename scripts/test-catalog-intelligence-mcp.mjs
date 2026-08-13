import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--experimental-transform-types",
    "scripts/catalog-intelligence-mcp.mjs",
    "--env",
    ".env.supabase.local",
  ],
  cwd: ROOT,
  stderr: "pipe",
});
const client = new Client({ name: "bellaroshe-stage2-acceptance", version: "1.0.0" });

function parseToolResult(response, toolName) {
  if (response.isError) {
    throw new Error(`${toolName}: ${response.content?.map((item) => item.text ?? "").join(" ")}`);
  }
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${toolName}: respuesta sin contenido JSON.`);
  return JSON.parse(text);
}

async function call(name, args = {}) {
  return parseToolResult(await client.callTool({ name, arguments: args }), name);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const expectedTools = [
    "catalog_status",
    "brand_context",
    "last_research_run",
    "reference_universe_search",
    "brand_differences",
    "knowledge_gaps_and_contradictions",
    "review_cases",
    "review_reprocess_status",
    "semantic_campaign_report",
    "semantic_checkpoint_report",
    "research_report",
    "graph_status",
  ];
  const names = listed.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) {
    throw new Error(`Herramientas MCP inesperadas: ${names.join(", ")}`);
  }
  for (const tool of listed.tools) {
    if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
      throw new Error(`La herramienta ${tool.name} no declara límites de solo lectura.`);
    }
    if (/(sql|shell|fetch|cypher|publish|inventory|price_write)/i.test(tool.name)) {
      throw new Error(`Superficie MCP prohibida: ${tool.name}`);
    }
  }

  // Pregunta integral de aceptación desde un cliente/proceso nuevo:
  // “¿Qué sabemos de ADMISS, qué cambió, qué coincide o contradice el catálogo,
  //  dónde están ZAC 314094 y AJO Y LIMON, qué falta revisar y cómo está el grafo?”
  const [status, context, lastRun, zac, gaps, review, reprocess, semanticCheckpoint, graph] = await Promise.all([
    call("catalog_status"),
    call("brand_context", { brand: "ADMISS" }),
    call("last_research_run", { brand: "ADMISS" }),
    call("reference_universe_search", { brand: "ADMISS", query: "314094", limit: 10 }),
    call("knowledge_gaps_and_contradictions", { brand: "ADMISS" }),
    call("review_cases", { brand: "ADMISS", status: "open", limit: 100 }),
    call("review_reprocess_status"),
    call("semantic_checkpoint_report"),
    call("graph_status"),
  ]);

  if (status.authority !== "PostgreSQL" || status.transport !== "local_stdio" || status.aiApiUsed !== false) {
    throw new Error("El estado MCP no conserva PostgreSQL/STDIO/sin API de IA.");
  }
  if (context.currentCatalog.products !== 11 || context.currentCatalog.variants !== 85) {
    throw new Error(`Contexto comercial ADMISS inesperado: ${JSON.stringify(context.currentCatalog)}`);
  }
  if (context.referenceUniverse.products !== 121 || context.referenceUniverse.variants !== 121) {
    throw new Error(`Universo ADMISS inesperado: ${JSON.stringify(context.referenceUniverse)}`);
  }
  if (!zac.variants.some((variant) => variant.sku === "314094" && /ZAC/i.test(variant.name))) {
    throw new Error("El proceso MCP fresco no recuperó ZAC SKU 314094 desde PostgreSQL.");
  }
  const ajo = gaps.contradictions.find((item) => item.officialSku === "310010" && /Ajo y Limon/i.test(item.internalName));
  if (!ajo || ajo.evidence?.officialProductType !== "bases" || ajo.evidence?.internalCategory !== "esmaltes") {
    throw new Error("El MCP no devolvió la contradicción estructural AJO Y LIMON.");
  }
  if (!review.cases.some((item) => item.has_contradiction && item.context?.caseKey === ajo.caseKey)) {
    throw new Error("La contradicción AJO Y LIMON no aparece como caso abierto de Mesa.");
  }
  if (lastRun.delta.unchanged !== 242 || lastRun.delta.changed !== 0) {
    throw new Error(`El último delta no prueba repetición sin cambios: ${JSON.stringify(lastRun.delta)}`);
  }
  if (!graph.live?.connected) throw new Error("Neo4j no está conectado desde el MCP.");
  if (semanticCheckpoint.stage4Authorized !== false
      || semanticCheckpoint.contractViolations !== 0
      || semanticCheckpoint.latestCertification?.status !== "passed") {
    throw new Error(`Checkpoint semantico inesperado: ${JSON.stringify(semanticCheckpoint)}`);
  }
  if (reprocess.latestRun?.status !== "applied") {
    throw new Error("El MCP no recuperó el último reproceso aplicado de la Mesa.");
  }

  process.stdout.write(`${JSON.stringify({
    freshProcess: true,
    tools: names,
    answer: {
      currentCatalog: context.currentCatalog,
      referenceUniverse: context.referenceUniverse,
      lastDelta: lastRun.delta,
      reconciliation: {
        candidates: context.reconciliation.candidates,
        contradictions: context.reconciliation.contradictions,
        unmatchedReferences: context.reconciliation.unmatchedReferences,
      },
      zac: zac.variants.find((variant) => variant.sku === "314094"),
      ajoContradiction: ajo,
      openReviewCases: review.cases.length,
      reviewReprocess: reprocess,
      semanticCheckpoint,
      graph: graph.live,
    },
    dataSource: "PostgreSQL contracts + Neo4j live status",
    manualFilesReadByClient: false,
    conversationStateUsedByClient: false,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
