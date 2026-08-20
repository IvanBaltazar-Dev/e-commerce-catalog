/**
 * Lo que queda: agrupado por causa, y ordenado por rendimiento.
 *
 * Dos informes que responden a la misma regla — no convertir incertidumbre
 * masiva en revisión producto por producto:
 *
 *   1. EXCEPCIONES · los candidatos, contradicciones y no resueltos de marcas
 *      que SÍ tienen universo. Agrupados por causa, porque veinticinco casos
 *      con tres causas son tres decisiones, no veinticinco preguntas.
 *
 *   2. EXPANSIÓN · los productos de marcas sin universo, por marca y ordenados
 *      por cuántos desbloquea cada campaña. Investigar la marca con 110
 *      productos antes que la de 1 no es una preferencia: es la diferencia
 *      entre que el siguiente lote de 5.000 sea viable o no.
 *
 * Uso: node scripts/excepciones-y-expansion.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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

const casos = await todas("catalog_reconciliation_cases", "id, entity_type, product_id, variant_id, algorithm, score, status, evidence",
  (q) => q.in("status", ["proposed", "needs_review"]));
const productos = await todas("products", "id, code, name, presentation, is_active, brand_id, categories(name), brands(name)");
const variantes = await todas("product_variants", "id, product_id, name, sku, is_active");
const refProductos = await todas("catalog_reference_products", "id, brand_id");

const conUniverso = new Set(refProductos.map((r) => r.brand_id));
const activos = productos.filter((p) => p.is_active);
const prodPorId = new Map(productos.map((p) => [p.id, p]));

// ── 1 · Excepciones agrupadas por causa ─────────────────────────────────────
const excepciones = casos.filter((c) => ["MATCH_CANDIDATE", "CONTRADICTION"].includes(c.evidence?.clase));

// La causa no es el caso: es el motivo por el que el caso quedó abierto. Dos
// productos que empatan con doce fichas oficiales tienen la MISMA causa, y se
// arreglan con la misma decisión.
function causaDe(c) {
  const nota = c.evidence?.nota ?? "";
  if (c.evidence?.clase === "CONTRADICTION") {
    if (/color/i.test(nota)) return "El color de nuestro nombre no coincide con el de la ficha";
    if (/clase/i.test(nota)) return "La clase de producto no coincide con la de la ficha";
    return "Contradicción sin causa clasificada";
  }
  if (/fichas oficiales con ese mismo nombre/.test(nota)) return "Varias fichas oficiales comparten nombre: la marca repite el nombre entre líneas o presentaciones";
  if (/empatan/.test(nota)) return "Varias fichas empatan en parecido: el nombre no distingue";
  if (/umbral/.test(nota)) return "Parecido por debajo del umbral firme: probablemente el mismo producto con el nombre reescrito";
  return "Candidato sin causa clasificada";
}

const porCausa = new Map();
for (const c of excepciones) {
  const causa = causaDe(c);
  if (!porCausa.has(causa)) porCausa.set(causa, []);
  const p = c.product_id ? prodPorId.get(c.product_id) : prodPorId.get(variantes.find((v) => v.id === c.variant_id)?.product_id);
  porCausa.get(causa).push({
    tipo: c.entity_type,
    nuestro: c.evidence?.nuestro,
    oficial: c.evidence?.oficial,
    marca: p?.brands?.name ?? c.evidence?.marca ?? "—",
    score: Number(c.score),
    url: c.evidence?.urlOficial ?? null
  });
}

console.log(`${"═".repeat(78)}\nEXCEPCIONES · ${excepciones.length} casos abiertos, ${porCausa.size} causas\n${"═".repeat(78)}`);
for (const [causa, lista] of [...porCausa].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n▸ ${lista.length} casos · ${causa}`);
  const marcas = new Map();
  for (const x of lista) marcas.set(x.marca, (marcas.get(x.marca) ?? 0) + 1);
  console.log(`   marcas: ${[...marcas].map(([m, n]) => `${m} (${n})`).join(", ")}`);
  for (const x of lista.slice(0, 4)) {
    console.log(`     ${String(x.nuestro ?? "").slice(0, 34).padEnd(36)} → ${String(x.oficial ?? "").slice(0, 34)}`);
  }
  if (lista.length > 4) console.log(`     … y ${lista.length - 4} más`);
}

// ── 2 · Los no resueltos dentro de marca conocida ───────────────────────────
const conCaso = new Set(casos.filter((c) => c.entity_type === "product").map((c) => c.product_id));
const noResueltos = activos.filter((p) => conUniverso.has(p.brand_id) && !conCaso.has(p.id));

console.log(`\n${"═".repeat(78)}\nNO RESUELTOS con universo disponible · ${noResueltos.length}\n${"═".repeat(78)}`);
const nrPorMarca = new Map();
for (const p of noResueltos) {
  const m = p.brands?.name ?? "—";
  if (!nrPorMarca.has(m)) nrPorMarca.set(m, []);
  nrPorMarca.get(m).push(p);
}
for (const [m, lista] of [...nrPorMarca].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n   ${String(lista.length).padStart(4)}  ${m}`);
  for (const p of lista.slice(0, 5)) console.log(`         ${p.name.slice(0, 44).padEnd(46)} ${p.presentation ?? ""}`);
  if (lista.length > 5) console.log(`         … y ${lista.length - 5} más`);
}

// ── 3 · Expansión de universo, por rendimiento ──────────────────────────────
const sinUniverso = activos.filter((p) => !conUniverso.has(p.brand_id));
const expPorMarca = new Map();
for (const p of sinUniverso) {
  const m = p.brands?.name ?? "Sin marca";
  if (!expPorMarca.has(m)) expPorMarca.set(m, { productos: 0, variantes: 0, categorias: new Set() });
  const e = expPorMarca.get(m);
  e.productos += 1;
  e.variantes += variantes.filter((v) => v.product_id === p.id && v.is_active).length;
  e.categorias.add(p.categories?.name ?? "—");
}

const ranking = [...expPorMarca]
  .map(([marca, e]) => ({ marca, ...e, categorias: e.categorias.size }))
  .sort((a, b) => b.productos - a.productos);

console.log(`\n${"═".repeat(78)}\nEXPANSIÓN · ${sinUniverso.length} productos en ${ranking.length} marcas sin universo\n${"═".repeat(78)}`);

// El acumulado es la cifra que decide dónde parar: si veinte campañas cubren el
// 60%, las ciento sesenta restantes no valen lo que cuestan.
let acumulado = 0;
console.log(`\n  ORDEN DE RENDIMIENTO (una campaña por marca)\n`);
console.log(`   ${"#".padStart(3)}  ${"productos".padStart(9)}  ${"acum".padStart(6)}  ${"%".padStart(5)}  marca`);
for (const [i, r] of ranking.slice(0, 25).entries()) {
  acumulado += r.productos;
  console.log(`   ${String(i + 1).padStart(3)}  ${String(r.productos).padStart(9)}  ${String(acumulado).padStart(6)}  ${String(Math.round(acumulado / sinUniverso.length * 100)).padStart(4)}%  ${r.marca}`);
}
const cola = ranking.filter((r) => r.productos === 1);
console.log(`\n   Cola: ${cola.length} marcas con UN solo producto (${Math.round(cola.length / ranking.length * 100)}% de las marcas, ${Math.round(cola.length / sinUniverso.length * 100)}% de los productos).`);
console.log(`   Investigar una fuente completa para un producto no se paga nunca: esas van al final o a captura física.`);

const top10 = ranking.slice(0, 10).reduce((a, r) => a + r.productos, 0);
console.log(`\n   Las 10 primeras marcas cubren ${top10} productos (${Math.round(top10 / sinUniverso.length * 100)}%).`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "excepciones-y-expansion.json"), JSON.stringify({
  excepciones: Object.fromEntries([...porCausa].map(([k, v]) => [k, v])),
  noResueltosPorMarca: Object.fromEntries([...nrPorMarca].map(([k, v]) => [k, v.map((p) => ({ code: p.code, name: p.name, presentation: p.presentation }))])),
  expansion: ranking
}, null, 2), "utf8");
console.log(`\n→ outputs/excepciones-y-expansion.json`);
