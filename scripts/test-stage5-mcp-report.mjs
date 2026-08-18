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
const client = new Client({ name: "bellaroshe-stage5-acceptance", version: "1.0.0" });

function parse(response) {
  if (response.isError) throw new Error(response.content?.map((item) => item.text ?? "").join(" "));
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("El MCP no devolvió contenido JSON.");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "catalog_campaign_report");
  if (!tool) throw new Error("Falta la herramienta catalog_campaign_report.");
  if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
    throw new Error("El reporte de campaña no declara correctamente su frontera de solo lectura.");
  }

  const report = parse(await client.callTool({
    name: "catalog_campaign_report",
    arguments: {},
  }));
  const steps = new Map((report.steps ?? []).map((step) => [step.step, step.status]));
  const required = [
    "research_delta", "semantic_certification", "review_reprocess",
    "relation_reprocess", "decisions_sync", "controlled_expansion",
    "graph_sync", "graph_verify", "readiness",
  ];
  if (report.contractVersion !== "catalog-intelligence-campaign-v1"
      || report.status !== "succeeded" || report.passes !== true
      || required.some((step) => !["succeeded", "skipped"].includes(steps.get(step)))
      || report.graphVerification?.ok !== true
      || report.guards?.commercialFingerprintUnchanged !== true
      || report.guards?.humanDecisionsApplied !== 0
      || report.guards?.productsPublished !== 0
      || report.guards?.pricesAssigned !== 0
      || report.guards?.stockAssigned !== 0) {
    throw new Error(`Reporte MCP de Etapa 5 inseguro: ${JSON.stringify(report)}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    tool: tool.name,
    readOnly: true,
    campaignId: report.campaignId,
    ownerSummary: report.ownerSummary,
    stepCount: report.steps.length,
    guards: report.guards,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
