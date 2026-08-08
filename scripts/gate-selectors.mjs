/**
 * Contrato de selectores del rediseño (Fase 0, §2.3).
 *
 * Las pruebas de UI navegan la aplicación por selector y por estructura:
 *
 *   .order-qty button:last-child      .product-step-actions .btn-save
 *   .chip-row .opt-chip               .topbar-nav .nav-pill
 *
 * Es decir: un rediseño puede cambiar libremente lo que un selector SIGNIFICA,
 * pero no puede hacerlo desaparecer. Añadir clases nuevas es legítimo y solo
 * se informa.
 *
 * Congela dos inventarios, porque uno solo no alcanza:
 *
 *   · clases   — todo nombre que aparece en cualquier selector. Caza la
 *                desaparición total de una clase.
 *   · reglas base — clases que tienen una regla propia, con el selector exacto
 *                `.x { … }`. Caza el caso traicionero: renombrar o borrar
 *                `.btn-soft { … }` dejando vivo `.sale-payment .btn-soft`.
 *                La clase sigue "existiendo" y el botón se queda sin estilo.
 *
 * Uso:
 *   node scripts/gate-selectors.mjs           → compara contra la línea base
 *   node scripts/gate-selectors.mjs --save    → congela la línea base actual
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = path.join(ROOT, "src", "app", "globals.css");
const BASELINE = path.join(ROOT, "scripts", "lib", "selectors-baseline.json");

/**
 * Extrae los nombres de clase que aparecen en posición de selector.
 *
 * Recorre el CSS con una pila de contextos en vez de regex sobre el archivo
 * entero, porque hay que distinguir tres cosas que se parecen:
 *   · reglas normales            → .btn-primary { … }        cuentan
 *   · pasos de @keyframes        → from { } / 50% { }        no cuentan
 *   · preludios de @media/@supports → abren contexto, no son selectores
 */
function extractInventories(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = new Set();
  const baseRules = new Set();
  const stack = [];
  let buffer = "";

  for (const ch of source) {
    if (ch === "{") {
      const prelude = buffer.trim();
      buffer = "";

      if (prelude.startsWith("@keyframes")) {
        stack.push("keyframes");
      } else if (prelude.startsWith("@")) {
        stack.push("at-rule");
      } else {
        // Los pasos de un keyframe (from, to, 40%) viven dentro de él y no
        // son selectores de nada.
        if (stack[stack.length - 1] !== "keyframes") {
          for (const match of prelude.matchAll(/\.-?[_a-zA-Z][\w-]*/g)) {
            classes.add(match[0]);
          }
          // `.a, .b { … }` son dos reglas base, no una: separar por coma hace
          // que fusionar o partir listas de selectores no dispare el gate.
          for (const part of prelude.split(",")) {
            const selector = part.trim();
            if (/^\.-?[_a-zA-Z][\w-]*$/.test(selector)) baseRules.add(selector);
          }
        }
        stack.push("rule");
      }
      continue;
    }

    if (ch === "}") {
      stack.pop();
      buffer = "";
      continue;
    }

    if (ch === ";" && stack.length === 0) {
      // @import y demás at-rules de una línea.
      buffer = "";
      continue;
    }

    buffer += ch;
  }

  return { classes: [...classes].sort(), baseRules: [...baseRules].sort() };
}

const current = extractInventories(readFileSync(CSS, "utf8"));

if (process.argv.includes("--save")) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ source: "src/app/globals.css", ...current }, null, 2)}\n`,
    "utf8"
  );
  console.log(
    `✓ Línea base congelada: ${current.classes.length} clases · ${current.baseRules.length} reglas base` +
      " → scripts/lib/selectors-baseline.json"
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("✗ No hay línea base. Congélala con: node scripts/gate-selectors.mjs --save");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

function diff(before, after) {
  const present = new Set(after);
  const known = new Set(before);
  return {
    lost: before.filter((name) => !present.has(name)),
    added: after.filter((name) => !known.has(name))
  };
}

const cls = diff(baseline.classes, current.classes);
const base = diff(baseline.baseRules, current.baseRules);

console.log(
  `Clases: ${baseline.classes.length} → ${current.classes.length} · ` +
    `reglas base: ${baseline.baseRules.length} → ${current.baseRules.length}`
);

for (const [etiqueta, added] of [["clase", cls.added], ["regla base", base.added]]) {
  if (!added.length) continue;
  console.log(`\n  + ${added.length} ${etiqueta}(s) nueva(s):`);
  for (const name of added) console.log(`      ${name}`);
}

let roto = false;

if (cls.lost.length) {
  roto = true;
  console.error(`\n✗ ${cls.lost.length} clase(s) PERDIDA(S) por completo:`);
  for (const name of cls.lost) console.error(`      ${name}`);
}

if (base.lost.length) {
  roto = true;
  console.error(`\n✗ ${base.lost.length} regla(s) base PERDIDA(S) — la clase sobrevive sin estilo propio:`);
  for (const name of base.lost) console.error(`      ${name} { … }`);
}

if (roto) {
  console.error("\n  El rediseño puede cambiar lo que un selector significa, no hacerlo desaparecer.");
  console.error("  Si la eliminación es deliberada, recongela con --save y justifícalo en el commit.");
  process.exit(1);
}

console.log("\n✓ Contrato de selectores intacto: ni clases ni reglas base perdidas.");
