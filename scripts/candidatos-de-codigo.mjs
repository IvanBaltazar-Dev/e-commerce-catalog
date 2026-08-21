/**
 * Para los códigos que ninguna fuente resuelve por coincidencia exacta, propone
 * CANDIDATOS y nombra la relación. Nunca adopta nada.
 *
 * Nace de mirar los 12 que quedaban sin resolver y descubrir que no eran doce
 * agujeros iguales, sino tres fenómenos distintos:
 *
 *   LA-139   ↔ LA-139-1     el de la fuente lleva un sufijo que el nuestro no
 *   RI-002   ↔ ORI002       una letra de más al principio
 *   SH-236A  ↔ SH-236       el NUESTRO es una variante del suyo, no al revés
 *
 * La tercera es la importante y la que obliga a no automatizar la adopción: si
 * su ficha dice «BASE RUBBER A, B, C Y D» y nosotros tenemos SH-236A y SH-236B,
 * su código identifica un PRODUCTO y los nuestros identifican VARIANTES. Fundir
 * los dos destruiría la distinción, que es justo lo que costó reconstruir.
 *
 * Por eso la salida es una propuesta con su relación y su corroboración, para
 * que alguien decida. Un candidato sin corroboración de nombre no vale nada:
 * el choque CHE011 fue exactamente eso, dos códigos iguales de mundos distintos.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { normalizarCodigo } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/catalog-intelligence/captura-contratos.ts")).href
);

const objetivo = fs.readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

// El universo observado, con su ficha, para poder corroborar por nombre.
const universo = new Map();   // código normalizado → [{codigo, nombre, categoria, fuente}]
function cargar(fichero, fuente) {
  if (!fs.existsSync(fichero)) return;
  const j = JSON.parse(fs.readFileSync(fichero, "utf8"));
  for (const p of j.productos ?? []) {
    const n = normalizarCodigo(p.codigoObservado);
    if (!n) continue;
    if (!universo.has(n)) universo.set(n, []);
    universo.get(n).push({
      codigo: p.codigoObservado, nombre: p.nombre ?? "",
      categoria: p.categoriaFuente ?? null, disponible: p.disponible, fuente
    });
  }
}
cargar("outputs/sitemap-sumerlabs-bellespa.json", "sitemap BELLESPA");
cargar("outputs/sitemap-sumerlabs-revel.json", "sitemap REVE'L");
cargar("outputs/campana-sumerlabs-bellespa.json", "catálogo BELLESPA");
cargar("outputs/campana-sumerlabs-revel.json", "catálogo REVE'L");
cargar("outputs/campana-revel.json", "catálogo REVE'L");

/**
 * Qué relación hay entre el código nuestro y el de la fuente. El orden importa:
 * las relaciones más específicas se comprueban antes que las genéricas, porque
 * «se parecen en una letra» describe casi todo y no explica nada.
 */
function relacion(nuestro, suyo) {
  if (nuestro === suyo) return { tipo: "EXACTA", direccion: null };
  if (suyo.startsWith(nuestro)) {
    const cola = suyo.slice(nuestro.length);
    // Su código = el nuestro + algo. Suyo es más específico.
    if (/^\d{1,2}$/.test(cola)) return { tipo: "SUFIJO_NUMERICO_EN_LA_FUENTE", direccion: "suyo_mas_especifico", cola };
    if (/^[A-Z]$/.test(cola)) return { tipo: "SUFIJO_DE_LETRA_EN_LA_FUENTE", direccion: "suyo_mas_especifico", cola };
  }
  if (nuestro.startsWith(suyo)) {
    const cola = nuestro.slice(suyo.length);
    // El nuestro = el suyo + algo. NOSOTROS somos más específicos: probable
    // variante nuestra de un producto que ellos publican entero.
    if (/^[A-Z]$/.test(cola)) return { tipo: "EL_NUESTRO_ES_VARIANTE", direccion: "nuestro_mas_especifico", cola };
    if (/^\d{1,2}$/.test(cola)) return { tipo: "EL_NUESTRO_ES_VARIANTE", direccion: "nuestro_mas_especifico", cola };
  }
  if (suyo.length === nuestro.length + 1 && suyo.endsWith(nuestro))
    return { tipo: "LETRA_DE_MAS_AL_INICIO", direccion: null, cola: suyo[0] };
  if (nuestro.length === suyo.length + 1 && nuestro.endsWith(suyo))
    return { tipo: "LETRA_DE_MENOS_AL_INICIO", direccion: null, cola: nuestro[0] };
  return null;
}

