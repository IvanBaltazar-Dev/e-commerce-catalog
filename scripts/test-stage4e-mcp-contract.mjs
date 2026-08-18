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
const client = new Client({ name: "bellaroshe-stage4e-acceptance", version: "1.0.0" });

function parse(response, name) {
  if (response.isError) {
    throw new Error(`${name}: ${response.content?.map((item) => item.text ?? "").join(" ")}`);
  }
  const body = response.content?.find((item) => item.type === "text")?.text;
  if (!body) throw new Error(`${name}: respuesta sin JSON.`);
  return JSON.parse(body);
}

async function call(name, args = {}) {
  return parse(await client.callTool({ name, arguments: args }), name);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const readNames = [
    "stage4e_decision_report", "stage4e_decision_queue",
    "stage4e_decision_detail", "stage4e_decision_verify",
  ];
  const commandNames = [
    "stage4e_decision_preview", "stage4e_decision_defer",
    "stage4e_decision_resume", "stage4e_decision_apply",
  ];
  for (const name of readNames) {
    const tool = byName.get(name);
    if (!tool?.annotations?.readOnlyHint || tool.annotations?.destructiveHint) {
      throw new Error(`${name} no está declarado como lectura cerrada.`);
    }
  }
  for (const name of commandNames) {
    const tool = byName.get(name);
    if (!tool || tool.annotations?.readOnlyHint || !tool.annotations?.idempotentHint) {
      throw new Error(`${name} no está declarado como comando idempotente.`);
    }
  }
  if (!byName.get("stage4e_decision_apply")?.annotations?.destructiveHint) {
    throw new Error("El apply no declara su cambio material de estado.");
  }

  const report = await call("stage4e_decision_report");
  const queue = await call("stage4e_decision_queue", {
    status: "pending", limit: 100, offset: 0,
  });
  if (!report.stage4eContractImplemented
      || report.metrics?.decisions !== 18
      || report.metrics?.workItems !== 18
      || report.guards?.oneWorkPerSharedDecision !== true
      || report.guards?.uncertainProductsInheritAutomatically !== false
      || report.guards?.commercialEffects !== 0
      || queue.total !== 18
      || queue.decisions?.length !== 18) {
    throw new Error(`Contrato MCP 4E inesperado: ${JSON.stringify({ report, queue })}`);
  }
  for (const decision of queue.decisions) {
    for (const field of [
      "decision_id", "title", "problem", "recommendation", "solves",
      "uncertain_behavior", "actions", "work_version", "decision_fingerprint",
    ]) {
      if (decision[field] === null || decision[field] === undefined || decision[field] === "") {
        throw new Error(`La decisión ${decision.decision_id} no expone ${field}.`);
      }
    }
    if (JSON.stringify(decision).includes("Evidencia heurística")) {
      throw new Error("La cola volvió a exponer lenguaje técnico rechazado por producto.");
    }
  }
  const gel = queue.decisions.find((decision) =>
    decision.family_code === "CLASS_RULE_PROMOTION" && decision.affected_count === 19);
  if (!gel) throw new Error("No apareció el caso real gel color → gel top.");
  const detail = await call("stage4e_decision_detail", {
    decisionId: gel.decision_id, itemLimit: 2, itemOffset: 0,
  });
  if (detail.affectedTotal !== 19
      || detail.affected?.length !== 2
      || !detail.affected.every((item) => item.evidenceLabel && item.audit)) {
    throw new Error(`Detalle 4E incompleto: ${JSON.stringify(detail)}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    tools: [...readNames, ...commandNames],
    decisions: queue.total,
    representativeDecision: {
      id: gel.decision_id,
      affected: gel.affected_count,
      title: gel.title,
      uncertainBehavior: gel.uncertain_behavior,
    },
    detailItemsRead: detail.affected.length,
    mutationsExecuted: false,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
