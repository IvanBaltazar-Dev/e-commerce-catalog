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
const client = new Client({ name: "bellaroshe-stage4g-acceptance", version: "1.0.0" });

function parse(response) {
  if (response.isError) throw new Error(response.content?.map((item) => item.text ?? "").join(" "));
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("El MCP no devolvió contenido JSON.");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) =>
    candidate.name === "stage4g_controlled_expansion_report");
  if (!tool) throw new Error("Falta la herramienta stage4g_controlled_expansion_report.");
  if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
    throw new Error("La herramienta 4G no declara correctamente su frontera de solo lectura.");
  }

  const report = parse(await client.callTool({
    name: "stage4g_controlled_expansion_report",
    arguments: {},
  }));
  if (report.stage4Authorized !== false || report.passes !== true
      || report.metrics?.manifests !== 2 || report.metrics?.systems !== 2
      || report.metrics?.domains !== 2 || report.metrics?.coveredDecisions !== 8
      || report.metrics?.canonicalLeaks !== 0
      || report.guards?.productMembershipsCreated !== 0
      || report.guards?.commercialEffects !== 0) {
    throw new Error(`Reporte MCP 4G inseguro: ${JSON.stringify(report)}`);
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
