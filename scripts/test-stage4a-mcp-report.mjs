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
const client = new Client({ name: "bellaroshe-stage4a-acceptance", version: "1.0.0" });

function parse(response) {
  if (response.isError) throw new Error(response.content?.map((item) => item.text ?? "").join(" "));
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("El MCP no devolvio contenido JSON.");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "stage4a_system_class_report");
  if (!tool) throw new Error("Falta la herramienta stage4a_system_class_report.");
  if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
    throw new Error("La herramienta Stage 4A no declara correctamente su frontera de solo lectura.");
  }

  const report = parse(await client.callTool({
    name: "stage4a_system_class_report",
    arguments: {},
  }));
  if (report.stage4Authorized !== false
      || report.historicalRelations?.untouched !== 323
      || report.historicalRelations?.analyzedThisCut !== 0
      || report.epistemic?.canonicalFactsCreated !== 0
      || report.guards?.sameSystemImpliesCompatibility !== false
      || report.guards?.priceChanged !== false
      || report.guards?.stockChanged !== false
      || report.guards?.publicationChanged !== false) {
    throw new Error(`Reporte MCP Stage 4A inseguro: ${JSON.stringify(report)}`);
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
