/**
 * El gate de cierre, contra los tres fallos que ya ocurrieron de verdad.
 *
 * No es una prueba de laboratorio: cada caso reproduce algo que pasó y que en su
 * momento se leyó como éxito.
 *
 *   A · una URL descubierta que nunca se intentó
 *   B · dos URLs compartiendo artefacto  → la sobrescritura de 2.583 a 2.142
 *   C · descubrimiento corto             → el «COMPLETE · 649» de un catálogo de 2.583
 *   D · el caso legítimo: bajas explicadas (una ausencia, un error permanente)
 *
 * Los tres primeros deben fallar el gate. El cuarto debe pasarlo. Si algún día
 * A, B o C pasan, el cierre ha vuelto a ser una opinión.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL = path.join(ROOT, "supabase", "tests", "gate-cierre-de-captura.sql");
const CONTENEDOR = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog";

const salida = execFileSync("docker",
  ["exec", "-i", CONTENEDOR, "psql", "-U", "postgres", "-d", "postgres", "-f", "-"],
  { input: readFileSync(SQL, "utf8"), encoding: "utf8" });

const esperado = [
  ["A · una URL sin intentar", "f"],
  ["B · dos URLs, un artefacto", "f"],
  ["C · descubrimiento corto", "f"],
  ["D · completo con bajas explicadas", "t"]
];

let fallos = 0;
for (const [caso, debe] of esperado) {
  const linea = salida.split("\n").find((l) => l.includes(caso));
  if (!linea) { console.error(`✗ ${caso}: no apareció en la salida`); fallos += 1; continue; }
  const celdas = linea.split("|").map((c) => c.trim());
  const completa = celdas[7];
  if (completa !== debe) {
    console.error(`✗ ${caso}: puede_declararse_completa = ${completa}, se esperaba ${debe}`);
    fallos += 1;
  } else {
    console.log(`✓ ${caso.padEnd(36)} ${debe === "t" ? "pasa el gate" : "lo bloquea"} · ${celdas[9] ?? ""}`);
  }
}
if (fallos) { console.error(`\n${fallos} caso(s) no se comportan como deben.`); process.exit(1); }
console.log(`\nLos 4 casos se comportan como deben.`);
