/**
 * Vuelca el enriquecimiento sobre la capa de referencia. Se ejecuta DESPUÉS de
 * cada captura, siempre.
 *
 * Es la otra mitad de que el enriquecimiento pertenezca a la identidad: guardarlo
 * aparte no sirve de nada si nadie lo vuelve a poner donde se lee. Sin este paso,
 * una recaptura seguiría dejando la capa de referencia empobrecida — solo que
 * ahora el dato estaría a salvo en vez de perdido.
 *
 * Es idempotente y no pisa lo que ya esté puesto con otro valor: si la fuente
 * empieza a publicar el campo por su cuenta y dice algo distinto, eso es un
 * conflicto que hay que ver, no algo que este script deba resolver en silencio.
 *
 *   node --experimental-transform-types scripts/aplicar-enriquecimiento.mjs [--aplicar]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/**
 * Qué campo de enriquecimiento va a qué columna. Explícito a propósito: un mapeo
 * automático por nombre acabaría escribiendo en columnas que nadie decidió.
 */
const DESTINO = {
  barcode: { tabla: "catalog_reference_variants", columna: "barcode" },
  shade_name: { tabla: "catalog_reference_variants", columna: "shade_name" },
  presentation: { tabla: "catalog_reference_variants", columna: "presentation" },
};

const idNumerico = (e) => String(e ?? "").split(":").pop();

const hechos = await leerTodo({
  consulta: () => db.from("catalog_enrichment_vigente_v1")
    .select("source_id, source_key, entity_kind, external_id, field, value, valores_para_este_campo"),
  orden: ["source_key", "external_id", "field"], clave: (r) => `${r.source_id}|${r.external_id}|${r.field}|${r.value}`,
  nombre: "enriquecimiento vigente",
});

const conflictos = hechos.filter((h) => h.valores_para_este_campo > 1);
console.log(`Enriquecimiento vigente: ${hechos.length} hechos`);
if (conflictos.length) {
  console.log(`  CON CONFLICTO (dos valores para el mismo campo): ${conflictos.length}`);
  for (const c of conflictos.slice(0, 5)) console.log(`     ${c.source_key} ${c.external_id} ${c.field} = ${c.value}`);
}

const registros = await leerTodo({
  consulta: () => db.from("catalog_source_records").select("id, source_id, entity_type, external_id"),
  orden: ["id"], clave: (r) => r.id, nombre: "registros de fuente",
});
const identidadPorRegistro = new Map(
  registros.map((r) => [r.id, `${r.source_id}|${r.entity_type}|${idNumerico(r.external_id)}`]));

const variantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, primary_source_record_id, barcode, shade_name, presentation"),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes vigentes",
});

const porIdentidad = new Map();
for (const h of hechos) {
  if (h.valores_para_este_campo > 1) continue;   // los conflictos no se aplican solos
  porIdentidad.set(`${h.source_id}|${h.entity_kind}|${h.external_id}|${h.field}`, h.value);
}

const aEscribir = [];
const yaPuestos = [];
const discrepancias = [];
for (const v of variantes) {
  const identidad = identidadPorRegistro.get(v.primary_source_record_id);
  if (!identidad) continue;
  for (const [campo, destino] of Object.entries(DESTINO)) {
    if (destino.tabla !== "catalog_reference_variants") continue;
    const valor = porIdentidad.get(`${identidad}|${campo}`);
    if (!valor) continue;
    const actual = v[destino.columna];
    if (actual === valor) { yaPuestos.push(campo); continue; }
    // La fuente dice una cosa y el enriquecimiento otra. No se pisa: se reporta.
    if (actual) { discrepancias.push({ id: v.id, campo, enBase: actual, enriquecido: valor }); continue; }
    aEscribir.push({ id: v.id, columna: destino.columna, valor });
  }
}

console.log(`\nSobre ${variantes.length} variantes vigentes:`);
console.log(`  ya tenían el valor      ${String(yaPuestos.length).padStart(6)}`);
console.log(`  a escribir              ${String(aEscribir.length).padStart(6)}`);
console.log(`  discrepancias           ${String(discrepancias.length).padStart(6)}${discrepancias.length ? "   ← no se pisan, se reportan" : ""}`);
for (const d of discrepancias.slice(0, 5)) console.log(`     ${d.campo}: base «${d.enBase}» vs enriquecido «${d.enriquecido}»`);

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

let n = 0;
for (const e of aEscribir) {
  const { error } = await db.from("catalog_reference_variants").update({ [e.columna]: e.valor }).eq("id", e.id);
  if (error) throw new Error(`${e.columna}: ${error.message}`);
  n += 1;
}
console.log(`\n  aplicados: ${n}`);

const { count: conGtin } = await db.from("catalog_reference_variants_vigentes_v1")
  .select("*", { count: "exact", head: true }).not("barcode", "is", null);
console.log(`  variantes vigentes con GTIN: ${conGtin}`);
