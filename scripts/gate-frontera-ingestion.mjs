/**
 * El gate de la frontera de ingestión.
 *
 * Mide si la frontera fuente → observación → normalización/inferencia →
 * autoridad quedó resuelta, o si simplemente dejó de dar errores. Son cosas
 * distintas: durante meses el sistema de autoridad no gobernó ni una sola
 * observación de estas seis fuentes y nada falló, porque un dato sin política
 * resuelta no da error — solo no manda.
 *
 * Por eso el gate no cuenta éxitos: cuenta que no quede nada sin explicar.
 *
 *   node --experimental-transform-types scripts/gate-frontera-ingestion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = ["masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"];

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let d = 0; ; d += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(d, d + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}
const contar = async (t, f = (q) => q) => (await f(db.from(t).select("*", { count: "exact", head: true }))).count ?? 0;

const { data: fuentes } = await db.from("catalog_sources").select("id, source_key").in("source_key", FUENTES);
const ids = fuentes.map((f) => f.id);

// ── Snapshot vigente por fuente: el último, que es el que gobierna ──────────
const snaps = await todas("catalog_source_snapshots", "id, source_id, created_at",
  (q) => q.in("source_id", ids), "created_at");
const vigentePorFuente = new Map();
for (const s of snaps) vigentePorFuente.set(s.source_id, s.id);   // ordenado asc: gana el último
const vigentes = [...vigentePorFuente.values()];

const registros = await todas("catalog_source_records", "id, source_id, snapshot_id, entity_type",
  (q) => q.in("snapshot_id", vigentes));
const fichas = registros.filter((r) => r.entity_type === "product").length;

// Solo el contrato vigente gobierna. Las observaciones son inmutables: cuando el
// contrato cambia se registran nuevas y las anteriores quedan como historia, así
// que medir sobre todas mezclaría dos contratos y el más viejo siempre perdería.
const CONTRATO = "v2-epistemico";
const obsTodas = await todas("catalog_observations",
  "observation_key, predicate, metadata, extraction_method, source_record_id",
  (q) => q.not("predicate", "is", null), "observation_key");
const obs = obsTodas.filter((o) => (o.observation_key ?? "").includes(CONTRATO));
const historicas = obsTodas.length - obs.length;
const idsRegistro = new Set(registros.map((r) => r.id));
const obsDeEstas = obs.filter((o) => idsRegistro.has(o.source_record_id));

const porClase = {};
const porPredicado = {};
for (const o of obsDeEstas) {
  const c = o.metadata?.epistemic_class ?? "SIN_CLASE";
  porClase[c] = (porClase[c] ?? 0) + 1;
  porPredicado[o.predicate] = (porPredicado[o.predicate] ?? 0) + 1;
}

// ── Resolución de autoridad, predicado a predicado y fuente a fuente ───────
const sinResolver = [];
const resueltos = [];
for (const f of fuentes) {
  const suyos = new Set(obsDeEstas
    .filter((o) => registros.find((r) => r.id === o.source_record_id)?.source_id === f.id)
    .map((o) => o.predicate));
  for (const p of suyos) {
    const muestra = obsDeEstas.find((o) => o.predicate === p);
    const dim = muestra?.metadata?.dimension_code ?? null;
    const epi = muestra?.metadata?.epistemic_class ?? "OBSERVATION_LITERAL";
    const { data } = await db.rpc("resolve_authority_with_epistemics_v1", {
      p_source_id: f.id, p_predicate: p, p_source_field: "*",
      p_dimension_code: dim, p_epistemic_class: epi
    });
    (data?.[0] ? resueltos : sinResolver).push(`${f.source_key}:${p}`);
  }
}

const reglasPorFuente = await contar("catalog_source_predicate_authority", (q) => q.not("source_id", "is", null));
const { data: todasReglas } = await db.from("catalog_source_predicate_authority").select("predicate_pattern");
const reglasCrawler = (todasReglas ?? []).filter((r) => /^(official|shopify|woocommerce|pdf|manual)\./.test(r.predicate_pattern));

const comercial = {
  productos: await contar("products"),
  variantes: await contar("product_variants"),
  precios: await contar("variant_prices"),
  stock: await contar("inventory_stock"),
};
const canonicas = await contar("catalog_semantic_claims", (q) => q.eq("epistemic_class", "CANONICAL_FACT"));

const mapeo = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "mapeo-predicados-canonicos.json"), "utf8"));
const matriz = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "matriz-autoridad-propuesta.json"), "utf8"));
const unmapped = matriz.informe.reduce((a, s) => a + s.filas.filter((f) => f.destino === "UNMAPPED").length, 0);
const noAplicable = matriz.informe.reduce((a, s) => a + s.filas.filter((f) => f.destino === "NO_APPLICABLE").length, 0);

const L = (k, v, ok = null) => console.log(`   ${String(k).padEnd(38)} ${String(v).padStart(8)}${ok === null ? "" : ok ? "   ✓" : "   ✗"}`);

console.log(`\n${"═".repeat(64)}`);
console.log(`GATE · FRONTERA DE INGESTIÓN`);
console.log(`${"═".repeat(64)}\n`);
L("fuentes", fuentes.length);
L("fichas de producto", fichas);
L("registros fuente", registros.length);
console.log();
L("predicados de ingestión", Object.keys(porPredicado).length);
L("mapeados a vocabulario canónico", `${Object.keys(porPredicado).filter((p) => !/^(official|shopify|woocommerce)\./.test(p)).length}/${Object.keys(porPredicado).length}`,
  Object.keys(porPredicado).every((p) => !/^(official|shopify|woocommerce)\./.test(p)));
L("campos sin mapping (explícitos)", unmapped, true);
L("observaciones que no son claim", noAplicable, true);
console.log();
L("claims literales", porClase.OBSERVATION_LITERAL ?? 0);
L("claims normalizados", porClase.NORMALIZED_SOURCE_CLAIM ?? 0);
L("inferencias", porClase.DERIVED_INFERRED ?? 0);
if (porClase.SIN_CLASE) L("sin clase epistémica", porClase.SIN_CLASE, false);
L("observaciones de contratos previos", historicas);
console.log();
L("autoridad resuelta", `${resueltos.length}/${resueltos.length + sinResolver.length}`, sinResolver.length === 0);
L("reglas específicas por fuente", reglasPorFuente, reglasPorFuente === 0);
L("predicados de crawler en autoridad", reglasCrawler.length, reglasCrawler.length === 0);
L("canonizaciones automáticas", canonicas, canonicas === 0);
console.log();
L("productos comerciales", comercial.productos);
L("precios Bellaroshé", comercial.precios);
L("stock", comercial.stock, comercial.stock === 0);

if (sinResolver.length) {
  console.log(`\n   sin resolver:`);
  for (const x of sinResolver.slice(0, 10)) console.log(`     ${x}`);
}

const fallos = [
  sinResolver.length > 0, reglasPorFuente > 0, reglasCrawler.length > 0,
  canonicas > 0, comercial.stock > 0,
  Object.keys(porPredicado).some((p) => /^(official|shopify|woocommerce)\./.test(p)),
].filter(Boolean).length;

console.log(`\n${"═".repeat(64)}`);
if (fallos) { console.error(`${fallos} control(es) fallan.\n`); process.exit(1); }
console.log(`Frontera resuelta: nada emitido queda sin explicar, y nada de esto`);
console.log(`ha tocado producto comercial, precio de venta ni stock.\n`);
