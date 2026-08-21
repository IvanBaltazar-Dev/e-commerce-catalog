/**
 * Certifica que lo retirado no circula y que la historia no se pierde.
 *
 * Las tres primeras cifras deben ser cero: nada retirado puede aparecer en el
 * grafo ni colarse por la vista de vigentes. La cuarta debe ser mayor que cero:
 * si llegara a cero significaría que alguien borró la historia en vez de
 * retirarla, que es justo lo contrario de lo que se pidió.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const salida = execFileSync("docker",
  ["exec", "-i", process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog",
   "psql", "-U", "postgres", "-d", "postgres", "-A", "-t", "-F", "|", "-f", "-"],
  { input: readFileSync(path.join(ROOT, "supabase", "tests", "superseded-no-circula.sql"), "utf8"), encoding: "utf8" });

const [enGrafo, preciosEnGrafo, enVigentes, historia] = salida.trim().split("|").map(Number);
let fallos = 0;
const comprobar = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fallos += 1; };

console.log(`\nCERTIFICACIÓN DE RETIRADOS\n`);
comprobar(enGrafo === 0, `variantes retiradas en el grafo: ${enGrafo}`);
comprobar(preciosEnGrafo === 0, `precios retirados en el grafo: ${preciosEnGrafo}`);
comprobar(enVigentes === 0, `retirados colándose por la vista de vigentes: ${enVigentes}`);
comprobar(historia > 0, `retirados conservados como historia: ${historia}`);

console.log();
if (fallos) { console.error(`${fallos} comprobación(es) fallan.\n`); process.exit(1); }
console.log(`Lo retirado no circula, y sigue estando.\n`);
