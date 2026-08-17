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
const client = new Client({ name: "bellaroshe-stage4c-acceptance", version: "1.0.0" });

function parse(response) {
  if (response.isError) throw new Error(response.content?.map((item) => item.text ?? "").join(" "));
  const body = response.content?.find((item) => item.type === "text")?.text;
  if (!body) throw new Error("El MCP no devolvio contenido JSON.");
  return JSON.parse(body);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const reportTool = listed.tools.find((tool) => tool.name === "stage4c_decision_report");
  const queueTool = listed.tools.find((tool) => tool.name === "stage4c_decision_queue");
  for (const tool of [reportTool, queueTool]) {
    if (!tool) throw new Error("Falta una herramienta MCP de Stage 4C.");
    if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
      throw new Error(`La herramienta ${tool.name} no declara su frontera de solo lectura.`);
    }
  }

  const report = parse(await client.callTool({ name: reportTool.name, arguments: {} }));
  const queue = parse(await client.callTool({
    name: queueTool.name,
    arguments: { limit: 100, offset: 0 },
  }));
  if (report.stage4Authorized !== false
      || report.metrics?.familyCount !== 3
      || report.metrics?.decisionCount !== 18
      || report.metrics?.automaticEvidenceDebtExcluded !== 60
      || report.guards?.reactInterpretsRuleCode !== false
      || report.guards?.humanWorkPerCandidateCreated !== 0
      || queue.total !== 18
      || queue.decisions?.length !== 18) {
    throw new Error(`Contrato MCP Stage 4C inseguro: ${JSON.stringify({ report, queue })}`);
  }
  for (const decision of queue.decisions) {
    for (const field of [
      "decision_id", "title", "business_summary", "what_was_found",
      "why_human_is_needed", "system_recommendation", "affected_count",
      "affected_entity_types", "evidence_summary", "impact_preview",
      "available_actions", "fingerprint",
    ]) {
      if (decision[field] === null || decision[field] === undefined || decision[field] === "") {
        throw new Error(`La decision ${decision.decision_id} no expone ${field}.`);
      }
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    tools: [reportTool.name, queueTool.name],
    readOnly: true,
    report,
    decisionCount: queue.total,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
