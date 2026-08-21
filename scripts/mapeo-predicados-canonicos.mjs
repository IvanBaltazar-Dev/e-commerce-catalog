/**
 * Cruce de los predicados que emite el adaptador contra el vocabulario canónico.
 *
 * El error que corrige: propuse añadir autoridad para official.sku, official.title
 * y seis más, tratándolos como huecos del fallback. No lo son. «official» no es
 * ninguna de las 22 dimensiones registradas — es el namespace del crawler. Darle
 * autoridad habría institucionalizado dos vocabularios en paralelo, y mañana
 * shopify.sku, woocommerce.sku, pdf.sku, cada extractor el suyo.
 *
 * El vocabulario canónico ya existe y ya resuelve:
 *
 *   identity.*   patrón registrado · preferred para kind:official
 *   media.*      patrón registrado · preferred
 *   semantic.<dimensión>   con dimension_code NULL en la regla, así que casa
 *                          con cualquiera de las 22 dimensiones
 *
 * Y el pipeline YA emite semantic.${claim.dimension} en su rama de semántica.
 * O sea que convivían dos convenciones dentro del mismo script: una canónica y
 * otra de crawler. Lo que hay que hacer no es dar autoridad a la segunda, es
 * dejar de emitirla.
 *
 * ── Lo que NO se resuelve renombrando ────────────────────────────────────────
 *
 * Cuatro de los predicados no son observaciones de la fuente sino conclusiones
 * de nuestro parser. Renombrarlos a semantic.* sin más los dejaría heredando la
 * autoridad literal de la fuente, que es justo la confusión a evitar: la fuente
 * tiene autoridad sobre el TEXTO DE ENTRADA, no sobre lo que nuestro regex
 * concluya de él. Por eso llevan clase epistémica y regla versionada.
 *
 *   node --experimental-transform-types scripts/mapeo-predicados-canonicos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── El mapeo ────────────────────────────────────────────────────────────────
// conservaLiteral responde a: ¿queda registrado el valor tal como lo publicó la
// fuente, además del valor transformado? Para un renombrado es trivialmente sí.
// Para una derivación es lo que permite rehacerla cuando la regla cambie.
const MAPEO = [
  {
    emision: "official.title",
    canonico: "identity.name",
    clase: "OBSERVATION_LITERAL",
    regla: "renombrado de namespace; el valor no se toca",
    conservaLiteral: true,
    autoridad: "identity.*",
    nota: "la dimensión identity está descrita como «Names, codes and identity evidence»: el nombre cabe sin forzar nada"
  },
  {
    emision: "official.sku",
    canonico: "identity.manufacturer_sku",
    clase: "OBSERVATION_LITERAL",
    regla: "renombrado + ámbito explícito: el espacio de nombres es la marca que lo emite",
    conservaLiteral: true,
    autoridad: "identity.* — PERO requiere separar identificador global de local",
    nota: "un SKU de fabricante manda dentro de su marca y no fuera; hoy identity.* lo iguala con el id interno de la tienda"
  },
  {
    emision: "official.vendor",
    canonico: "identity.brand_declared",
    clase: "OBSERVATION_LITERAL",
    regla: "renombrado; NO se resuelve a entidad de marca — eso sería DERIVED_INFERRED",
    conservaLiteral: true,
    autoridad: "identity.*",
    nota: "medido: Masglo aparece como MASGLO, Masglo y Masglo España; Bigen como «bigen-usa.com»; Acrylove como «acryloveoficial». Es una etiqueta que configura la tienda, no una marca resuelta"
  },
  {
    emision: "official.product_type",
    canonico: "semantic.type",
    clase: "OBSERVATION_LITERAL",
    regla: "renombrado a la dimensión registrada «type»; el valor sigue siendo la etiqueta de la tienda",
    conservaLiteral: true,
    autoridad: "semantic.* (acceptable 0.9)",
    nota: "medido: Cherimoya tiene 225 tipos distintos en 1.395 fichas y Acrylove y Bigen lo tienen vacío. Es taxonomía de tienda; llevarlo a una clasificación canónica sería otra transformación, DERIVED_INFERRED"
  },
  {
    emision: "official.presentation",
    canonico: "semantic.packaging",
    clase: "NORMALIZED_SOURCE_CLAIM",
    regla: "PRESENTACION_CANTIDAD_UNIDAD v1 · regex de cantidad+unidad sobre título, tipo y tags",
    conservaLiteral: true,
    autoridad: "de la REGLA, no de la fuente",
    nota: "determinista y reversible, por eso NORMALIZED y no DERIVED: de «13,5 ML» a «13.5 ml» sin interpretar nada"
  },
  {
    emision: "official.shade",
    canonico: "semantic.subtype",
    clase: "DERIVED_INFERRED",
    regla: "TONO_POR_SEGMENTO_DE_TITULO v1 · parte el título por « - » y toma el primer segmento",
    conservaLiteral: true,
    autoridad: "de la REGLA, no de la fuente",
    nota: "asume una convención de titulado. Rinde 80% en Masglo y 0% en Cherimoya, y eso mide nuestra regla, no la calidad de Cherimoya"
  },
  {
    emision: "official.line",
    canonico: "semantic.type",
    clase: "DERIVED_INFERRED",
    regla: "NAIL_ES_PRODUCT_SEMANTICS v1 · vocabulario en español sobre los tags",
    conservaLiteral: true,
    autoridad: "de la REGLA, no de la fuente",
    nota: "53% en Masglo, 99% en Admiss, 0-3% en las otras cuatro. Que Admiss rinda 99% demuestra que la regla interpreta bien SUS tags, no que Admiss publique una línea"
  },
  {
    emision: "official.finish",
    canonico: "semantic.finish",
    clase: "DERIVED_INFERRED",
    regla: "NAIL_ES_PRODUCT_SEMANTICS v1 · adjetivos de acabado en español sobre los tags",
    conservaLiteral: true,
    autoridad: "de la REGLA, no de la fuente",
    nota: "misma regla que line; 33% en Masglo, 79% en Admiss, 0% en las otras cuatro"
  },
  {
    emision: "official.primary_image",
    canonico: "media.image",
    clase: "OBSERVATION_LITERAL",
    regla: "renombrado + cualificador rol=primary",
    conservaLiteral: true,
    autoridad: "media.* (preferred)",
    nota: "sigue siendo remote_reference: autoridad sobre qué aspecto tiene el producto, no permiso para publicarla"
  },
  {
    emision: "official.description",
    canonico: null,
    clase: "OBSERVATION_LITERAL",
    regla: "NO se emite como claim: es texto de origen y va en source_excerpt / raw_reference",
    conservaLiteral: true,
    autoridad: "NO_APPLICABLE",
    nota: "no toda observación es una afirmación. La descripción es la ENTRADA de la que se derivarían composición o uso; convertirla en claim confundiría el insumo con la conclusión"
  },
  {
    emision: "availability.observed",
    canonico: null,
    clase: "OBSERVATION_LITERAL",
    regla: "NO se emite como claim: ya está modelado en catalog_reference_prices.external_availability",
    conservaLiteral: true,
    autoridad: "NO_APPLICABLE",
    nota: "la disponibilidad tiene la misma forma que un precio —fuente, mercado, fecha, variante— y por eso vive con él. Nunca es stock de Bellaroshé"
  }
];

// ── ¿Resuelve cada canónico contra una regla ya existente? ───────────────────
const DIMENSION_DE = {
  "identity.name": "identity", "identity.manufacturer_sku": "identity",
  "identity.brand_declared": "identity", "semantic.type": "type",
  "semantic.packaging": "packaging", "semantic.subtype": "subtype",
  "semantic.finish": "finish", "media.image": "media"
};

const { data: fuente } = await db.from("catalog_sources")
  .select("id").eq("source_key", "masglo-es-official").single();

const { data: dims } = await db.from("catalog_semantic_dimensions").select("code");
const dimensionesRegistradas = new Set(dims.map((d) => d.code));

const filas = [];
for (const m of MAPEO) {
  let resuelve = null, nivel = "—";
  if (m.canonico) {
    const dim = DIMENSION_DE[m.canonico] ?? null;
    const { data, error } = await db.rpc("resolve_catalog_source_authority_v1", {
      p_source_id: fuente.id, p_predicate: m.canonico, p_source_field: "*", p_dimension_code: dim
    });
    if (error) throw new Error(`resolver: ${error.message}`);
    resuelve = Boolean(data?.[0]);
    nivel = data?.[0]?.authority_level ?? "SIN REGLA";
    m.dimensionRegistrada = dim ? dimensionesRegistradas.has(dim) : null;
  }
  filas.push({ ...m, resuelve, nivelActual: nivel });
}

console.log(`\n${"═".repeat(100)}`);
console.log(`PREDICADOS DE INGESTA → PREDICADOS CANÓNICOS`);
console.log(`${"═".repeat(100)}\n`);
for (const f of filas) {
  console.log(`${f.emision}`);
  console.log(`   → canónico          ${f.canonico ?? "NINGUNO · no debe ser claim"}`);
  console.log(`   → clase epistémica  ${f.clase}`);
  console.log(`   → transformación    ${f.regla}`);
  console.log(`   → conserva literal  ${f.conservaLiteral ? "sí" : "NO"}`);
  console.log(`   → autoridad         ${f.autoridad}`);
  if (f.canonico) {
    const dimOk = f.dimensionRegistrada === null ? "" : f.dimensionRegistrada ? " · dimensión registrada" : " · DIMENSIÓN NO REGISTRADA";
    console.log(`   → resuelve hoy      ${f.resuelve ? `SÍ (${f.nivelActual})` : "NO"}${dimOk}`);
  }
  console.log(`     ${f.nota}`);
  console.log();
}

const nuevos = filas.filter((f) => f.canonico && !f.resuelve);
const sinClaim = filas.filter((f) => !f.canonico);
console.log(`${"═".repeat(100)}`);
console.log(`RESULTADO`);
console.log(`${"═".repeat(100)}`);
console.log(`   predicados de crawler a retirar:        ${filas.filter((f) => f.emision.startsWith("official.")).length}`);
console.log(`   que ya resuelven contra canónico:       ${filas.filter((f) => f.resuelve).length}`);
console.log(`   que NO deben ser claim:                 ${sinClaim.length}  (${sinClaim.map((f) => f.emision).join(", ")})`);
console.log(`   predicados universales NUEVOS a crear:  ${nuevos.length}${nuevos.length ? "  " + nuevos.map((f) => f.canonico).join(", ") : "  — ninguno: el modelo ya lo representaba todo"}`);
console.log(`   reglas de clase official.* propuestas:  0  (antes propuse 8; eran el namespace del crawler)`);

fs.writeFileSync(path.join(ROOT, "outputs", "mapeo-predicados-canonicos.json"), JSON.stringify(filas, null, 2), "utf8");
console.log(`\n→ outputs/mapeo-predicados-canonicos.json`);