/** Corroboración por nombre: sin esto un candidato es solo un parecido tipográfico. */
const PALABRAS = (s) => new Set(
  (s || "").toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !["REVEL", "BELLESPA", "DOC", "CAJA", "PCS", "UND"].includes(w))
);
function solape(a, b) {
  const A = PALABRAS(a), B = PALABRAS(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

// El fichero de contexto viene indexado por posición, no por código, así que hay
// que construir el índice. Sin esto el solape de nombre sale 0 en todo y los
// candidatos quedan reducidos a un parecido tipográfico, que es exactamente lo
// que no sirve para decidir nada.
const contexto = new Map();
if (fs.existsSync("outputs/contexto-codigos.json")) {
  const crudo = JSON.parse(fs.readFileSync("outputs/contexto-codigos.json", "utf8"));
  for (const fila of Object.values(crudo)) {
    if (!fila?.codigo) continue;
    const n = normalizarCodigo(fila.norm ?? fila.codigo);
    if (n) contexto.set(n, fila);
  }
}

const salida = [];
for (const bruto of objetivo) {
  const nuestro = normalizarCodigo(bruto);
  if (!nuestro || universo.has(nuestro)) continue;   // los exactos no son asunto de aquí
  const ctx = contexto.get(nuestro) ?? {};
  const nombreNuestro = [ctx.producto, ctx.presentacion].filter(Boolean).join(" ");

  const cands = [];
  for (const [n, fichas] of universo) {
    const r = relacion(nuestro, n);
    if (!r) continue;
    for (const f of fichas) {
      cands.push({
        codigoEnFuente: f.codigo, nombreEnFuente: f.nombre, categoriaEnFuente: f.categoria,
        fuente: f.fuente, disponible: f.disponible,
        relacion: r.tipo, direccion: r.direccion, diferencia: r.cola ?? null,
        solapeDeNombre: Number(solape(nombreNuestro, f.nombre).toFixed(2))
      });
    }
  }
  if (!cands.length) continue;
  cands.sort((a, b) => b.solapeDeNombre - a.solapeDeNombre);
  salida.push({ codigo: bruto, normalizado: nuestro, nombreNuestro: nombreNuestro || null, candidatos: cands.slice(0, 4) });
}

console.log(`Códigos consultados: ${objetivo.length}`);
console.log(`Con candidato por relación: ${salida.length}\n`);
for (const s of salida) {
  console.log(`${s.codigo}  ${s.nombreNuestro ?? ""}`);
  for (const c of s.candidatos) {
    const marca = c.solapeDeNombre >= 0.5 ? "✓" : c.solapeDeNombre > 0 ? "~" : "✗";
    console.log(`   ${marca} ${String(c.codigoEnFuente).padEnd(11)} ${c.relacion.padEnd(30)} solape ${c.solapeDeNombre}`);
    console.log(`     ${c.nombreEnFuente.slice(0, 68)}`);
  }
  console.log();
}
console.log(`Ninguno se adopta: son propuestas con su relación nombrada, para revisar.`);
fs.writeFileSync("outputs/candidatos-de-codigo.json", JSON.stringify(salida, null, 2), "utf8");
console.log(`\n→ outputs/candidatos-de-codigo.json`);
