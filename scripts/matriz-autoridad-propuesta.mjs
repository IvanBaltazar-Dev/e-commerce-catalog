/**
 * De lo observado a la autoridad propuesta. Propone; no escribe nada.
 *
 * Cada predicado de cada fuente cae en uno de cuatro sitios, y el criterio para
 * repartirlos es el mismo siempre: qué dice la evidencia frente a lo que dice la
 * regla de clase.
 *
 *   HEREDA               hay regla de clase y la evidencia la respalda. No se
 *                        toca. Es el caso que debe ser mayoritario, y si no lo
 *                        es, el que está mal es el fallback.
 *   REQUIERE_ESPECIFICA  hay regla de clase y la evidencia la desmiente para
 *                        esta fuente concreta. Solo aquí se propone override.
 *   CARECE               ningún patrón resuelve. No es una excepción: es un
 *                        agujero del fallback, y se arregla en la clase.
 *   UNMAPPED             el campo no tiene predicado. Se reporta y se para.
 *
 * La distinción entre CARECE y REQUIERE_ESPECIFICA es la que evita repetir el
 * error de 0145. Que official.title no tenga autoridad no es un problema de
 * Masglo: le pasa a las seis y a cualquier fuente official futura. Arreglarlo
 * fuente por fuente son seis reglas que mantener; arreglarlo en la clase es una.
 *
 *   node --experimental-transform-types scripts/matriz-autoridad-propuesta.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inv = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "inventario-predicados.json"), "utf8"));

// ── Umbral de rendimiento para los derivados ────────────────────────────────
// Por debajo de esto, el valor lo produce el parser tan pocas veces que declarar
// autoridad sobre él describe nuestro regex, no la fuente.
const UMBRAL_DERIVADO = 0.5;

/**
 * El veredicto de una fila. Devuelve el destino y la razón, y la razón cita el
 * número medido: una propuesta sin su cuenta al lado no es revisable.
 */
function veredicto(fila, fuente) {
  const pct = Math.round(fila.cobertura * 100);
  const auth = fila.autoridadActual;

  if (!fila.predicado) {
    return { destino: "UNMAPPED", razon: `campo sin predicado; ${fila.nota ?? "sin equivalencia en el vocabulario registrado"}` };
  }

  // Un predicado sobre el que la fuente no publica nada. La regla de clase puede
  // decir «preferred» y ser cierta en abstracto y vacía en la práctica: declara
  // autoridad sobre algo que esta fuente nunca aporta.
  if (fila.conValor === 0) {
    return {
      destino: auth ? "REQUIERE_ESPECIFICA" : "CARECE",
      nivelPropuesto: "prohibited", score: 0,
      razon: auth
        ? `la clase concede «${auth.authority_level}» pero esta fuente publica 0 de ${fila.universo}: la autoridad sería vacía y la haría parecer una referencia que no es`
        : `0 de ${fila.universo}: nada sobre lo que declarar autoridad`
    };
  }

  // Los derivados no son observaciones de la fuente: los fabrica nuestro parser.
  // Su autoridad describe el rendimiento del parser SOBRE esta fuente, y por eso
  // no puede heredarse de una clase.
  if (fila.naturaleza === "INFERIDO") {
    const rinde = fila.cobertura >= UMBRAL_DERIVADO;
    return {
      destino: "REQUIERE_ESPECIFICA",
      nivelPropuesto: rinde ? "supplemental" : "prohibited",
      score: rinde ? 0.35 : 0,
      razon: rinde
        ? `inferido por nuestro parser con ${pct}% de acierto en esta fuente; suplementario porque el valor es nuestro, no suyo`
        : `inferido y solo resuelve el ${pct}%: el vocabulario del parser no encaja con esta fuente`
    };
  }

  if (fila.naturaleza === "NORMALIZADO") {
    return {
      destino: "REQUIERE_ESPECIFICA",
      nivelPropuesto: fila.cobertura >= UMBRAL_DERIVADO ? "acceptable" : "supplemental",
      score: fila.cobertura >= UMBRAL_DERIVADO ? 0.6 : 0.3,
      razon: `extraído del texto por regla determinista, ${pct}% de cobertura; por debajo de un literal porque depende de que la fuente escriba la unidad`
    };
  }

  // Precio: literal y bien publicado, pero su valor depende del mercado. Una
  // regla de clase no puede saber en qué moneda está.
  if (fila.predicado === "price.observed") {
    const mismoMercado = fuente.mercado === "PE";
    return {
      destino: "REQUIERE_ESPECIFICA",
      nivelPropuesto: mismoMercado ? "supplemental" : "prohibited",
      score: mismoMercado ? 0.45 : 0,
      razon: mismoMercado
        ? `${fila.conValor} precios en ${fuente.moneda}, mismo mercado (${fuente.mercado}): sirven para situar un rango, nunca para fijar precio propio`
        : `${fila.conValor} precios en ${fuente.moneda}, mercado ${fuente.mercado}: otra moneda y otra estructura de costes, no comparables con Perú`
    };
  }

  if (auth) return { destino: "HEREDA", razon: `la clase «official» ya concede «${auth.authority_level}» y la evidencia lo respalda (${pct}%)` };

  return {
    destino: "CARECE",
    razon: `ningún patrón registrado casa con «${fila.predicado}»; le ocurre a las seis, así que es un hueco del fallback y no una excepción de esta fuente`
  };
}

