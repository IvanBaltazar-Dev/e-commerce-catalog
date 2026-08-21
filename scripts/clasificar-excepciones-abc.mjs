/**
 * Dónde acabó cada una de las 26 excepciones candidatas del baseline.
 *
 * Que el número cayera a cero no es la demostración: podría haber caído porque
 * se perdieron por el camino. Lo que hay que poder decir es a qué causa
 * pertenecía cada una, y por qué esa causa no se gobierna con una política de
 * autoridad de fuente.
 *
 *   A · AUTORIDAD REAL DE FUENTE
 *       La misma afirmación merece distinta confianza según quién la haga. Es
 *       lo ÚNICO que debe acabar en catalog_source_predicate_authority.
 *
 *   B · DIFERENCIA DE PARSER
 *       La fuente no cambia; cambia nuestra capacidad de interpretar su texto.
 *       Pertenece a reglas con versión, no a autoridad. Si mañana mejoramos el
 *       parser, una política de autoridad quedaría mintiendo.
 *
 *   C · CONTEXTO DEL DATO
 *       Mercado, moneda, idioma, perfil técnico, tipo de documento. Vive en el
 *       modelo que le corresponde y no debe disfrazarse de excepción por marca.
 *
 * Y una cuarta que apareció al clasificar y que no estaba prevista: una política
 * sobre un predicado que la fuente NO EMITE no gobierna nada. No es que sea de
 * baja prioridad: es que no tiene sujeto.
 *
 *   node --experimental-transform-types scripts/clasificar-excepciones-abc.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "matriz-autoridad-baseline-48ff184.json"), "utf8"));
const actual = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "matriz-autoridad-propuesta.json"), "utf8"));

// Cada predicado candidato del baseline, con su causa y dónde vive ahora.
const CAUSAS = {
  "official.presentation": {
    causa: "B", titulo: "DIFERENCIA DE PARSER",
    porque: "el valor no lo publica la fuente: lo extrae un regex nuestro de cantidad+unidad sobre título, tipo y tags. Que rinda 95% en Masglo y 17% en Bigen mide nuestra regla, no la calidad de Bigen",
    vivePor: "regla PRESENTACION_CANTIDAD_UNIDAD v1 + clase NORMALIZED_SOURCE_CLAIM (tope: acceptable)"
  },
  "official.shade": {
    causa: "B", titulo: "DIFERENCIA DE PARSER",
    porque: "parte el título por un guion y asume que lo de delante es el tono. Es una convención de titulado que asumimos nosotros",
    vivePor: "regla TONO_POR_SEGMENTO_DE_TITULO v1 + clase DERIVED_INFERRED (tope: supplemental)"
  },
  "official.line": {
    causa: "B", titulo: "DIFERENCIA DE PARSER",
    porque: "busca en los tags un vocabulario en español que fijamos nosotros. Admiss rinde 99% y Cherimoya 0%: eso demuestra que la regla interpreta bien los tags de Admiss, no que Admiss publique una línea",
    vivePor: "regla NAIL_ES_PRODUCT_SEMANTICS v1 + clase DERIVED_INFERRED (tope: supplemental)"
  },
  "official.finish": {
    causa: "B", titulo: "DIFERENCIA DE PARSER",
    porque: "misma regla que line, con adjetivos de acabado. 79% en Admiss, 0% en Cherimoya",
    vivePor: "regla NAIL_ES_PRODUCT_SEMANTICS v1 + clase DERIVED_INFERRED (tope: supplemental)"
  },
  "price.observed": {
    causa: "C", titulo: "CONTEXTO DEL DATO",
    porque: "el precio es literal y está bien publicado en las seis. Lo que cambia no es la autoridad de la fuente sino el mercado y la moneda en que habla: los 3.900-15.900 de Admiss son pesos colombianos",
    vivePor: "catalog_sources.metadata.market y .currency + price.* bajado a supplemental para toda fuente official"
  },
  "identity.gtin": {
    causa: "SIN_SUJETO", titulo: "LA FUENTE NO EMITE EL PREDICADO",
    porque: "cinco de las seis publican cero códigos de barras. Una política sobre un predicado que la fuente nunca aporta no gobierna nada: no tiene sujeto sobre el que aplicarse",
    vivePor: "el desenlace NO_EMITIDO en la matriz, que lo deja registrado sin fabricar una regla vacía"
  }
};

const candidatos = [];
for (const s of base.informe) {
  for (const f of s.filas.filter((x) => x.destino === "REQUIERE_ESPECIFICA")) {
    candidatos.push({ fuente: s.fuente, predicado: f.predicado, nivel: f.nivelPropuesto, naturaleza: f.naturaleza });
  }
}

const porCausa = {};
for (const c of candidatos) {
  const info = CAUSAS[c.predicado];
  if (!info) { (porCausa["SIN_CLASIFICAR"] ??= []).push(c); continue; }
  (porCausa[info.causa] ??= []).push({ ...c, ...info });
}

console.log(`\n${"═".repeat(92)}`);
console.log(`DÓNDE ACABÓ CADA EXCEPCIÓN CANDIDATA`);
console.log(`baseline 48ff184aea15 · ${candidatos.length} candidatas`);
console.log(`${"═".repeat(92)}`);

const ORDEN = ["A", "B", "C", "SIN_SUJETO", "SIN_CLASIFICAR"];
for (const causa of ORDEN) {
  const lista = porCausa[causa];
  if (!lista?.length) {
    if (causa === "A") console.log(`\n\nA · AUTORIDAD REAL DE FUENTE\n   ninguna. Ninguna de las 26 era una afirmación que mereciera distinta confianza\n   según la fuente: todas eran nuestra interpretación, el mercado del dato, o un\n   predicado que la fuente ni siquiera emite.`);
    continue;
  }
  const info = lista[0];
  console.log(`\n\n${causa} · ${info.titulo ?? causa}   —   ${lista.length} candidatas`);
  const porPred = {};
  for (const c of lista) (porPred[c.predicado] ??= []).push(c.fuente.replace("-official", ""));
  for (const [pred, fuentes] of Object.entries(porPred)) {
    const i = CAUSAS[pred];
    console.log(`\n   ${pred}  (${fuentes.length}: ${fuentes.join(", ")})`);
    console.log(`     por qué no es autoridad: ${i.porque}`);
    console.log(`     dónde vive ahora:        ${i.vivePor}`);
  }
}

// ── Comprobación: ninguna sobrevive como política de fuente ─────────────────
const supervivientes = [];
for (const s of actual.informe) {
  for (const f of s.filas.filter((x) => x.destino === "REQUIERE_ESPECIFICA")) {
    supervivientes.push(`${s.fuente}:${f.predicado}`);
  }
}

console.log(`\n\n${"═".repeat(92)}`);
console.log(`COMPARATIVO`);
console.log(`${"═".repeat(92)}`);
console.log(`   baseline 48ff184aea15            ${String(candidatos.length).padStart(3)} excepciones candidatas`);
console.log(`   A · autoridad real de fuente     ${String((porCausa.A ?? []).length).padStart(3)}  → catalog_source_predicate_authority`);
console.log(`   B · diferencia de parser         ${String((porCausa.B ?? []).length).padStart(3)}  → reglas con versión + clase epistémica`);
console.log(`   C · contexto del dato            ${String((porCausa.C ?? []).length).padStart(3)}  → mercado y moneda de la fuente`);
console.log(`   sin sujeto (no emitido)          ${String((porCausa.SIN_SUJETO ?? []).length).padStart(3)}  → desenlace NO_EMITIDO`);
console.log(`   sin clasificar                   ${String((porCausa.SIN_CLASIFICAR ?? []).length).padStart(3)}`);
console.log(`   ${"─".repeat(60)}`);
console.log(`   políticas de fuente a poblar     ${String(supervivientes.length).padStart(3)}`);

fs.writeFileSync(path.join(ROOT, "outputs", "clasificacion-abc.json"),
  JSON.stringify({ candidatos: candidatos.length, porCausa, supervivientes }, null, 2), "utf8");

if ((porCausa.SIN_CLASIFICAR ?? []).length) {
  console.error(`\nHay candidatas sin causa asignada: no se puede decidir sobre ellas.`);
  process.exit(1);
}
console.log(`\n→ outputs/clasificacion-abc.json`);
