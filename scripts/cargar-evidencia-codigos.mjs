/**
 * Lleva a code_evidence lo que hasta ahora se recalculaba al vuelo.
 *
 * El embudo vivía en un script: cada corrida lo rehacía desde los ficheros y
 * nadie podía preguntarle a la base «¿qué sabemos de SH-496?». Ahora cada
 * observación queda como una fila con su fuente, su actor y su fecha, y el
 * resumen se deriva.
 *
 * La regla que hace honesto el recuento sigue viva aquí: NO se deduplica por
 * código. Si tres fuentes vieron SH-496, son tres evidencias — el resumen sabrá
 * que son tres fuentes distintas y subirá la confianza por eso, no por haberlo
 * visto tres veces en la misma.
 *
 * Uso:
 *   node --experimental-transform-types scripts/cargar-evidencia-codigos.mjs
 *   node --experimental-transform-types scripts/cargar-evidencia-codigos.mjs --aplicar
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");

const { normalizarCodigo } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/catalog-intelligence/captura-contratos.ts")).href
);

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const fuentes = await todas("catalog_sources", "id, source_key, authority, metadata");
const fuentePorKey = new Map(fuentes.map((f) => [f.source_key, f]));

// Qué clase de evidencia aporta cada fuente. No se deduce de la autoridad: un
// catálogo de primera parte y el de otro distribuidor tienen la misma autoridad
// y dicen cosas distintas sobre vigencia.
const CLASE_POR_FUENTE = {
  "revel-pe-sumerlabs": { tipo: "CURRENT_CATALOG", actor: "REVEL" },
  "bellespa-pe-sumerlabs": { tipo: "OTHER_DISTRIBUTOR", actor: "BELLESPA" },
  "datosperu-20551491278": { tipo: "TRADE_HISTORY", actor: "REVEL" },
  "datosperu-20522264904": { tipo: "TRADE_HISTORY", actor: "BELLESPA" },
  "veritrade-pe-revel": { tipo: "TRADE_HISTORY", actor: "REVEL" }
};

const registros = await todas(
  "catalog_source_records",
  "id, source_id, snapshot_id, entity_type, title, payload, captured_at"
);

const evidencias = [];
const sinClase = new Map();

for (const r of registros) {
  const fuente = fuentes.find((f) => f.id === r.source_id);
  if (!fuente) continue;
  const clase = CLASE_POR_FUENTE[fuente.source_key];
  if (!clase) { sinClase.set(fuente.source_key, (sinClase.get(fuente.source_key) ?? 0) + 1); continue; }

  const p = r.payload ?? {};
  // Un registro de catálogo trae un código; uno aduanero puede traer varios.
  const codigos = p.codigos_declarados ?? (p.codigo_observado ? [p.codigo_observado] : []);
  for (const codigo of codigos) {
    const norm = normalizarCodigo(codigo);
    if (!norm) continue;
    // Disponible y publicado son cosas distintas, y las dos son ciertas a la vez.
    //
    // El buscador de la tienda indexa 649 productos; su sitemap publica 2.583.
    // No se contradicen: solo entra en el índice lo que está disponible. En la
    // muestra, 23 de 97 fichas tenían disponible=true — el 24%, que es
    // exactamente 649/2.583.
    //
    // Un producto agotado sigue probando que ese operador lo vende: el código
    // existe, tiene nombre, precio y foto. Lo que ya no prueba es vigencia. Por
    // eso se emiten DOS evidencias, no una sustituyendo a la otra: la de quién
    // lo publica y la de en qué estado está.
    const tipos = [clase.tipo];
    if (p.available === false) tipos.push("CURRENTLY_UNAVAILABLE");

    for (const tipo of tipos) evidencias.push({
      normalized_code: norm,
      observed_code: String(codigo),
      evidence_type: tipo,
      source_id: r.source_id,
      snapshot_id: r.snapshot_id,
      source_record_id: r.id,
      actor_key: clase.actor,
      observed_name: r.title ?? null,
      // La marca del envase, no la de la tienda: BELLESPA publica REVE'L.
      observed_brand: p.marca_en_nombre ?? p.marca_declarada ?? null,
      observed_presentation: p.contenido ? `${p.contenido}${p.unidad_contenido ?? ""}` : null,
      observed_at: p.fecha_declarada ? interpretarFecha(p.fecha_declarada, r.captured_at) : r.captured_at,
      raw_text: (p.descripcion_raw ?? p.description ?? "").slice(0, 2000) || null,
      metadata: {
        fuente: fuente.source_key,
        partida: p.partida ?? null,
        notificacion: p.notificacion_declarada ?? null,
        lote: p.lote ?? null,
        origen: p.origen ?? null,
        unidadesPorBox: p.unidades_por_box ?? null,
        disponibleEnFuente: p.available ?? null
      }
    });
  }
}

/** «15/01/2025» es la fecha del hecho; captured_at es cuándo lo miramos. */
function interpretarFecha(texto, respaldo) {
  const m = String(texto).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return respaldo;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`).toISOString();
}

// La clave natural es (código, tipo, fuente, registro). Dos observaciones del
// mismo registro son la misma; dos registros distintos son dos evidencias.
const porClave = new Map();
for (const e of evidencias) {
  porClave.set(`${e.normalized_code}|${e.evidence_type}|${e.source_id}|${e.source_record_id}`, e);
}
const unicas = [...porClave.values()];

const porTipo = new Map();
for (const e of unicas) porTipo.set(e.evidence_type, (porTipo.get(e.evidence_type) ?? 0) + 1);
const codigosDistintos = new Set(unicas.map((e) => e.normalized_code));

console.log(`Registros de fuente revisados: ${registros.length}`);
console.log(`Evidencias de código: ${unicas.length}`);
console.log(`Códigos distintos: ${codigosDistintos.size}\n`);
for (const [t, n] of [...porTipo].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(6)}  ${t}`);
if (sinClase.size) {
  console.log(`\nFuentes sin clase de evidencia declarada (se ignoran, no se adivinan):`);
  for (const [k, n] of sinClase) console.log(`   ${String(n).padStart(6)}  ${k}`);
}

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`);
  process.exit(0);
}

const antes = (await db.from("code_evidence").select("*", { count: "exact", head: true })).count ?? 0;
let escritas = 0;
for (let i = 0; i < unicas.length; i += 400) {
  const lote = unicas.slice(i, i + 400);
  const { error } = await db.from("code_evidence").upsert(lote, {
    onConflict: "evidence_key",
    ignoreDuplicates: true
  });
  if (error) throw new Error(`code_evidence: ${error.message}`);
  escritas += lote.length;
  if (escritas % 4000 === 0 || escritas === unicas.length) console.log(`   ${escritas}/${unicas.length}`);
}
const despues = (await db.from("code_evidence").select("*", { count: "exact", head: true })).count ?? 0;
console.log(`\ncode_evidence: ${antes} → ${despues}  (delta ${despues - antes})`);
