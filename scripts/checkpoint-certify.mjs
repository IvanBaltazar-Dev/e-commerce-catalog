/**
 * Genera un corte certificado del presente.
 *
 * El corte del 10 de agosto se queda donde está. Es evidencia histórica y ya
 * demostró tres veces que el carril A se reproduce desde él; regenerarlo para
 * tapar un hueco borraría justamente la prueba.
 *
 * Este guion crea un corte NUEVO, posterior a la campaña, que incluye lo que el
 * histórico no podía incluir: las decisiones terminales, sus causas y su
 * evidencia. Son juicios, no cálculos, y no se «vuelven a ejecutar».
 *
 * Qué entra lo dice el contrato de recuperación, no una lista escrita a mano.
 * Si mañana aparece una tabla con decisiones y nadie la declara, el detector la
 * señala y este corte no la olvida en silencio.
 *
 * Uso: node scripts/checkpoint-certify.mjs --env .env.supabase.local
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "checkpoint-certify" });
if (!isLocal) throw new Error("Un corte certificado solo se genera desde el entorno local.");

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog";
const MANIFEST_PATH = path.join(ROOT, "research", "catalog-master", "local-storage.manifest.json");
const BACKUPS = path.join(ROOT, "backups");

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

const psql = (sql) => docker(
  ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"],
  { input: sql },
).trim();

// El contrato manda. Se certifica lo que debe poder recuperarse, no lo que
// alguien recordó incluir.
const entities = psql(`
  select string_agg(entity, ',' order by entity)
  from public.catalog_recovery_contract
  where in_checkpoint;
`).split(",").map((entity) => entity.trim()).filter(Boolean);

if (!entities.length) throw new Error("El contrato de recuperación está vacío.");

const gaps = psql("select count(*) from public.catalog_recovery_contract_gaps_v1 where blocks_gate_d;");
const undeclared = psql(`
  select coalesce(string_agg(entity, ', '), '')
  from public.catalog_recovery_contract_gaps_v1
  where gap like 'guarda decisiones%';
`);
if (undeclared) {
  throw new Error(`Hay tablas con decisiones sin declarar en el contrato: ${undeclared}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const fileName = `certificado-${stamp}-datos.sql`;
const target = path.join(BACKUPS, fileName);

console.log(`Certificando ${entities.length} entidades declaradas…`);
const dump = docker([
  "exec", CONTAINER, "pg_dump", "-U", "postgres", "-d", "postgres",
  "--data-only",
  ...entities.flatMap((entity) => ["-t", `public.${entity}`]),
]);

fs.mkdirSync(BACKUPS, { recursive: true });
fs.writeFileSync(target, dump, "utf8");

const bytes = fs.statSync(target).size;
const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");

// El manifiesto declara el corte nuevo SIN retirar el histórico: el 10 de
// agosto sigue siendo una evidencia que queremos poder volver a usar.
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
manifest.checkpoint_files = manifest.checkpoint_files ?? [];

const historical = manifest.checkpoint_files.find((file) => file.class === "database_checkpoint_data");
if (historical && !manifest.checkpoint_files.some((file) => file.class === "database_checkpoint_baseline")) {
  manifest.checkpoint_files.push({ ...historical, class: "database_checkpoint_baseline" });
}

manifest.checkpoint_files = manifest.checkpoint_files.filter((file) => file.class !== "database_checkpoint_data");
manifest.checkpoint_files.push({
  path: `backups/${fileName}`,
  class: "database_checkpoint_data",
  bytes,
  sha256: digest,
  certified_at: new Date().toISOString(),
  entities: entities.length,
});

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

// Lo declarado deja de ser deuda: el corte nuevo sí lo lleva.
psql("update public.catalog_recovery_contract set in_baseline_dump = true where in_checkpoint;");

console.log(JSON.stringify({
  corte: `backups/${fileName}`,
  entidades: entities.length,
  bytes,
  sha256: digest,
  huecosQueBloqueabanGateD: Number(gaps),
  historicoConservado: Boolean(historical),
}, null, 2));
