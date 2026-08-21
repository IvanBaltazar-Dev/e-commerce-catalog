/**
 * El embudo: cuántos desconocidos mata cada capa, al margen.
 *
 * La regla que hace honesto el recuento: si un código aparece en tres fuentes,
 * NO se cuenta tres veces. La primera capa que lo resuelve se lleva la
 * resolución marginal; las siguientes son corroboración, y se anotan como tal.
 *
 * Sin eso, sumar las capas daría más resoluciones que códigos y cada fuente
 * parecería rentable.
 *
 * Y una distinción que no se colapsa: identificado ≠ vigente. Un código que solo
 * aparece en aduana está IDENTIFICADO —sabemos qué es, quién lo trajo y cuándo—
 * aunque hoy no se venda. Eso ya no es «no encontrado».
 *
 * Uso: node --experimental-transform-types scripts/embudo-codigos.mjs <fichero-de-codigos>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { normalizarCodigo } = await import(
  pathToFileURL(path.resolve("src/lib/catalog-intelligence/captura-contratos.ts")).href
);

const objetivo = fs.readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

// ── Capas ───────────────────────────────────────────────────────────────────
// El orden importa: se ordenan por lo que la evidencia dice sobre VIGENCIA, no
// por tamaño. Un código vivo en el catálogo de hoy es más informativo que el
// mismo código en una importación de 2023.
const capas = [];

function cargarCatalogo(fichero, etiqueta, tipo) {
  if (!fs.existsSync(fichero)) return;
  const j = JSON.parse(fs.readFileSync(fichero, "utf8"));
  const set = new Set(j.productos.map((p) => normalizarCodigo(p.codigoObservado)).filter(Boolean));
  capas.push({ etiqueta, tipo, set });
}
function cargarAduana(fichero, etiqueta) {
  const j = JSON.parse(fs.readFileSync(fichero, "utf8"));
  const set = new Set(j.declaraciones.flatMap((d) => d.codigos).map(normalizarCodigo).filter(Boolean));
  if (set.size) capas.push({ etiqueta, tipo: "TRADE_HISTORY", set });
}

cargarCatalogo("outputs/campana-sumerlabs-revel.json", "catálogo REVE'L", "CURRENT_CATALOG");
cargarCatalogo("outputs/campana-revel.json", "catálogo REVE'L", "CURRENT_CATALOG");
cargarCatalogo("outputs/campana-sumerlabs-bellespa.json", "catálogo BELLESPA", "OTHER_DISTRIBUTOR");

for (const f of fs.readdirSync("outputs").sort()) {
  if (!f.startsWith("datosperu-")) continue;
  const m = f.match(/^datosperu-(\d+)-p(\w+)\.json$/);
  if (!m) continue;
  const quien = m[1] === "20551491278" ? "REVE'L" : m[1] === "20522264904" ? "BELLESPA" : m[1];
  cargarAduana(path.join("outputs", f), `aduana ${quien} p${m[2]}`);
}

// Vigente primero, después historia; dentro de cada grupo, la más grande antes.
const orden = { CURRENT_CATALOG: 0, OTHER_DISTRIBUTOR: 1, TRADE_HISTORY: 2 };
capas.sort((a, b) => (orden[a.tipo] - orden[b.tipo]) || (b.set.size - a.set.size));

const universo = new Set();
for (const c of capas) for (const x of c.set) universo.add(x);

console.log(`Capas cargadas: ${capas.length}`);
console.log(`Códigos observados en total: ${universo.size}\n`);
for (const c of capas) console.log(`   ${String(c.set.size).padStart(5)}  ${c.tipo.padEnd(18)} ${c.etiqueta}`);

// ── Embudo con aporte marginal ──────────────────────────────────────────────
console.log(`\n${"═".repeat(70)}\nEMBUDO SOBRE ${objetivo.length} CÓDIGOS\n${"═".repeat(70)}\n`);

const pendientes = new Set(objetivo);
const evidencia = new Map();   // código → [{capa, tipo}]
for (const c of objetivo) evidencia.set(c, []);

let restantes = objetivo.length;
for (const capa of capas) {
  let marginal = 0, corrobora = 0;
  for (const c of objetivo) {
    if (!capa.set.has(c)) continue;
    evidencia.get(c).push({ capa: capa.etiqueta, tipo: capa.tipo });
    if (pendientes.has(c)) { pendientes.delete(c); marginal += 1; }
    else corrobora += 1;
  }
  if (!marginal && !corrobora) continue;
  restantes -= marginal;
  const flecha = marginal ? `-${String(marginal).padStart(3)}` : "   ·";
  console.log(`   ${flecha}  ${capa.etiqueta.padEnd(26)} quedan ${String(restantes).padStart(3)}${corrobora ? `   (+${corrobora} corroboran)` : ""}`);
}

// ── Estado por código ───────────────────────────────────────────────────────
// Identificado y vigente son cosas distintas, y hay que poder decir las dos.
function estado(evs) {
  if (!evs.length) return "UNRESOLVED";
  const tipos = new Set(evs.map((e) => e.tipo));
  if (tipos.has("CURRENT_CATALOG")) return "IDENTIFIED_CURRENT";
  if (tipos.has("OTHER_DISTRIBUTOR")) return "IDENTIFIED_EXTERNAL";
  if (tipos.has("TRADE_HISTORY")) return "IDENTIFIED_HISTORICAL";
  return "IDENTIFIED_BUT_SCOPE_UNKNOWN";
}

const porEstado = new Map();
for (const c of objetivo) {
  const e = estado(evidencia.get(c));
  if (!porEstado.has(e)) porEstado.set(e, []);
  porEstado.get(e).push(c);
}

console.log(`\n${"═".repeat(70)}\nESTADO\n${"═".repeat(70)}`);
for (const e of ["IDENTIFIED_CURRENT", "IDENTIFIED_EXTERNAL", "IDENTIFIED_HISTORICAL", "UNRESOLVED"]) {
  const l = porEstado.get(e) ?? [];
  if (!l.length) continue;
  console.log(`\n   ${String(l.length).padStart(3)}  ${e}`);
  for (const c of l.slice(0, 12)) {
    const evs = evidencia.get(c);
    console.log(`        ${c.padEnd(12)} ${evs.map((x) => x.capa).join(" · ") || "—"}`);
  }
  if (l.length > 12) console.log(`        … y ${l.length - 12} más`);
}

const resueltos = objetivo.length - (porEstado.get("UNRESOLVED")?.length ?? 0);
console.log(`\n   Resueltos: ${resueltos} de ${objetivo.length}`);
console.log(`   Sin resolver en fuentes primarias: ${objetivo.length - resueltos}`);

fs.writeFileSync("outputs/embudo-codigos.json", JSON.stringify({
  objetivo: objetivo.length,
  capas: capas.map((c) => ({ etiqueta: c.etiqueta, tipo: c.tipo, codigos: c.set.size })),
  universoObservado: universo.size,
  estados: Object.fromEntries([...porEstado].map(([k, v]) => [k, v])),
  evidencia: Object.fromEntries(evidencia)
}, null, 2), "utf8");
console.log(`\n→ outputs/embudo-codigos.json`);
