/**
 * Prueba de cierre semántico: todo predicado que el pipeline emite tiene que
 * quedar resuelto o declarado inaplicable. Nada puede quedar en silencio.
 *
 * El silencio era el problema. official.title, official.sku y seis más no
 * casaban con ningún patrón de autoridad, y nada fallaba: se observaban, se
 * guardaban y nadie decidía nada sobre ellos. Un dato sin autoridad resuelta no
 * da error, simplemente no gobierna — y eso es peor que un error, porque no se
 * ve.
 *
 * Tres desenlaces admitidos, y ninguno más:
 *
 *   RESUELTO         hay una política que dice qué autoridad tiene
 *   NO_APPLICABLE    se decidió que no es un claim (texto de origen,
 *                    disponibilidad que ya viaja con el precio)
 *   UNMAPPED         el campo no tiene predicado canónico, está reportado y
 *                    NO se le inventó una dimensión para acomodarlo
 *
 *   node --experimental-transform-types scripts/test-resolucion-predicados.mjs
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

const { informe } = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "matriz-autoridad-propuesta.json"), "utf8"));

let fallos = 0;
const mal = (m) => { console.error(`  ✗ ${m}`); fallos += 1; };
const bien = (m) => console.log(`  ✓ ${m}`);

console.log(`\nRESOLUCIÓN DE PREDICADOS SOBRE LAS SEIS MARCAS\n`);

// ── 1 · Ningún predicado del namespace del crawler sobrevive ────────────────
{
  const crawler = informe.flatMap((s) => s.filas.filter((f) => /^(official|shopify|woocommerce|pdf|manual)\./.test(f.predicado ?? "")).map((f) => `${s.fuente}:${f.predicado}`));
  crawler.length ? crawler.forEach(mal) : bien(`ningún predicado de namespace de crawler en la matriz`);
}

// ── 2 · Todo predicado emitido resuelve ─────────────────────────────────────
{
  const sinResolver = [];
  for (const s of informe) {
    for (const f of s.filas) {
      if (!f.predicado || f.conValor === 0) continue;
      if (!f.autoridadActual) sinResolver.push(`${s.fuente}:${f.predicado} (${f.conValor} valores) no resuelve`);
    }
  }
  sinResolver.length ? sinResolver.forEach(mal) : bien(`todo predicado con valores resuelve a una política`);
}

// ── 3 · Cada fila tiene desenlace explícito ────────────────────────────────
{
  const admitidos = new Set(["HEREDA", "REQUIERE_ESPECIFICA", "NO_EMITIDO", "NO_APPLICABLE", "UNMAPPED", "CARECE"]);
  const raros = informe.flatMap((s) => s.filas.filter((f) => !admitidos.has(f.destino)).map((f) => `${s.fuente}:${f.campo} → «${f.destino}»`));
  raros.length ? raros.forEach(mal) : bien(`las ${informe.reduce((a, s) => a + s.filas.length, 0)} filas tienen desenlace declarado`);
  const carecen = informe.flatMap((s) => s.filas.filter((f) => f.destino === "CARECE").map((f) => `${s.fuente}:${f.predicado}`));
  carecen.length ? carecen.forEach(mal) : bien(`ninguna fila queda sin autoridad ni explicación`);
}

// ── 4 · Una inferencia nunca lleva autoridad de literal ────────────────────
{
  const malos = informe.flatMap((s) => s.filas
    .filter((f) => f.epistemico === "DERIVED_INFERRED" && f.conValor > 0
      && f.autoridadActual && ["preferred", "acceptable"].includes(f.autoridadActual.authority_level))
    .map((f) => `${s.fuente}:${f.predicado} es DERIVED_INFERRED con «${f.autoridadActual.authority_level}»`));
  malos.length ? malos.forEach(mal) : bien(`ninguna inferencia del parser lleva autoridad por encima de «supplemental»`);
}

// ── 5 · El identificador local no compite con el global ────────────────────
{
  const { data: f } = await db.from("catalog_sources").select("id").eq("source_key", "masglo-es-official").single();
  const pedir = async (p) => (await db.rpc("resolve_authority_with_epistemics_v1", {
    p_source_id: f.id, p_predicate: p, p_source_field: "*",
    p_dimension_code: "identity", p_epistemic_class: "OBSERVATION_LITERAL"
  })).data?.[0];
  const gtin = await pedir("identity.gtin");
  const local = await pedir("identity.source_external_id");
  const orden = { prohibited: 0, supplemental: 1, acceptable: 2, preferred: 3 };
  if (!gtin || !local) mal(`no resuelven los identificadores`);
  else if (orden[gtin.authority_level] <= orden[local.authority_level]) {
    mal(`el GTIN (${gtin.authority_level}) no supera al id local (${local.authority_level})`);
  } else bien(`GTIN «${gtin.authority_level}» por encima del id de la tienda «${local.authority_level}»`);
}

// ── 6 · Cero reglas por marca ──────────────────────────────────────────────
{
  const { count } = await db.from("catalog_source_predicate_authority")
    .select("*", { count: "exact", head: true }).not("source_id", "is", null);
  count === 0
    ? bien(`cero políticas por fuente: todo lo explica el contrato universal`)
    : mal(`quedan ${count} políticas por fuente; deberían explicarse en la clase`);
}

// ── Recuento final ─────────────────────────────────────────────────────────
const cuenta = {};
for (const s of informe) for (const f of s.filas) cuenta[f.destino] = (cuenta[f.destino] ?? 0) + 1;
console.log(`\n  desenlaces sobre ${Object.values(cuenta).reduce((a, b) => a + b, 0)} filas:`);
for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`);

console.log();
if (fallos) { console.error(`${fallos} comprobación(es) fallan.\n`); process.exit(1); }
console.log(`Cierre semántico completo: nada emitido queda sin resolver ni sin declarar.\n`);
