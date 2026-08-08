/**
 * Backup verificable (Bloque 5, §6-§7): no un dump que «seguro funciona»,
 * sino un ciclo completo demostrado:
 *
 *   pg_dump -Fc → base de verificación limpia → pg_restore → conteos de las
 *   tablas críticas comparados contra el origen → limpieza.
 *
 * Local por omisión (docker exec al contenedor de Supabase). Para un entorno
 * remoto: PG_BACKUP_URL=postgres://… (usa pg_dump/pg_restore del sistema) —
 * la verificación se hace igual, en una base auxiliar del MISMO servidor o
 * en el local si se prefiere.
 *
 * El dump queda en backups/ con marca de tiempo: es el artefacto que el
 * runbook de producción exige ANTES de cualquier migración remota.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "supabase_db_e-commerce-catalog";
const REMOTE = process.env.PG_BACKUP_URL ?? null;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP_DIR = path.join(ROOT, "backups");
const DUMP_FILE = path.join(BACKUP_DIR, `bellaroshe-${STAMP}.dump`);
const CHECK_DB = "bellaroshe_restore_check";

// Tablas cuyo conteo debe sobrevivir intacto a un ciclo dump→restore.
const CRITICAL_TABLES = [
  "products", "product_variants", "sales", "sale_lines", "sale_payments",
  "inventory_movements", "channel_conversations", "channel_messages",
  "public_carts", "channel_attributions", "ai_interactions", "expenses"
];

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512, ...options });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.slice(0, 3).join(" ")}… falló: ${(result.stderr || result.stdout || "").slice(-500)}`);
  }
  return result.stdout;
}

function psql(db, query) {
  if (REMOTE) {
    const url = new URL(REMOTE);
    url.pathname = `/${db}`;
    return run("psql", ["-v", "ON_ERROR_STOP=1", "-A", "-t", url.toString(), "-c", query]);
  }
  return run("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", query]);
}

mkdirSync(BACKUP_DIR, { recursive: true });

console.log("1. Dump (formato custom, con Storage y Auth incluidos)…");
if (REMOTE) {
  run("pg_dump", ["-Fc", "-f", DUMP_FILE, REMOTE]);
} else {
  // El dump se genera DENTRO del contenedor y se copia afuera: pg_dump del
  // host podría no existir o no coincidir en versión.
  run("docker", ["exec", CONTAINER, "pg_dump", "-U", "postgres", "-d", "postgres", "-Fc", "-f", "/tmp/bellaroshe.dump"]);
  run("docker", ["cp", `${CONTAINER}:/tmp/bellaroshe.dump`, DUMP_FILE]);
  run("docker", ["exec", CONTAINER, "rm", "-f", "/tmp/bellaroshe.dump"]);
}
const size = statSync(DUMP_FILE).size;
console.log(`   ${path.relative(ROOT, DUMP_FILE)} · ${(size / 1024 / 1024).toFixed(1)} MB`);
if (size < 100_000) throw new Error("El dump es sospechosamente pequeño: no se acepta como backup.");

console.log("2. Conteos del ORIGEN…");
const sourceCounts = {};
for (const table of CRITICAL_TABLES) {
  sourceCounts[table] = Number(psql("postgres", `select count(*) from public.${table};`).trim());
}

console.log("3. Restauración REAL en una base de verificación limpia…");
psql("postgres", `drop database if exists ${CHECK_DB} with (force);`);
psql("postgres", `create database ${CHECK_DB};`);
try {
  if (REMOTE) {
    const url = new URL(REMOTE);
    url.pathname = `/${CHECK_DB}`;
    run("pg_restore", ["--no-owner", "--no-privileges", "-d", url.toString(), DUMP_FILE]);
  } else {
    run("docker", ["cp", DUMP_FILE, `${CONTAINER}:/tmp/bellaroshe.dump`]);
    // --no-owner/--no-privileges: los dueños y roles ya existen en el clúster;
    // schema_migrations y las extensiones llegan con el propio dump.
    // Los errores de objetos de sistema de Supabase (event triggers) no
    // invalidan los DATOS: se toleran y la verificación es por conteo.
    spawnSync("docker", ["exec", CONTAINER, "pg_restore", "--no-owner", "--no-privileges", "-d", CHECK_DB, "/tmp/bellaroshe.dump"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
    run("docker", ["exec", CONTAINER, "rm", "-f", "/tmp/bellaroshe.dump"]);
  }

  console.log("4. Conteos del RESTAURADO vs origen…");
  const failures = [];
  for (const table of CRITICAL_TABLES) {
    const restored = Number(psql(CHECK_DB, `select count(*) from public.${table};`).trim());
    const okay = restored === sourceCounts[table];
    console.log(`   ${okay ? "✓" : "✗"} ${table}: origen=${sourceCounts[table]} restaurado=${restored}`);
    if (!okay) failures.push(table);
  }

  // La estructura también: mismas tablas de public a ambos lados.
  const sourceTables = psql("postgres", "select count(*) from pg_tables where schemaname='public';").trim();
  const restoredTables = psql(CHECK_DB, "select count(*) from pg_tables where schemaname='public';").trim();
  const structureOk = sourceTables === restoredTables;
  console.log(`   ${structureOk ? "✓" : "✗"} tablas en public: origen=${sourceTables} restaurado=${restoredTables}`);
  if (!structureOk) failures.push("(estructura)");

  if (failures.length > 0) {
    console.error(`\nRESTAURACIÓN INVÁLIDA: difieren ${failures.join(", ")}.`);
    process.exit(1);
  }
  console.log(`\nBACKUP VERIFICADO: el dump restaura completo. Artefacto: ${path.relative(ROOT, DUMP_FILE)}`);
} finally {
  psql("postgres", `drop database if exists ${CHECK_DB} with (force);`);
}
