/**
 * Gate de reconstrucción total (Bloque 5, §2).
 *
 * Sobre una base COMPLETAMENTE vacía prueba que el repositorio, por sí solo,
 * reconstruye el sistema entero:
 *
 *   manifiesto → 0001→0108 → checkpoint de datos → seeds mínimos
 *   → pgTAP completo → integrales B1/B2/B3/B4
 *   → concurrencias → typecheck → lint → build de producción
 *
 * No acepta una base previamente usada: el primer paso ES el reset. La
 * evidencia queda en test-results/gate-rebuild-<n>.md con duración y estado
 * por paso. Úsese dos veces consecutivas para cazar fixtures no reentrantes.
 *
 * Requisito: el servidor web (bellaroshe-prod o dev) corriendo — las
 * integrales B3 y las superficies públicas se prueban por HTTP real.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
// Las integrales antiguas usan E2E_BASE_URL y las superficies nuevas usan
// UI_BASE_URL. El gate tiene un solo servidor y propaga esa identidad a ambas.
process.env.E2E_BASE_URL ??= BASE_URL;

const STEPS = [
  { name: "Artefactos locales del checkpoint verificados", cmd: "npm", args: ["run", "catalog:storage:verify"] },
  { name: "Base vacía → migraciones 0001–0108 + seed base", cmd: "npx", args: ["supabase", "db", "reset", "--local"] },
  { name: "Restaurar catálogo, investigación y Mesa del checkpoint", cmd: "npm", args: ["run", "checkpoint:restore:local"] },
  { name: "Fixtures DEMO aislados para pruebas", cmd: "npm", args: ["run", "seed:test-catalog"] },
  { name: "Seeds mínimos de operación", cmd: "npm", args: ["run", "seed:demo-operation"] },
  { name: "Fixtures sintéticos del Universo de Referencia", cmd: "npm", args: ["run", "stage1:fixtures"] },
  { name: "pgTAP completo", cmd: "npx", args: ["supabase", "test", "db", "--local"] },
  { name: "Neo4j Community local disponible", cmd: "npm", args: ["run", "neo4j:up"] },
  { name: "Graph Projector rebuild/sync/verify", cmd: "npm", args: ["run", "test:graph-projector"] },
  { name: "Integral B1 · contratos del catálogo V2", cmd: "npm", args: ["run", "test:contracts"] },
  { name: "Integral B2 · circuito económico", cmd: "npm", args: ["run", "test:block2"] },
  { name: "Integral B3 · omnicanal de punta a punta", cmd: "npm", args: ["run", "test:block3"] },
  { name: "Integral B4 · inteligencia comercial e IA", cmd: "npm", args: ["run", "test:block4"] },
  { name: "Unitaria del intérprete IA", cmd: "npm", args: ["run", "test:ai-matching"] },
  { name: "Concurrencia · inventario", cmd: "npm", args: ["run", "test:inventory-concurrency"] },
  { name: "Concurrencia · ventas y caja", cmd: "npm", args: ["run", "test:sales-concurrency"] },
  { name: "Concurrencia · omnicanal", cmd: "npm", args: ["run", "test:omnichannel-concurrency"] },
  { name: "Typecheck", cmd: "npx", args: ["tsc", "--noEmit"] },
  // El mismo comando que se teclea a mano: `next lint` está deprecado, muere en
  // Next 16 y solo miraba los directorios de fuente de la app, así que scripts/
  // nunca entró al gate.
  { name: "Lint", cmd: "npm", args: ["run", "lint"] },
  { name: "Build de producción", cmd: "npm", args: ["run", "build"] }
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, seconds: Math.round((Date.now() - startedAt) / 1000), out });
    });
  });
}

// El servidor tiene que estar arriba ANTES de empezar: fallar al minuto 20
// por eso sería un gate mentiroso.
try {
  const ping = await fetch(`${BASE_URL}/api/catalog?page=1&pageSize=1`).catch(() => null);
  if (!ping || !ping.ok) {
    console.error(`El servidor web no responde en ${BASE_URL}. Levanta bellaroshe-prod y reintenta.`);
    process.exit(2);
  }
} catch {
  console.error(`El servidor web no responde en ${BASE_URL}.`);
  process.exit(2);
}

mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
const previousRuns = existsSync(path.join(ROOT, "test-results"))
  ? readdirSync(path.join(ROOT, "test-results")).filter((f) => f.startsWith("gate-rebuild-")).length
  : 0;
const runNumber = previousRuns + 1;

console.log(`\nGATE DE RECONSTRUCCIÓN TOTAL · corrida #${runNumber}\nBase: se vacía AHORA. Servidor: ${BASE_URL}\n`);

const report = [];
let failed = false;
let demoFixturesLoaded = false;

for (const step of STEPS) {
  process.stdout.write(`▶ ${step.name} … `);
  const result = await run(step.cmd, step.args);
  const ok = result.code === 0;
  console.log(ok ? `✓ ${result.seconds}s` : `✗ FALLÓ (${result.seconds}s)`);
  report.push({ name: step.name, ok, seconds: result.seconds, tail: result.out.split("\n").slice(-12).join("\n") });
  if (ok && step.name === "Fixtures DEMO aislados para pruebas") demoFixturesLoaded = true;
  if (!ok) {
    failed = true;
    console.error(`\n--- salida final de «${step.name}» ---\n${result.out.split("\n").slice(-30).join("\n")}\n`);
    break; // Un gate no sigue sobre una base a medias: se corta y se corrige.
  }
}

if (demoFixturesLoaded) {
  process.stdout.write("▶ Retirar fixtures DEMO del catálogo operativo … ");
  const cleanup = await run("npm", ["run", "cleanup:test-catalog"]);
  const ok = cleanup.code === 0;
  console.log(ok ? `✓ ${cleanup.seconds}s` : `✗ FALLÓ (${cleanup.seconds}s)`);
  report.push({
    name: "Retirar fixtures DEMO del catálogo operativo",
    ok,
    seconds: cleanup.seconds,
    tail: cleanup.out.split("\n").slice(-12).join("\n"),
  });
  if (!ok) failed = true;
}

const lines = [
  `# Gate de reconstrucción total · corrida #${runNumber}`,
  "",
  `Servidor: ${BASE_URL}`,
  "",
  "| Paso | Estado | Duración |",
  "|---|---|---|",
  ...report.map((step) => `| ${step.name} | ${step.ok ? "✓" : "✗ FALLÓ"} | ${step.seconds}s |`),
  "",
  failed ? "## RESULTADO: FALLÓ" : "## RESULTADO: RECONSTRUCCIÓN COMPLETA EN VERDE",
  ""
];
if (failed) {
  const failedStep = report.find((step) => !step.ok) ?? report[report.length - 1];
  lines.push(`### Cola de salida del paso fallido (${failedStep.name})`, "```", failedStep.tail, "```");
}

const evidencePath = path.join(ROOT, "test-results", `gate-rebuild-${runNumber}.md`);
writeFileSync(evidencePath, lines.join("\n"));
console.log(`\nEvidencia: test-results/gate-rebuild-${runNumber}.md`);
process.exit(failed ? 1 : 0);
