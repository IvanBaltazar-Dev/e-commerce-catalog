/**
 * Prueba de ida y vuelta: quitar el enriquecimiento de la capa de referencia
 * —como haría una recaptura— y reponerlo solo desde catalog_enrichment_facts.
 *
 * Es el fallo que apareció tres veces: los 295 códigos de barras de Masglo se
 * cosecharon abriendo 304 fichas una a una, y una recarga posterior los dejó en
 * cero sin error ni aviso. Si esta prueba falla, el dato ha vuelto a colgar del
 * snapshot y la siguiente recarga lo perderá igual.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const salida = execFileSync("docker",
  ["exec", "-i", process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog",
   "psql", "-U", "postgres", "-d", "postgres", "-A", "-t", "-f", "-"],
  { input: readFileSync(path.join(ROOT, "supabase", "tests", "enriquecimiento-sobrevive.sql"), "utf8"), encoding: "utf8" });

const n = salida.trim().split("\n").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
const [hechos, antes, trasRecaptura, repuestas, perdidas] = n;

let fallos = 0;
const comprobar = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fallos += 1; };

console.log(`\nEL ENRIQUECIMIENTO SOBREVIVE A LA RECAPTURA\n`);
comprobar(hechos > 0, `hechos de enriquecimiento guardados: ${hechos}`);
comprobar(antes > 0, `variantes con el dato antes: ${antes}`);
comprobar(trasRecaptura === 0, `tras simular la recaptura quedan: ${trasRecaptura}`);
comprobar(repuestas === antes, `repuestas solo desde el enriquecimiento: ${repuestas} de ${antes}`);
comprobar(perdidas === 0, `perdidas: ${perdidas}`);

console.log();
if (fallos) { console.error(`${fallos} comprobación(es) fallan: el enriquecimiento volvería a perderse.\n`); process.exit(1); }
console.log(`Una recaptura ya no puede vaciar lo que costó conseguir.\n`);
