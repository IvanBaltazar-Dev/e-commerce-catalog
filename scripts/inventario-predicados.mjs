/**
 * Inventario de lo que las seis fuentes publican DE VERDAD, antes de declarar
 * ninguna autoridad sobre ello.
 *
 * El orden importa y la vez anterior lo hice al revés: escribí 54 reglas de
 * autoridad —una plantilla multiplicada por seis tiendas— sin haber mirado un
 * solo campo. Declaraban a las seis «preferred» en línea y acabado sin
 * comprobar si alguna publica línea o acabado. No lo hacen: esos dos valores los
 * fabrica un regex nuestro sobre los tags.
 *
 * Aquí cada fila de la matriz sale de contar filas reales, y la autoridad
 * propuesta se justifica con esa cuenta o no se propone.
 *
 * ── Las tres naturalezas, que no pueden mezclarse ──────────────────────────
 *
 *   LITERAL     la fuente lo publica en su propio campo. «sku»: "310053".
 *   NORMALIZADO  se obtiene del texto por una regla determinista y reversible.
 *                «13,5 ML» en el título → presentación "13.5 ml".
 *   INFERIDO     hace falta interpretar. shadeName parte el título por « - » y
 *                asume que lo de delante es el tono; line busca en los tags un
 *                vocabulario que decidimos nosotros.
 *
 * Un INFERIDO no puede heredar la autoridad de un LITERAL. Si el título no sigue
 * la convención que asumimos, el valor sale mal y la fuente no tiene ninguna
 * culpa — ni ninguna autoridad sobre él.
 *
 *   node --experimental-transform-types scripts/inventario-predicados.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseOfficialProduct } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/catalog-intelligence/shopify-official-adapter.mjs")).href
);

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = [
  "masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"
];

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let d = 0; ; d += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(d, d + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

// ── El mapa campo→predicado, escrito a mano y a propósito ───────────────────
// No se deduce del nombre del campo. «width» de una imagen son píxeles y la
// dimensión «dimensions» del sistema semántico son medidas del producto: un
// mapeo automático por parecido de nombre las habría fundido.
//
// predicado: null significa UNMAPPED_SOURCE_FIELD. No se inventa dimensión para
// acomodarlo — se reporta y se decide después, que es una decisión distinta.
const MAPA = [
  // ── identidad ─────────────────────────────────────────────────────────────
  { campo: "sku",                 entidad: "variant", predicado: "official.sku",           dimension: "identity",  naturaleza: "LITERAL" },
  { campo: "barcode",             entidad: "variant", predicado: "identity.gtin",          dimension: "identity",  naturaleza: "LITERAL" },
  { campo: "external_product_id", entidad: "product", predicado: "identity.source_external_id", dimension: "identity", naturaleza: "LITERAL" },
  { campo: "external_variant_id", entidad: "variant", predicado: "identity.source_external_id", dimension: "identity", naturaleza: "LITERAL" },

  // ── denominación ──────────────────────────────────────────────────────────
  { campo: "title",         entidad: "product", predicado: "official.title",        dimension: "type",     naturaleza: "LITERAL" },
  { campo: "variant_title", entidad: "variant", predicado: "official.variant_title", dimension: "type",    naturaleza: "LITERAL" },
  { campo: "vendor",        entidad: "product", predicado: "official.vendor",       dimension: "identity", naturaleza: "LITERAL" },
  { campo: "product_type",  entidad: "product", predicado: "official.product_type", dimension: "type",     naturaleza: "LITERAL" },

  // ── derivados del texto: NO son campos de la fuente ───────────────────────
  { campo: "(parsed) presentation", entidad: "product", predicado: "official.presentation", dimension: "packaging", naturaleza: "NORMALIZADO",
    nota: "regex de cantidad+unidad sobre título, tipo y tags" },
  { campo: "(parsed) shadeName", entidad: "product", predicado: "official.shade", dimension: "type", naturaleza: "INFERIDO",
    nota: "parte el título por « - » y asume que lo de delante es el tono" },
  { campo: "(parsed) line", entidad: "product", predicado: "official.line", dimension: "type", naturaleza: "INFERIDO",
    nota: "busca en los tags un vocabulario en español que fijamos nosotros" },
  { campo: "(parsed) finish", entidad: "product", predicado: "official.finish", dimension: "finish", naturaleza: "INFERIDO",
    nota: "igual que line, con adjetivos de acabado en español" },

  // ── comercial ─────────────────────────────────────────────────────────────
  { campo: "price",     entidad: "variant", predicado: "price.observed",   dimension: "price", naturaleza: "LITERAL" },
  { campo: "available", entidad: "variant", predicado: "availability.observed", dimension: null, naturaleza: "LITERAL" },

  // ── medios ────────────────────────────────────────────────────────────────
  { campo: "primary_image_url", entidad: "product", predicado: "official.primary_image", dimension: "media", naturaleza: "LITERAL" },
  { campo: "image_url",         entidad: "image",   predicado: "media.image",            dimension: "media", naturaleza: "LITERAL" },

  // ── texto libre: literal como TEXTO, nunca como composición ───────────────
  { campo: "description", entidad: "product", predicado: "official.description", dimension: null, naturaleza: "LITERAL",
    nota: "el texto es literal; extraer de él composición o uso ya sería INFERIDO y no está hecho" },
  { campo: "tags", entidad: "product", predicado: null, dimension: null, naturaleza: "LITERAL",
    nota: "bolsa de etiquetas sin vocabulario declarado: mezcla gama, tamaño, línea y promoción" },

  // ── sin predicado: se reportan, no se acomodan ────────────────────────────
  { campo: "handle",        entidad: "product", predicado: null, dimension: null, naturaleza: "LITERAL", nota: "identificador de URL, no del producto" },
  { campo: "option1",       entidad: "variant", predicado: null, dimension: null, naturaleza: "LITERAL", nota: "el eje de variación no viene nombrado" },
  { campo: "width",         entidad: "image",   predicado: null, dimension: null, naturaleza: "LITERAL", nota: "píxeles de la imagen; NO es la dimensión «dimensions» del producto" },
  { campo: "height",        entidad: "image",   predicado: null, dimension: null, naturaleza: "LITERAL", nota: "ídem" },
  { campo: "image_position",entidad: "image",   predicado: null, dimension: null, naturaleza: "LITERAL", nota: "orden de galería" },
  { campo: "published_at",  entidad: "product", predicado: null, dimension: null, naturaleza: "LITERAL", nota: "fecha de publicación en la tienda" },
  { campo: "updated_at",    entidad: "product", predicado: null, dimension: null, naturaleza: "LITERAL", nota: "última edición en la tienda" },
  { campo: "variant_count", entidad: "product", predicado: null, dimension: null, naturaleza: "NORMALIZADO", nota: "recuento nuestro" },
  { campo: "image_count",   entidad: "product", predicado: null, dimension: null, naturaleza: "NORMALIZADO", nota: "recuento nuestro" },

  // ── anotaciones NUESTRAS que no son observación de la fuente ──────────────
  { campo: "confidence",  entidad: "product", predicado: null, dimension: null, naturaleza: "ANOTACION_PROPIA",
    nota: "«CONFIRMADO_OFICIAL» lo escribimos nosotros; la tienda no publica su propia confianza" },
  { campo: "source_type", entidad: "product", predicado: null, dimension: null, naturaleza: "ANOTACION_PROPIA", nota: "cómo lo capturamos" },
  { campo: "brand",       entidad: "product", predicado: null, dimension: null, naturaleza: "ANOTACION_PROPIA",
    nota: "lo fija la campaña al lanzarse, no la ficha; «vendor» sí es de la fuente" },
];

const { data: fuentes } = await db.from("catalog_sources")
  .select("id, source_key, authority, metadata").in("source_key", FUENTES);
const idPorClave = Object.fromEntries(fuentes.map((f) => [f.source_key, f.id]));

const registros = await todas("catalog_source_records",
  "source_id, entity_type, sku, barcode, title, primary_image_url, payload",
  (q) => q.in("source_id", fuentes.map((f) => f.id)));

// ── Autoridad hoy vigente para cada predicado, preguntándoselo al resolutor ──
const predicados = [...new Set(MAPA.filter((m) => m.predicado).map((m) => m.predicado))];
async function autoridadDe(sourceId, predicado, dimension) {
  const { data, error } = await db.rpc("resolve_catalog_source_authority_v1", {
    p_source_id: sourceId, p_predicate: predicado,
    p_source_field: "*", p_dimension_code: dimension
  });
  if (error) throw new Error(`resolver: ${error.message}`);
  return data?.[0] ?? null;
}

const salida = [];
console.log(`\n${"═".repeat(96)}`);
console.log(`INVENTARIO DE PREDICADOS OBSERVADOS · seis fuentes de marca`);
console.log(`${"═".repeat(96)}`);

for (const clave of FUENTES) {
  const id = idPorClave[clave];
  const f = fuentes.find((x) => x.id === id);
  const regs = registros.filter((r) => r.source_id === id);
  const porEntidad = {
    product: regs.filter((r) => r.entity_type === "product"),
    variant: regs.filter((r) => r.entity_type === "variant"),
    image:   regs.filter((r) => r.entity_type === "image"),
  };

  // Rendimiento real de los cuatro derivados, ejecutando el parser sobre las
  // fichas de ESTA fuente. Es la única forma honesta de saber si sirve aquí.
  const rendimientoParsed = { presentation: 0, shadeName: 0, line: 0, finish: 0 };
  for (const r of porEntidad.product) {
    const p = r.payload ?? {};
    const parsed = parseOfficialProduct({
      title: p.title, product_type: p.product_type,
      tags: typeof p.tags === "string" ? p.tags.split(" | ") : (p.tags ?? [])
    });
    for (const k of Object.keys(rendimientoParsed)) if (parsed[k]) rendimientoParsed[k] += 1;
  }

  const filas = [];
  for (const m of MAPA) {
    const universo = porEntidad[m.entidad] ?? [];
    if (!universo.length) continue;
    let conValor = 0;
    if (m.campo.startsWith("(parsed) ")) {
      conValor = rendimientoParsed[m.campo.replace("(parsed) ", "")] ?? 0;
    } else if (["sku", "barcode", "title", "primary_image_url"].includes(m.campo)) {
      conValor = universo.filter((r) => r[m.campo] !== null && r[m.campo] !== "").length;
    } else {
      conValor = universo.filter((r) => {
        const v = r.payload?.[m.campo];
        return v !== null && v !== undefined && v !== "";
      }).length;
    }
    const cobertura = universo.length ? conValor / universo.length : 0;
    const auth = m.predicado ? await autoridadDe(id, m.predicado, m.dimension) : null;
    filas.push({ ...m, universo: universo.length, conValor, cobertura, autoridadActual: auth });
  }
  salida.push({ fuente: clave, mercado: f.metadata?.market ?? null, moneda: f.metadata?.currency ?? null, clase: f.authority, filas, rendimientoParsed });
}

// ── Impresión ───────────────────────────────────────────────────────────────
for (const s of salida) {
  console.log(`\n\n── ${s.fuente}  ·  clase «${s.clase}» · mercado ${s.mercado ?? "?"} ──\n`);
  console.log(`   ${"CAMPO BRUTO".padEnd(24)} ${"PREDICADO".padEnd(30)} ${"DIMENSIÓN".padEnd(11)} ${"NATURALEZA".padEnd(16)} ${"COBERTURA".padEnd(16)} AUTORIDAD HOY`);
  console.log(`   ${"-".repeat(24)} ${"-".repeat(30)} ${"-".repeat(11)} ${"-".repeat(16)} ${"-".repeat(16)} ${"-".repeat(14)}`);
  for (const r of s.filas) {
    const pred = r.predicado ?? "UNMAPPED_SOURCE_FIELD";
    const pct = `${r.conValor}/${r.universo}`.padEnd(11) + `${Math.round(r.cobertura * 100)}%`;
    const auth = r.predicado ? (r.autoridadActual ? `${r.autoridadActual.authority_level}` : "SIN REGLA") : "—";
    console.log(`   ${r.campo.padEnd(24)} ${pred.padEnd(30)} ${(r.dimension ?? "—").padEnd(11)} ${r.naturaleza.padEnd(16)} ${pct.padEnd(16)} ${auth}`);
  }
}

fs.writeFileSync(path.join(ROOT, "outputs", "inventario-predicados.json"), JSON.stringify(salida, null, 2), "utf8");
console.log(`\n\n→ outputs/inventario-predicados.json`);
