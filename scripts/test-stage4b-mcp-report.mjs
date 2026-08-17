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
const client = new Client({ name: "bellaroshe-stage4b-acceptance", version: "1.0.0" });

function parse(response) {
  if (response.isError) throw new Error(response.content?.map((item) => item.text ?? "").join(" "));
  const body = response.content?.find((item) => item.type === "text")?.text;
  if (!body) throw new Error("El MCP no devolvio contenido JSON.");
  return JSON.parse(body);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "stage4b_relation_reprocess_report");
  if (!tool) throw new Error("Falta la herramienta stage4b_relation_reprocess_report.");
  if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
    throw new Error("La herramienta Stage 4B no declara correctamente su frontera de solo lectura.");
  }

  const report = parse(await client.callTool({
    name: "stage4b_relation_reprocess_report",
    arguments: {},
  }));
  const metrics = report.latestPreview?.metrics;
  const total = Object.values(metrics?.classificationCounts ?? {})
    .reduce((sum, value) => sum + Number(value), 0);
  if (report.stage4Authorized !== false
      || report.scope?.availableHistoricalCandidates !== 323
      || metrics?.historicalCandidates !== 323
      || total !== 323
      || metrics?.epistemic?.canonicalFactsCreated !== 0
      || report.guards?.applyPromotesKnowledge !== false
      || report.guards?.sourceCandidatesStillDeferred !== 323
      || report.guards?.humanWorkPerCandidateCreated !== 0
      || report.guards?.commercialEffects !== 0) {
    throw new Error(`Reporte MCP Stage 4B inseguro: ${JSON.stringify(report)}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    tool: tool.name,
    readOnly: true,
    report,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
