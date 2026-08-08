/**
 * Auditoría estructural de seguridad (Bloque 5, §8) — repetible en local,
 * staging y producción. No asume que «local pasa ⇒ remoto pasa»: interroga el
 * catálogo de PostgreSQL del entorno que se le indique.
 *
 *   · Local (por omisión):   docker exec al contenedor de Supabase local.
 *   · Remoto:                PG_AUDIT_URL=postgres://… (usa psql del sistema).
 *
 * Qué comprueba:
 *   1. RLS activa en TODA tabla de public (cero excepciones).
 *   2. Privilegios de anon sobre tablas — solo la lista blanca del catálogo
 *      público; jamás costo, caja, margen, conversaciones ni IA.
 *   3. Funciones ejecutables por anon — solo los contratos públicos declarados.
 *   4. SECURITY DEFINER sin search_path fijado — prohibido.
 *   5. service_role/secretos en el bundle del CLIENTE (.next/static) — cero.
 *
 * El resultado se compara contra security/baseline.json (versionado): todo lo
 * que no esté en la línea base es un fallo. Cambiar la línea base es un acto
 * revisado en commit, no un ajuste silencioso.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "supabase_db_e-commerce-catalog";
const BASELINE_PATH = path.join(ROOT, "security", "baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const TARGET = process.env.PG_AUDIT_URL ? "remoto (PG_AUDIT_URL)" : `local (docker: ${CONTAINER})`;

function sql(query) {
  // Local (sin PG_AUDIT_URL): psql por el contenedor. Remoto: prefiere el psql
  // del HOST y, si no existe (ENOENT), lo enruta por el psql del CONTENEDOR —
  // que sí alcanza la red. Así la auditoría remota corre en cualquier máquina
  // con el prerequisito documentado (Docker + stack local), sin exigir psql en
  // el PATH del host.
  // Separador de campos: SOH (\x01), un byte que jamás aparece en un nombre de
  // objeto — así las columnas se parten sin ambigüedad.
  const SEP = "\x01";
  const url = process.env.PG_AUDIT_URL;
  let result;
  if (!url) {
    result = spawnSync("docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", SEP, "-c", query],
      { encoding: "utf8" });
  } else {
    result = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-A", "-t", "-F", SEP, url, "-c", query], { encoding: "utf8" });
    if (result.error && result.error.code === "ENOENT") {
      // URL, consulta y separador por variable de entorno: así el `sh -c` no
      // mutila los saltos de línea de la query ni el byte de control.
      result = spawnSync("docker",
        ["exec", "-i", "-e", `PGURL=${url}`, "-e", `PGQUERY=${query}`, "-e", `PGSEP=${SEP}`, CONTAINER, "sh", "-c",
         'psql "$PGURL" -v ON_ERROR_STOP=1 -A -t -F "$PGSEP" -c "$PGQUERY"'],
        { encoding: "utf8" });
    }
  }
  if (result.error) throw new Error(`Consulta fallida: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Consulta fallida: ${result.stderr || result.stdout}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(SEP));
}

// --- 1. RLS en todas las tablas de public ----------------------------------
const rlsDisabled = sql(`
  select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  order by 1;
`).map(([table]) => table);

// --- 2. Privilegios de anon sobre tablas -----------------------------------
const anonTablePrivs = sql(`
  select c.relname, p.privilege
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, p.privilege)
  order by 1, 2;
`).map(([table, privilege]) => `${table}:${privilege}`);

// --- 3. Funciones DEL PRODUCTO ejecutables por anon -------------------------
// Las internas de extensiones (btree_gist, pg_trgm) pertenecen a
// supabase_admin, son maquinaria de índices y quedan fuera del contrato.
const anonExecutableFunctions = sql(`
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and has_function_privilege('anon', p.oid, 'execute')
    and not exists (
      select 1 from pg_depend dep
      where dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e'
    )
  order by 1;
`).map(([fn]) => fn);

// --- 4. SECURITY DEFINER sin search_path ------------------------------------
const definerWithoutSearchPath = sql(`
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
    ))
  order by 1;
`).map(([fn]) => fn);

// --- 5. Secretos en el bundle del cliente -----------------------------------
const bundleFindings = [];
const staticDir = path.join(ROOT, ".next", "static");
if (existsSync(staticDir)) {
  const needles = ["SUPABASE_SERVICE_ROLE_KEY", "sb_secret_", "ANTHROPIC_API_KEY", "APP_SECRET", "service_role"];
  const stack = [staticDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { stack.push(full); continue; }
      if (!/\.(js|css|json|txt)$/.test(entry)) continue;
      const content = readFileSync(full, "utf8");
      for (const needle of needles) {
        if (content.includes(needle)) {
          bundleFindings.push(`${path.relative(ROOT, full)} contiene «${needle}»`);
        }
      }
    }
  }
} else {
  bundleFindings.push("(.next/static ausente: corre `npm run build` antes para auditar el bundle)");
}

const snapshot = { rlsDisabled, anonTablePrivs, anonExecutableFunctions, definerWithoutSearchPath };

if (WRITE_BASELINE) {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Línea base escrita en security/baseline.json — REVÍSALA A MANO antes de commitear.`);
  console.log(`  RLS desactivada: ${rlsDisabled.length} · anon sobre tablas: ${anonTablePrivs.length}`);
  console.log(`  anon ejecuta: ${anonExecutableFunctions.length} funciones · DEFINER sin search_path: ${definerWithoutSearchPath.length}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error("No existe security/baseline.json. Genera y revisa la línea base con --write-baseline.");
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

const drift = (current, base) => current.filter((item) => !base.includes(item));
const removed = (current, base) => base.filter((item) => !current.includes(item));

const violations = [];
if (rlsDisabled.length > 0) {
  violations.push(`RLS DESACTIVADA en: ${rlsDisabled.join(", ")}`);
}
for (const item of drift(anonTablePrivs, baseline.anonTablePrivs)) {
  violations.push(`anon ganó privilegio de tabla fuera de la línea base: ${item}`);
}
for (const item of drift(anonExecutableFunctions, baseline.anonExecutableFunctions)) {
  violations.push(`anon puede ejecutar una función fuera de la línea base: ${item}`);
}
for (const item of drift(definerWithoutSearchPath, baseline.definerWithoutSearchPath)) {
  violations.push(`SECURITY DEFINER sin search_path: ${item}`);
}
for (const finding of bundleFindings) {
  violations.push(`Bundle del cliente: ${finding}`);
}

const shrunk = [
  ...removed(anonTablePrivs, baseline.anonTablePrivs).map((i) => `anon perdió (bien): ${i}`),
  ...removed(anonExecutableFunctions, baseline.anonExecutableFunctions).map((i) => `anon ya no ejecuta (bien): ${i}`)
];

mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
const report = [
  `# Auditoría estructural de seguridad · ${TARGET}`,
  "",
  `| Control | Resultado |`,
  `|---|---|`,
  `| Tablas public sin RLS | ${rlsDisabled.length === 0 ? "✓ cero" : `✗ ${rlsDisabled.length}`} |`,
  `| Privilegios de anon sobre tablas | ${anonTablePrivs.length} (línea base: ${baseline.anonTablePrivs.length}) |`,
  `| Funciones ejecutables por anon | ${anonExecutableFunctions.length} (línea base: ${baseline.anonExecutableFunctions.length}) |`,
  `| DEFINER sin search_path | ${definerWithoutSearchPath.length === 0 ? "✓ cero" : `✗ ${definerWithoutSearchPath.length}`} |`,
  `| Secretos en bundle de cliente | ${bundleFindings.length === 0 ? "✓ cero" : `✗ ${bundleFindings.length}`} |`,
  "",
  violations.length === 0 ? "## RESULTADO: SIN VIOLACIONES" : "## RESULTADO: VIOLACIONES",
  ...violations.map((violation) => `- ✗ ${violation}`),
  ...(shrunk.length ? ["", "### Recortes respecto a la línea base (revisar y actualizar baseline)", ...shrunk.map((s) => `- ${s}`)] : []),
  ""
].join("\n");
writeFileSync(path.join(ROOT, "test-results", "security-audit.md"), report);

console.log(report);
process.exit(violations.length === 0 ? 0 : 1);
