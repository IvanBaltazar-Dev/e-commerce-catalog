/**
 * Renombra las fichas de caché al SHA-256 completo de su propia URL.
 *
 * La ficha lleva dentro la url con la que se capturó, así que la migración no
 * necesita adivinar nada ni repetir una sola petición: se lee, se comprueba y se
 * reescribe con el nombre correcto.
 *
 * Lo que sí hace falta es denunciar lo que la caché anterior perdió. Con nombres
 * saneados dos URLs podían caer en el mismo fichero y una sobrescribía a la otra
 * en silencio; aquí se cuenta cuántas URLs del sitemap se quedaron sin ficha, que
 * es la medida real del daño.
 *
 *   node --experimental-transform-types scripts/migrar-cache-sha256.mjs <tienda> [--aplicar]
 */
import crypto from "node:crypto";
import path from "node:path";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const CLAVE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "bellespa";
const CACHE = path.join(ROOT, "outputs", "cache", `sitemap-${CLAVE}`);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

if (!existsSync(CACHE)) { console.error(`No existe ${CACHE}`); process.exit(1); }

const ficheros = readdirSync(CACHE).filter((f) => f.endsWith(".json"));
const porUrl = new Map();
let sinUrl = 0, corruptas = 0, yaCorrectas = 0;

for (const f of ficheros) {
  const fp = path.join(CACHE, f);
  let ficha;
  try { ficha = JSON.parse(readFileSync(fp, "utf8")); } catch { corruptas += 1; continue; }
  if (!ficha?.url) { sinUrl += 1; continue; }
  // Si dos ficheros dicen ser de la misma URL, gana el que ya tiene el nombre
  // correcto; si ninguno lo tiene, da igual cuál, porque el contenido es el mismo.
  const esperado = `${sha(ficha.url)}.json`;
  if (f === esperado) yaCorrectas += 1;
  const previo = porUrl.get(ficha.url);
  if (!previo || f === esperado) porUrl.set(ficha.url, { ficha, origen: f, esperado });
}

console.log(`Caché de ${CLAVE}`);
console.log(`  ficheros:            ${ficheros.length}`);
console.log(`  con nombre correcto: ${yaCorrectas}`);
console.log(`  URLs distintas:      ${porUrl.size}`);
if (corruptas) console.log(`  ilegibles:           ${corruptas}`);
if (sinUrl) console.log(`  sin url dentro:      ${sinUrl}  (irrecuperables: no se sabe de quién son)`);

const listaUrls = path.join(ROOT, "outputs", `sitemap-sumerlabs-${CLAVE}.json`);
if (existsSync(listaUrls)) {
  const j = JSON.parse(readFileSync(listaUrls, "utf8"));
  const declaradas = j.declaredTotal ?? null;
  if (declaradas !== null) {
    const huecos = declaradas - porUrl.size;
    console.log(`  declaradas en sitemap: ${declaradas}`);
    console.log(`  ${huecos > 0 ? `SIN FICHA: ${huecos}  ← lo que la caché anterior perdió` : "sin huecos"}`);
  }
}

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

let movidas = 0, borradas = 0;
for (const { ficha, origen, esperado } of porUrl.values()) {
  if (origen !== esperado) { writeFileSync(path.join(CACHE, esperado), JSON.stringify(ficha), "utf8"); movidas += 1; }
}
const validos = new Set([...porUrl.values()].map((x) => x.esperado));
for (const f of readdirSync(CACHE).filter((f) => f.endsWith(".json"))) {
  if (!validos.has(f)) { unlinkSync(path.join(CACHE, f)); borradas += 1; }
}
console.log(`\nrenombradas: ${movidas} · retiradas (nombre viejo o sin url): ${borradas}`);
console.log(`caché final: ${readdirSync(CACHE).filter((f) => f.endsWith(".json")).length} ficheros`);
