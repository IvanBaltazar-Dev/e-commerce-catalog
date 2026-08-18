/**
 * Reconstruye el corte local de Etapa 0 sobre una base ya migrada y vacía.
 *
 * El SQL pesado permanece fuera de Git. Su identidad (ruta lógica, tamaño y
 * SHA-256) vive en local-storage.manifest.json. Solo se reproducen las tablas
 * maestras del catálogo; el staging se regenera desde los artefactos RAW/derivados.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "research", "catalog-master", "local-storage.manifest.json");
const MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", "0091_acrylic_knowledge_vertical.sql");
const CORRECTION_MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", "0093_acrylic_deep_research_corrections.sql");
const WORDING_MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", "0095_acrylic_gap_wording_hardening.sql");
const QUEUES_MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", "0096_acrylic_reconciliation_work_queues.sql");
const IDENTITY_REDIRECT_MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", "0100_catalog_review_identity_redirect.sql");
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog";

const CATALOG_TABLES = new Set([
  "attribute_definitions",
  "attribute_options",
  "attribute_templates",
  "media_assets",
  "brands",
  "brand_product_families",
  "catalog_metadata",
  "categories",
  "product_lines",
  "color_shades",
  "suppliers",
  "products",
  "product_variants",
  "product_suppliers",
  "price_lists",
  "product_attribute_values",
  "product_images",
  "product_line_product_families",
  "product_media",
  "product_relations",
  "template_attributes",
  "template_attribute_comparisons",
  "template_attribute_conditions",
  "variant_attribute_values",
  "variant_prices",
  "wholesale_rules",
]);

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} falló:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function psql(sql) {
  return run(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"],
    { input: sql },
  );
}

function extractStatement(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`No se pudo extraer el bloque canónico: ${start}`);
  return source.slice(startIndex, endIndex).trim();
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const expected = (manifest.checkpoint_files ?? []).find((file) => file.class === "database_checkpoint_data");
if (!expected) throw new Error("El manifiesto no declara database_checkpoint_data.");

const backupPath = path.resolve(process.env.CATALOG_CHECKPOINT_DATA_SQL || path.join(ROOT, expected.path));
if (!fs.existsSync(backupPath)) throw new Error(`Falta el volcado requerido: ${backupPath}`);
const stat = fs.statSync(backupPath);
const digest = sha256(backupPath);
if (stat.size !== expected.bytes || digest !== expected.sha256) {
  throw new Error(`El volcado no coincide con el checkpoint: bytes=${stat.size}, sha256=${digest}`);
}

const dump = fs.readFileSync(backupPath, "utf8");
const copyPattern = /^COPY public\.([a-z0-9_]+) \([^\r\n]+\) FROM stdin;\r?\n[\s\S]*?^\\\.\r?$/gm;
const blocks = [];
const foundTables = new Set();
for (const match of dump.matchAll(copyPattern)) {
  if (!CATALOG_TABLES.has(match[1])) continue;
  blocks.push(match[0]);
  foundTables.add(match[1]);
}
const missingTables = [...CATALOG_TABLES].filter((table) => !foundTables.has(table));
if (missingTables.length) throw new Error(`El volcado no contiene: ${missingTables.join(", ")}`);

const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
const memberships = extractStatement(migration, "with memberships(product_code, class_code, evidence_key) as (", "\n\nwith assignments(product_code, stage_code, role_code, required_role, evidence_key) as (");
const assignments = extractStatement(migration, "with assignments(product_code, stage_code, role_code, required_role, evidence_key) as (", "\n\n-- La regla conceptual");
const gaps = extractStatement(migration, "with acrylic as (\n  select id from public.catalog_systems where code = 'ACRYLIC'\n), gaps(", "\n\ncreate or replace view public.catalog_acrylic_knowledge_gap_queue_v1");

const tableArray = [...CATALOG_TABLES].map((table) => `'${table}'`).join(", ");
const clearStatements = [...CATALOG_TABLES]
  .reverse()
  .map((table) => `delete from public.${table};`)
  .join("\n");
const restoreSql = `
begin;
set local session_replication_role = replica;
-- DELETE con los triggers de FK suspendidos evita que TRUNCATE CASCADE borre
-- fuentes, evidencia y contratos sembrados por las migraciones 0074–0100.
delete from public.catalog_facet_presence;
delete from public.product_catalog_projection;
delete from public.variant_search_codes;
delete from public.variant_search_projection;
${clearStatements}
${blocks.join("\n\n")}

-- El UUID de la empresa nace en cada reset; los proveedores del corte se
-- enlazan de nuevo a la empresa canónica sin alterar su propia identidad.
update public.suppliers
set company_id = (select id from public.companies order by created_at, id limit 1);

set local session_replication_role = origin;

-- El checkpoint reemplaza attribute_templates con triggers suspendidos. La
-- capa semantica resincroniza sus perfiles por codigo, nunca por UUID historico.
select public.sync_all_catalog_technical_type_profiles_v1();

-- Reasocia las fuentes oficiales cuyos brand_id quedaron nulos por el TRUNCATE.
update public.catalog_sources source
set brand_id = brand.id
from public.brands brand
where (source.source_key, lower(brand.name)) in (
  ('masglo-es-official', 'masglo'),
  ('admiss-co-official', 'admiss'),
  ('acrylove-official', 'acrylove'),
  ('mc-nails-mx-official', 'mc nails'),
  ('cherimoya-pe-official', 'cherimoya'),
  ('bigen-usa-official', 'bigen'),
  ('acrylove-official-education', 'acrylove'),
  ('mc-nails-official-acrylic', 'mc nails'),
  ('masglo-official-acrylic', 'masglo'),
  ('mia-secret-official-acrylic', 'mia secret'),
  ('cherimoya-official-acrylic', 'cherimoya')
);

-- 0113 valida el contrato universal con referencias reales no comerciales.
-- El checkpoint reemplaza brands con UUID historicos, por lo que se religa la
-- referencia del fixture a la marca restaurada sin adoptarla al catalogo.
update public.catalog_reference_products reference
set brand_id = brand.id, updated_at = now()
from public.brands brand
where reference.reference_key like 'stage4a-acrylove-%'
  and lower(brand.name) = 'acrylove';

-- Ajusta secuencias serial/identity de las tablas restauradas.
do $checkpoint$
declare
  sequence_column record;
  sequence_name text;
  maximum_value bigint;
begin
  for sequence_column in
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (${tableArray})
      and (column_default like 'nextval(%' or is_identity = 'YES')
  loop
    sequence_name := pg_get_serial_sequence(
      format('public.%I', sequence_column.table_name),
      sequence_column.column_name
    );
    if sequence_name is not null then
      execute format(
        'select coalesce(max(%I), 0) from public.%I',
        sequence_column.column_name,
        sequence_column.table_name
      ) into maximum_value;
      perform setval(sequence_name, greatest(maximum_value, 1), maximum_value > 0);
    end if;
  end loop;
end;
$checkpoint$;

${memberships}
${assignments}
${gaps}

do $checkpoint$
begin
  if to_regprocedure('public.rebuild_variant_search_projection()') is not null then
    perform public.rebuild_variant_search_projection();
  end if;
  if to_regprocedure('public.rebuild_variant_search_codes()') is not null then
    perform public.rebuild_variant_search_codes();
  end if;
  if to_regprocedure('public.rebuild_product_catalog_search()') is not null then
    perform public.rebuild_product_catalog_search();
  end if;
  if to_regprocedure('public.rebuild_product_catalog_price()') is not null then
    perform public.rebuild_product_catalog_price();
  end if;
  if to_regprocedure('public.rebuild_catalog_facet_presence()') is not null then
    perform public.rebuild_catalog_facet_presence();
  end if;
end;
$checkpoint$;
commit;
`;

console.log(`Restaurando ${blocks.length} tablas desde un volcado verificado (${digest.slice(0, 12)}…).`);
psql(restoreSql);

// El checkpoint histórico contiene cinco productos DEMO que ya no forman
// parte del catálogo operativo. Se retiran antes de regenerar staging y Mesa;
// los fixtures de pruebas se cargan de forma explícita por sus propios gates.
psql(`
begin;
delete from public.wholesale_rules
where product_id in (
  select product.id from public.products product left join public.brands brand on brand.id=product.brand_id
  where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional'
) or variant_id in (
  select variant.id from public.product_variants variant join public.products product on product.id=variant.product_id
  left join public.brands brand on brand.id=product.brand_id
  where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional'
);
delete from public.product_relations
where source_product_id in (
  select product.id from public.products product left join public.brands brand on brand.id=product.brand_id
  where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional'
) or target_product_id in (
  select product.id from public.products product left join public.brands brand on brand.id=product.brand_id
  where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional'
);
delete from public.products product using public.brands brand
where product.brand_id=brand.id
  and (product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional');
delete from public.media_assets media
where (media.storage_path like 'demo/%' or media.metadata->>'demo'='true')
  and not exists (select 1 from public.product_media association where association.media_asset_id=media.id)
  and not exists (select 1 from public.brands brand where brand.logo_media_id=media.id);
delete from public.brands brand where brand.slug='demo-professional'
  and not exists (select 1 from public.products product where product.brand_id=brand.id);
commit;
`);

// 0093 retiró tres asignaciones demasiado amplias y 0095 endureció una
// brecha. Se reaplican porque el replay canónico de 0091 acaba de materializar
// filas que no existían cuando las migraciones corrieron sobre la base vacía.
psql(fs.readFileSync(CORRECTION_MIGRATION_PATH, "utf8"));
psql(fs.readFileSync(WORDING_MIGRATION_PATH, "utf8"));
psql(fs.readFileSync(QUEUES_MIGRATION_PATH, "utf8"));

console.log("Regenerando staging, reconciliación y Mesa desde almacenamiento administrado.");
run(process.execPath, ["scripts/catalog-enrichment-stage.mjs", "--env", ".env.supabase.local"]);

// La corrección de alcance de AUSENTE depende de la candidata que acaba de
// generar el staging. Solo se repite el bloque de datos de 0100, no su trigger.
const identityRedirectMigration = fs.readFileSync(IDENTITY_REDIRECT_MIGRATION_PATH, "utf8");
const identityScopeCorrection = extractStatement(
  identityRedirectMigration,
  "do $migration$",
  "\n\ncommit;",
);
psql(`${identityScopeCorrection}\n`);

// 4B–4E dependen de la cohorte comercial restaurada, que por diseño llega
// después de las migraciones durante un reset. Reconstruye el preview analítico
// estable y, a partir de él, los 18 expedientes agrupados de la Mesa. Ninguna
// decisión humana se aplica aquí.
psql(`
do $checkpoint$
declare relation_preview jsonb;
begin
  relation_preview := public.preview_catalog_relation_reprocess_v1(
    'checkpoint-stage4b-preview-v2-no-demo', 316
  );
  perform public.apply_catalog_relation_reprocess_v1(
    (relation_preview->>'previewId')::uuid,
    relation_preview->>'previewFingerprint',
    'checkpoint-stage4b-apply-v2-no-demo'
  );
  perform public.sync_catalog_relation_decisions_v1();
end;
$checkpoint$;
`);

const counts = psql(`
select jsonb_build_object(
  'products', (select count(*) from public.products),
  'variants', (select count(*) from public.product_variants),
  'suppliers', (select count(*) from public.suppliers),
  'source_records', (select count(*) from public.catalog_source_records),
  'review_items', (select count(*) from public.catalog_review_work_items),
  'relation_decisions', (select count(*) from public.catalog_relation_decisions),
  'acrylic_internal_roles', (
    select count(*) from public.product_system_roles role
    join public.catalog_systems system on system.id = role.system_id
    where system.code = 'ACRYLIC' and role.decision_status = 'approved'
      and role.product_id is not null
  ),
  'acrylic_reference_roles', (
    select count(*) from public.product_system_roles role
    join public.catalog_systems system on system.id = role.system_id
    where system.code = 'ACRYLIC' and role.decision_status = 'approved'
      and role.reference_product_id is not null
  )
)::text;
`);
const reconstructed = JSON.parse(counts);
if (reconstructed.products !== 1051 || reconstructed.variants !== 1570
    || reconstructed.acrylic_internal_roles !== 45 || reconstructed.acrylic_reference_roles !== 2
    || reconstructed.relation_decisions !== 18) {
  throw new Error(`Conteos reconstruidos inesperados: ${counts}`);
}
console.log(JSON.stringify({ checkpoint: "restored", sha256: digest, ...reconstructed }, null, 2));
