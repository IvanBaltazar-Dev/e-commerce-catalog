/**
 * Compara dos tandas de capturas de shoot-surfaces y mide cuánto cambió.
 *
 * Existe porque «la aplicación se ve idéntica» es una afirmación verificable,
 * no una opinión: en 0.2 el porcentaje de píxeles distintos debe ser ~0, y en
 * 0.3 debe ser grande a propósito. Un número evita discutir capturas a ojo.
 *
 * Uso: node scripts/compare-shots.mjs <antes> <después>
 */
import sharp from "sharp";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("Uso: node scripts/compare-shots.mjs <etiqueta-antes> <etiqueta-después>");
  process.exit(1);
}

const dirA = path.join(ROOT, "test-results", "redesign", a);
const dirB = path.join(ROOT, "test-results", "redesign", b);
for (const dir of [dirA, dirB]) {
  if (!existsSync(dir)) { console.error(`✗ no existe: ${dir}`); process.exit(1); }
}

// Un píxel cuenta como cambiado si alguno de sus canales se mueve más que esto.
// 8/255 tolera el antialiasing del texto sin tragarse un cambio de color real.
const UMBRAL = 8;

const shots = readdirSync(dirA).filter((f) => f.endsWith(".png"));
let peorNombre = "";
let peor = -1;
const filas = [];

for (const name of shots) {
  const fileB = path.join(dirB, name);
  if (!existsSync(fileB)) { filas.push([name, "—", "falta en la segunda tanda"]); continue; }

  const [imgA, imgB] = await Promise.all(
    [path.join(dirA, name), fileB].map((f) => sharp(f).raw().toBuffer({ resolveWithObject: true }))
  );

  // Alturas distintas ya son un cambio: se compara el solape y se informa.
  const wA = imgA.info.width, hA = imgA.info.height, cA = imgA.info.channels;
  const wB = imgB.info.width, hB = imgB.info.height, cB = imgB.info.channels;
  const w = Math.min(wA, wB), h = Math.min(hA, hB);
  const nota = (wA !== wB || hA !== hB) ? `tamaño ${wA}×${hA} → ${wB}×${hB}` : "";

  let distintos = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const iA = (y * wA + x) * cA;
      const iB = (y * wB + x) * cB;
      if (Math.abs(imgA.data[iA] - imgB.data[iB]) > UMBRAL ||
          Math.abs(imgA.data[iA + 1] - imgB.data[iB + 1]) > UMBRAL ||
          Math.abs(imgA.data[iA + 2] - imgB.data[iB + 2]) > UMBRAL) {
        distintos += 1;
      }
    }
  }

  const pct = (distintos / (w * h)) * 100;
  if (pct > peor) { peor = pct; peorNombre = name; }
  filas.push([name, `${pct.toFixed(2)}%`, nota]);
}

const ancho = Math.max(...filas.map((f) => f[0].length));
for (const [name, pct, nota] of filas) {
  console.log(`  ${name.padEnd(ancho)}  ${String(pct).padStart(7)}  ${nota}`);
}
console.log(`\nMáximo: ${peor.toFixed(2)}% en ${peorNombre}`);
