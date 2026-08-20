/**
 * Adopción controlada del código de barras desde la fuente oficial.
 *
 * Esta es la primera vez que algo investigado llega a escribir en el catálogo
 * comercial, así que pasa por todas las puertas. Un GTIN es un identificador
 * objetivo —lo emite GS1, no lo decide nadie aquí— y por eso puede promoverse
 * sin decisión comercial; pero solo si se cumple TODO:
 *
 *   · la variante está reconciliada como MATCH_EXACT
 *   · la fuente es oficial
 *   · el código se recuperó literal de la ficha, no derivado ni compuesto
 *   · longitud GTIN válida (8, 12, 13 o 14)
 *   · dígito de control válido
 *   · product_variants.barcode está vacío
 *   · si ya hay uno DISTINTO, no se sobrescribe: se registra contradicción
 *
 * Y cada valor escrito deja dicho de dónde salió: qué variante de referencia,
 * qué fuente, qué registro de rastreo y qué caso de reconciliación lo produjo.
 * Un identificador sin procedencia es indistinguible de uno inventado.
 *
 * Segundo run = cero cambios. Si no lo fuera, no sería una promoción sino una
 * escritura repetida, y el historial dejaría de significar nada.
 *
 * Uso:
 *   node scripts/adoptar-barcodes.mjs             (previsualización)
 *   node scripts/adoptar-barcodes.mjs --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

function digitoDeControlValido(codigo) {
  if (!/^\d+$/.test(codigo)) return false;
  if (![8, 12, 13, 14].includes(codigo.length)) return false;
  const digitos = codigo.split("").map(Number);
  const control = digitos.pop();
  let suma = 0;
  for (let i = digitos.length - 1, peso = 3; i >= 0; i -= 1, peso = peso === 3 ? 1 : 3) suma += digitos[i] * peso;
  return (10 - (suma % 10)) % 10 === control;
}

const familiaGtin = (c) => (c.length === 13 ? "EAN" : c.length === 12 ? "UPC" : "GTIN");

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const casos = await todas(
  "catalog_reconciliation_cases",
  "id, variant_id, reference_variant_id, algorithm, score, status, evidence, research_run_id",
  (q) => q.eq("entity_type", "variant").in("status", ["proposed", "needs_review"])
);
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, sku, barcode, name, shade_name, primary_source_id, primary_source_record_id, metadata");
const variantes = await todas("product_variants", "id, product_id, name, sku, barcode, is_active");
const fuentes = await todas("catalog_sources", "id, source_key, authority");

const refPorId = new Map(refVariantes.map((r) => [r.id, r]));
const varPorId = new Map(variantes.map((v) => [v.id, v]));
const fuentePorId = new Map(fuentes.map((f) => [f.id, f]));

const adoptar = [];
const contradicciones = [];
const rechazos = new Map();
const anota = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const c of casos) {
  const rv = refPorId.get(c.reference_variant_id);
  const v = varPorId.get(c.variant_id);
  if (!rv || !v) { anota(rechazos, "el caso apunta a algo que ya no existe"); continue; }

  if (c.evidence?.clase !== "MATCH_EXACT") { anota(rechazos, "la identidad no es exacta"); continue; }
  if (!v.is_active) { anota(rechazos, "la variante está inactiva"); continue; }

  const fuente = fuentePorId.get(rv.primary_source_id);
  if (fuente?.authority !== "official") { anota(rechazos, "la fuente no es oficial"); continue; }

  const bruto = (rv.barcode ?? "").toString().trim();
  if (!bruto) { anota(rechazos, "la ficha oficial no publica código"); continue; }
  const codigo = bruto.replace(/[\s-]/g, "");
  if (!digitoDeControlValido(codigo)) { anota(rechazos, "el código no pasa el dígito de control"); continue; }

  const actual = (v.barcode ?? "").toString().trim();
  if (actual && actual !== codigo) {
    // No se pisa. Que dos autoridades den códigos distintos para lo mismo es
    // exactamente lo que hay que enseñar, no resolver por orden de llegada.
    contradicciones.push({
      variantId: v.id, variante: v.name, nuestro: actual, oficial: codigo,
      fuente: fuente.source_key, refVariantId: rv.id
    });
    anota(rechazos, "ya tiene un código distinto: contradicción");
    continue;
  }
  if (actual === codigo) { anota(rechazos, "ya lo tiene, idéntico"); continue; }

  adoptar.push({
    variantId: v.id, variante: v.name, codigo, familia: familiaGtin(codigo),
    refVariantId: rv.id, sourceId: rv.primary_source_id, sourceRecordId: rv.primary_source_record_id,
    casoId: c.id, runId: c.research_run_id, fuente: fuente.source_key,
    skuOficial: rv.sku ?? null
  });
}

// La huella cubre exactamente lo que se va a escribir. Si mañana el conjunto es
// otro, la corrida es otra; si es el mismo, no debe escribir nada.
const huella = sha(JSON.stringify(adoptar.map((a) => `${a.variantId}:${a.codigo}`).sort()));

console.log(`Casos de variante examinados: ${casos.length}`);
console.log(`  ADOPTABLES:      ${adoptar.length}`);
console.log(`  contradicciones: ${contradicciones.length}`);
console.log(`\nDescartes por causa:`);
for (const [m, n] of [...rechazos].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${m}`);

const porFamilia = new Map();
for (const a of adoptar) anota(porFamilia, a.familia);
console.log(`\nPor familia GTIN:`);
for (const [f, n] of porFamilia) console.log(`   ${String(n).padStart(5)}  ${f}`);

console.log(`\nMuestra:`);
for (const a of adoptar.slice(0, 8)) console.log(`   ${a.codigo.padEnd(16)} ${String(a.skuOficial ?? "").padEnd(10)} ${a.variante.slice(0, 26).padEnd(28)} ${a.fuente}`);

if (contradicciones.length) {
  console.log(`\nContradicciones (NO se escriben):`);
  for (const c of contradicciones.slice(0, 8)) console.log(`   ${c.variante.slice(0, 26).padEnd(28)} nuestro ${c.nuestro} · oficial ${c.oficial}`);
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "adopcion-barcodes.json"),
  JSON.stringify({ huella, adoptar, contradicciones, rechazos: Object.fromEntries(rechazos) }, null, 2), "utf8");

console.log(`\nHuella de la adopción: ${huella}`);
if (!APLICAR) {
  console.log(`\nPrevisualización. Nada escrito. Añade --aplicar.`);
  process.exit(0);
}

if (!adoptar.length) {
  console.log(`\nNada que adoptar. Segundo run limpio.`);
  process.exit(0);
}

const { data: corrida, error: errCorrida } = await db
  .from("catalog_research_runs")
  .upsert({
    run_key: `adopcion-barcodes-${huella.slice(0, 12)}`,
    run_kind: "targeted",
    actor_kind: "system",
    actor_label: "adoptar-barcodes.mjs",
    status: "running",
    finished_at: null,
    result_fingerprint: null,
    input_fingerprint: huella,
    scope: { criterio: "MATCH_EXACT + fuente oficial + GTIN válido + barcode vacío" },
    metrics: { adoptables: adoptar.length, contradicciones: contradicciones.length }
  }, { onConflict: "run_key" })
  .select("id").single();
if (errCorrida) throw new Error(`catalog_research_runs: ${errCorrida.message}`);

let escritos = 0, saltados = 0, fallos = 0;
for (const a of adoptar) {
  // Condición de carrera cerrada: solo escribe si sigue vacío. Si otra corrida
  // lo llenó entre la previsualización y esto, no lo pisa.
  const { data, error } = await db
    .from("product_variants")
    .update({ barcode: a.codigo, barcode_origen: "FICHA_OFICIAL", barcode_capturado_en: new Date().toISOString() })
    .eq("id", a.variantId).is("barcode", null)
    .select("id");
  if (error) { fallos += 1; console.error(`   ✗ ${a.codigo}: ${error.message}`); continue; }
  if (!data || !data.length) { saltados += 1; continue; }

  const { error: errId } = await db.from("variant_identifiers").upsert({
    variant_id: a.variantId,
    identifier_type: a.familia,
    value: a.codigo,
    issuer: "GS1",
    reference_variant_id: a.refVariantId,
    source_id: a.sourceId,
    source_record_id: a.sourceRecordId,
    reconciliation_case_id: a.casoId,
    research_run_id: corrida.id,
    is_primary: true,
    status: "active",
    metadata: { adoptadoDe: a.fuente, huellaAdopcion: huella, skuOficialDeLaFicha: a.skuOficial }
  }, { onConflict: "variant_id,identifier_type,value" });
  if (errId) console.error(`   ⚠ procedencia de ${a.codigo}: ${errId.message}`);
  escritos += 1;
}

await db.from("catalog_research_runs").update({
  status: "succeeded", finished_at: new Date().toISOString(), result_fingerprint: huella,
  result: { escritos, saltados, contradicciones: contradicciones.length }
}).eq("id", corrida.id);

console.log(`\nEscritos: ${escritos}`);
console.log(`Saltados (ya no estaban vacíos): ${saltados}`);
console.log(`Fallos: ${fallos}`);
console.log(`\nVuelve a correrlo: debe dar cero adoptables.`);