const informe = [];
for (const s of inv) {
  const filas = s.filas.map((f) => ({ ...f, ...veredicto(f, s) }));
  informe.push({ fuente: s.fuente, mercado: s.mercado, moneda: s.moneda, clase: s.clase, filas });
}

// ── Contradicciones: entre subsistemas, no dentro de uno ────────────────────
const contradicciones = [];

// 1 · Los predicados que el pipeline emite no casan con ningún patrón.
const huerfanos = [...new Set(informe.flatMap((s) => s.filas.filter((f) => f.destino === "CARECE" && f.conValor > 0).map((f) => f.predicado)))];
if (huerfanos.length) contradicciones.push({
  titulo: "El pipeline emite predicados que el sistema de autoridad no conoce",
  detalle: `${huerfanos.join(", ")} — ninguno casa con identity.*, technical.*, semantic.*, price.* ni media.*, que son los patrones de kind:official. Se están observando datos sobre los que nadie ha decidido nada.`,
  arreglo: "una regla de clase por familia official.*, no seis por fuente"
});

// 2 · La autoridad trata igual a un GTIN y a un id interno de Shopify.
contradicciones.push({
  titulo: "identity.* concede «preferred» tanto al GTIN como al id interno de la tienda",
  detalle: "identidad-guardas.ts ordena GTIN 100 y SOURCE_EXTERNAL_ID 50 justamente porque un id de Shopify solo significa algo dentro de esa tienda. La tabla de autoridad los iguala con el mismo patrón identity.*.",
  arreglo: "separar identity.gtin de identity.source_external_id en las reglas de clase"
});

// 3 · Precio con la misma autoridad en cinco monedas.
contradicciones.push({
  titulo: "price.* concede «acceptable» a las seis, en cinco monedas distintas",
  detalle: "La regla de clase no puede saber el mercado. Un precio de Masglo España en euros llega con la misma autoridad que uno de Cherimoya Perú en soles.",
  arreglo: "override por fuente según mercado; es el caso claro de excepción legítima"
});

// 4 · Derivados presentados como si la fuente los publicara.
const derivadosPobres = informe.flatMap((s) => s.filas.filter((f) => f.naturaleza === "INFERIDO" && f.conValor === 0).map((f) => `${s.fuente}:${f.campo}`));
contradicciones.push({
  titulo: "Los derivados del parser viajan indistinguibles de los campos literales",
  detalle: `official.line y official.finish salen de un vocabulario en español fijado por nosotros. Rinden 53% y 33% en Masglo, 99% y 79% en Admiss, y 0% en las otras cuatro. Casos a cero: ${derivadosPobres.length}.`,
  arreglo: "marcar la naturaleza en la observación y no dejar que un INFERIDO herede autoridad de LITERAL"
});

// ── Impresión ───────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(94)}`);
console.log(`MATRIZ DE AUTORIDAD PROPUESTA  ·  propuesta, nada escrito`);
console.log(`${"═".repeat(94)}`);

for (const s of informe) {
  const g = (d) => s.filas.filter((f) => f.destino === d);
  console.log(`\n\n── ${s.fuente} · mercado ${s.mercado ?? "?"} ──`);
  console.log(`   predicados observados: ${s.filas.filter((f) => f.predicado && f.conValor > 0).length}`);
  console.log(`   heredan kind:official: ${g("HEREDA").length}   ·   requieren específica: ${g("REQUIERE_ESPECIFICA").length}   ·   carecen: ${g("CARECE").length}   ·   sin mapping: ${g("UNMAPPED").length}`);

  for (const [titulo, lista] of [["HEREDA", g("HEREDA")], ["REQUIERE AUTORIDAD ESPECÍFICA", g("REQUIERE_ESPECIFICA")], ["CARECE DE AUTORIDAD", g("CARECE")]]) {
    if (!lista.length) continue;
    console.log(`\n   ${titulo}`);
    for (const f of lista) {
      const nivel = f.nivelPropuesto ? ` → ${f.nivelPropuesto}` : "";
      console.log(`     ${f.predicado.padEnd(30)} ${String(Math.round(f.cobertura * 100) + "%").padStart(5)}${nivel}`);
      console.log(`       ${f.razon}`);
    }
  }
  const um = g("UNMAPPED");
  if (um.length) console.log(`\n   UNMAPPED_SOURCE_FIELD: ${um.map((f) => f.campo).join(", ")}`);
}

console.log(`\n\n${"═".repeat(94)}`);
console.log(`CONTRADICCIONES`);
console.log(`${"═".repeat(94)}`);
for (const [i, c] of contradicciones.entries()) {
  console.log(`\n${i + 1}. ${c.titulo}`);
  console.log(`   ${c.detalle}`);
  console.log(`   → ${c.arreglo}`);
}

const totalEspecificas = informe.reduce((a, s) => a + s.filas.filter((f) => f.destino === "REQUIERE_ESPECIFICA").length, 0);
const totalCarecen = new Set(informe.flatMap((s) => s.filas.filter((f) => f.destino === "CARECE").map((f) => f.predicado))).size;
console.log(`\n\nRESUMEN`);
console.log(`   reglas por fuente propuestas: ${totalEspecificas}   (0145 había puesto 68 sin mirar nada)`);
console.log(`   huecos a tapar en la CLASE:   ${totalCarecen} predicados, una regla cada uno`);

fs.writeFileSync(path.join(ROOT, "outputs", "matriz-autoridad-propuesta.json"),
  JSON.stringify({ informe, contradicciones }, null, 2), "utf8");
console.log(`\n→ outputs/matriz-autoridad-propuesta.json`);
