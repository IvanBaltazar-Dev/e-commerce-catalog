/**
 * Congela la matriz de autoridad y la prueba contra las reglas que la hacen
 * defendible. Ninguna de estas comprobaciones es teórica: cada una bloquea un
 * error que ya se cometió en 0145.
 *
 *   1 · Ninguna regla por fuente puede repetir lo que la clase ya concede.
 *       Ese fue el fallo: 54 reglas que decían lo mismo que el fallback.
 *   2 · Un INFERIDO no puede ser «preferred». El valor lo fabrica nuestro parser
 *       y su acierto varía del 0% al 99% según la fuente.
 *   3 · Toda propuesta de excepción cita su número medido. Sin la cuenta al
 *       lado no hay forma de revisarla ni de saber cuándo caducó.
 *   4 · Un UNMAPPED no arrastra dimensión. Inventar una dimensión para acomodar
 *       un campo es cómo se cuelan ejes que nadie decidió.
 *   5 · Lo que le falta a las seis va a la clase, no seis veces por fuente.
 *   6 · La huella detecta que el catálogo cambió bajo la matriz.
 *
 *   node --experimental-transform-types scripts/test-matriz-autoridad.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = path.join(ROOT, "outputs", "matriz-autoridad-propuesta.json");
const CONGELADA = path.join(ROOT, "docs", "matriz-autoridad-congelada.json");
const { informe, contradicciones } = JSON.parse(fs.readFileSync(RUTA, "utf8"));

let fallos = 0;
const mal = (msg) => { console.error(`  ✗ ${msg}`); fallos += 1; };
const bien = (msg) => console.log(`  ✓ ${msg}`);

console.log(`\nPRUEBAS DE LA MATRIZ\n`);

// ── 1 · Ninguna excepción repite el fallback ────────────────────────────────
{
  const repetidas = [];
  for (const s of informe) {
    for (const f of s.filas) {
      if (f.destino !== "REQUIERE_ESPECIFICA") continue;
      if (f.autoridadActual && f.autoridadActual.authority_level === f.nivelPropuesto) {
        repetidas.push(`${s.fuente}:${f.predicado} propone «${f.nivelPropuesto}» y la clase ya lo concede`);
      }
    }
  }
  repetidas.length
    ? repetidas.forEach(mal)
    : bien(`ninguna excepción repite lo que la clase ya concede`);
}

// ── 2 · Ningún inferido con autoridad de literal ────────────────────────────
{
  const malos = informe.flatMap((s) => s.filas
    .filter((f) => f.naturaleza === "INFERIDO" && ["preferred", "acceptable"].includes(f.nivelPropuesto))
    .map((f) => `${s.fuente}:${f.predicado} es INFERIDO y se propone «${f.nivelPropuesto}»`));
  malos.length ? malos.forEach(mal) : bien(`ningún valor inferido se propone por encima de «supplemental»`);
}

// ── 3 · Toda excepción cita su medida ───────────────────────────────────────
{
  const sinCuenta = informe.flatMap((s) => s.filas
    .filter((f) => f.destino === "REQUIERE_ESPECIFICA" && !/\d/.test(f.razon ?? ""))
    .map((f) => `${s.fuente}:${f.predicado} propone excepción sin citar ninguna cuenta`));
  sinCuenta.length ? sinCuenta.forEach(mal) : bien(`las ${informe.reduce((a, s) => a + s.filas.filter((f) => f.destino === "REQUIERE_ESPECIFICA").length, 0)} excepciones citan su número medido`);
}

// ── 4 · Un campo sin predicado no arrastra dimensión ────────────────────────
{
  const inventadas = informe.flatMap((s) => s.filas
    .filter((f) => f.destino === "UNMAPPED" && f.dimension)
    .map((f) => `${s.fuente}:${f.campo} está UNMAPPED pero trae dimensión «${f.dimension}»`));
  inventadas.length ? inventadas.forEach(mal) : bien(`ningún campo sin predicado arrastra una dimensión inventada`);
}

// ── 5 · Lo común va a la clase ──────────────────────────────────────────────
{
  const porPredicado = new Map();
  for (const s of informe) {
    for (const f of s.filas.filter((x) => x.destino === "CARECE" && x.predicado)) {
      porPredicado.set(f.predicado, (porPredicado.get(f.predicado) ?? 0) + 1);
    }
  }
  const enTodas = [...porPredicado.entries()].filter(([, n]) => n === informe.length).map(([p]) => p);
  enTodas.length
    ? bien(`${enTodas.length} predicados carecen de autoridad en las ${informe.length} fuentes: van a la clase, no ${enTodas.length * informe.length} reglas por fuente`)
    : bien(`no hay huecos comunes a todas las fuentes`);

  // Y ninguno de esos debe aparecer además como excepción por fuente.
  const duplicados = informe.flatMap((s) => s.filas
    .filter((f) => f.destino === "REQUIERE_ESPECIFICA" && enTodas.includes(f.predicado))
    .map((f) => `${s.fuente}:${f.predicado} es hueco de clase y se propone además como excepción`));
  duplicados.length ? duplicados.forEach(mal) : bien(`ningún hueco de clase se propone además fuente por fuente`);
}

// ── 6 · Huella del catálogo bajo la matriz ──────────────────────────────────
{
  const material = informe.map((s) => `${s.fuente}|` +
    s.filas.map((f) => `${f.campo}:${f.predicado ?? "-"}:${f.conValor}/${f.universo}`).join(",")).join("\n");
  const huella = crypto.createHash("sha256").update(material).digest("hex");

  fs.mkdirSync(path.dirname(CONGELADA), { recursive: true });
  if (fs.existsSync(CONGELADA)) {
    const previa = JSON.parse(fs.readFileSync(CONGELADA, "utf8"));
    if (previa.huella !== huella) {
      mal(`la huella cambió: ${previa.huella.slice(0, 12)} → ${huella.slice(0, 12)}`);
      console.error(`     el catálogo se movió bajo la matriz. Revisa el inventario antes de dar por buenas las propuestas.`);
    } else bien(`huella intacta (${huella.slice(0, 12)}): el catálogo no se ha movido`);
  } else {
    fs.writeFileSync(CONGELADA, JSON.stringify({
      congelada_en: "sin fecha: se sella con la huella, no con el reloj",
      huella,
      fuentes: informe.length,
      excepciones_propuestas: informe.reduce((a, s) => a + s.filas.filter((f) => f.destino === "REQUIERE_ESPECIFICA").length, 0),
      huecos_de_clase: [...new Set(informe.flatMap((s) => s.filas.filter((f) => f.destino === "CARECE").map((f) => f.predicado)))],
      contradicciones: contradicciones.map((c) => c.titulo),
      informe
    }, null, 2), "utf8");
    bien(`matriz congelada con huella ${huella.slice(0, 12)} → docs/matriz-autoridad-congelada.json`);
  }
}

console.log();
if (fallos) { console.error(`${fallos} comprobación(es) fallan. La matriz no está lista para poblarse.\n`); process.exit(1); }
console.log(`La matriz pasa las 6 comprobaciones. Sigue siendo una PROPUESTA: nada escrito en autoridad.\n`);
