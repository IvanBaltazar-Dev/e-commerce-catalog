import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { catalogResearchPath } from "../../scripts/lib/catalog-research-paths.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "..", "..");
const cutoff = process.env.CATALOG_SNAPSHOT_CUTOFF;
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff || "")) {
  throw new Error("Configura CATALOG_SNAPSHOT_CUTOFF=YYYY-MM-DD para fijar el baseline.");
}
const sql = (await fs.readFile(path.join(root, "export-snapshot.sql"), "utf8"))
  .replaceAll("__CATALOG_SNAPSHOT_CUTOFF__", cutoff);
const pattern = /copy \(([\s\S]*?)\) to '\/tmp\/([^']+)' with \(format csv, header true, encoding 'UTF8'\);/g;
const exports = [...sql.matchAll(pattern)];

if (exports.length !== 4) {
  throw new Error(`Se esperaban 4 exportaciones y se encontraron ${exports.length}.`);
}

const dataRoot = catalogResearchPath(repoRoot, "data");
await fs.mkdir(dataRoot, { recursive: true });

for (const match of exports) {
  const [, query, fileName] = match;
  const statement = `copy (${query}) to stdout with (format csv, header true, encoding 'UTF8');`;
  const result = spawnSync(
    "docker",
    ["exec", "-i", "supabase_db_e-commerce-catalog", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    throw new Error(`Falló ${fileName}: ${result.stderr || result.stdout}`);
  }

  await fs.writeFile(path.join(dataRoot, fileName), result.stdout, "utf8");
  console.log(`${fileName}: ${result.stdout.split(/\r?\n/).filter(Boolean).length - 1} filas`);
}
