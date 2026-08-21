/**
 * Campaña de comercio exterior por DatosPerú.
 *
 * Veritrade bloquea el acceso programático y vende sus registros. DatosPerú
 * publica los mismos hechos aduaneros y responde con normalidad — no hay que
 * romper nada para tener la historia.
 *
 * Y esta capa contesta la pregunta que el catálogo vivo no puede. De nuestros
 * 57 códigos REVEL/BELLESPA solo 3 siguen listados hoy; el resto puede estar
 * perfectamente en los registros de importación, que no rotan.
 *
 * El hallazgo metodológico que ordena todo esto:
 *
 *     código + tiempo + actor + fuente  >  nombre + marca
 *
 * La descripción aduanera es genérica —«KIT BRILLO GLOSS», «LIP GLOSS»— y el
 * catálogo conserva el nombre comercial —«COLOR LIPCERIN», «DIAMOND MAGIC LIP
 * GLOSS»—. Emparejarlos por nombre no funcionaría nunca. Por código exacto, sí.
 *
 * Una advertencia que el propio dato impone: una línea aduanera puede declarar
 * VARIOS códigos a la vez —«SH-607,608», «LA-302,306,309,310,311»— y cada uno
 * corresponde después a una ficha comercial distinta. Se extraen todos.
 *
 * Uso:
 *   node scripts/campana-datosperu.mjs <ruc> <slug-empresa>            (ensayo)
 *   node scripts/campana-datosperu.mjs <ruc> <slug-empresa> --aplicar
 *
 * Ejemplo:
 *   node scripts/campana-datosperu.mjs 20551491278 drogueria-revel-cosmetics-import-export-eirl
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APLICAR = process.argv.includes("--aplicar");
const [RUC, SLUG] = args;
const PARTIDA = process.argv.includes("--partida")
  ? process.argv[process.argv.indexOf("--partida") + 1]
  : "33";

if (!RUC || !SLUG) {
  console.error("Uso: node scripts/campana-datosperu.mjs <ruc> <slug-empresa> [--partida 33] [--aplicar]");
  process.exit(1);
}

const BASE = "https://www.datosperu.org";
const PAUSA_MS = 900;
const UA = "BellarosheCatalogResearch/1.0";

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const urlDe = (n) =>
  `${BASE}/comercio-exterior-de-${SLUG}-${RUC}-en-la-partida-${PARTIDA}-en-la-operacion-de-importaciones${n > 1 ? `-pagina-${n}` : ""}.php`;

function aTexto(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#180;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/**
 * De una línea aduanera salen varias observaciones. El texto crudo se conserva
 * entero: si mañana mejora esta regla hay que poder releer lo que la declaración
 * dijo, y no lo que creímos entender hoy.
 */
function desmontar(linea) {
  const bruto = linea.replace(/\s+/g, " ").trim();
  const nso = (bruto.match(/\b(NSO[A-Z]?\d{4,6}-\d{2}[A-Z]{2})\b/i) ?? [])[1] ?? null;

  // El código se busca SIN la notificación delante: «NSOC45974-20PE» encaja en
  // el patrón de código y se colaría como referencia del producto.
  const sinNso = nso ? bruto.replace(new RegExp(nso, "gi"), " ") : bruto;

  // Una línea puede declarar varios códigos: «SH-607,608» son dos fichas
  // distintas, y «LA-302,306,309,310,311» son cinco. Perderlos sería perder
  // exactamente la identidad que se vino a buscar.
  const codigos = new Set();
  for (const m of sinNso.matchAll(/\b([A-Z]{2,4})-?\s?(\d{2,4})((?:\s?,\s?\d{2,4})*)/gi)) {
    const prefijo = m[1].toUpperCase();
    codigos.add(`${prefijo}-${m[2]}`);
    for (const extra of (m[3] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      codigos.add(`${prefijo}-${extra}`);
    }
  }
  for (const m of sinNso.matchAll(/#\s?(\d{4,8})/g)) codigos.add(`#${m[1]}`);

  const lote = (bruto.match(/LOTE\s*:?\s*([A-Z0-9-]{4,20})/i) ?? [])[1] ?? null;
  const pack = (bruto.match(/BOX\s*X?\s*(\d+)\s*(?:PCS|PZAS|UNID)?/i) ?? [])[1] ?? null;
  const contenido = bruto.match(/\b(\d+(?:[.,]\d+)?)\s*(ML|GR|G|KG|OZ)\b/i) ?? [];
  const anio = (bruto.match(/\b(20\d{2})\b/) ?? [])[1] ?? null;
  const origen = (bruto.match(/\b(CHINA|COLOMBIA|BRASIL|MEXICO|ESTADOS UNIDOS|COREA|INDIA)\b/i) ?? [])[1] ?? null;
  const marca = (bruto.match(/\b(REVE[`´']?L|BELLESPA|CHARM LIMIT|CANDY SECRET|KONSUNG)\b/i) ?? [])[1] ?? null;

  return {
    descripcionRaw: bruto,
    codigos: [...codigos],
    notificacion: nso ? nso.toUpperCase() : null,
    lote,
    unidadesPorBox: pack ? Number(pack) : null,
    contenido: contenido[1] ? Number(String(contenido[1]).replace(",", ".")) : null,
    unidadContenido: contenido[2] ? contenido[2].toUpperCase() : null,
    anio: anio ? Number(anio) : null,
    origen: origen ? origen.toUpperCase() : null,
    marcaDeclarada: marca ? marca.replace(/[`´']/g, "'").toUpperCase() : null
  };
}

// ── Captura ─────────────────────────────────────────────────────────────────
console.log(`Capturando comercio exterior · RUC ${RUC} · partida ${PARTIDA}…`);
const paginas = [];
const fallidas = [];
let pagina = 1;
let sinDatos = 0;

for (;;) {
  const url = urlDe(pagina);
  let html = null;
  for (let intento = 1; intento <= 3 && html === null; intento += 1) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) { html = await r.text(); break; }
      if (r.status === 404) break;   // no hay más páginas: eso sí es el final
      await espera(PAUSA_MS * 3 * intento);
    } catch { await espera(PAUSA_MS * 3 * intento); }
  }

  if (html === null) {
    // Igual que en la campaña de catálogo: un fallo NO es el fin. Se salta, se
    // cuenta, y al final se dice qué faltó — no se promueve como completo.
    fallidas.push(pagina);
    if (fallidas.length >= 3 && fallidas.slice(-3).every((p, i, a) => i === 0 || p === a[i - 1] + 1)) break;
    pagina += 1;
    if (pagina > 60) break;
    await espera(PAUSA_MS);
    continue;
  }

  const texto = aTexto(html);
  const lineas = texto.split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /NSO|LOTE|BOX X|KG/i.test(l) && l.length > 60);

  if (!lineas.length) { sinDatos += 1; if (sinDatos >= 2) break; }
  else sinDatos = 0;

  paginas.push({ pagina, url, lineas, contentHash: sha(html) });
  if (pagina % 5 === 0) console.log(`   ${pagina} páginas · ${paginas.reduce((a, p) => a + p.lineas.length, 0)} líneas…`);
  pagina += 1;
  if (pagina > 60) break;
  await espera(PAUSA_MS);
}

const declaraciones = paginas.flatMap((p) => p.lineas.map((l) => ({ ...desmontar(l), pagina: p.pagina, url: p.url })));
const porHuella = new Map();
for (const d of declaraciones) porHuella.set(sha(d.descripcionRaw).slice(0, 24), d);
const unicas = [...porHuella.values()];

const codigos = new Set();
for (const d of unicas) for (const c of d.codigos) codigos.add(c.toUpperCase());
const nsos = new Map();
for (const d of unicas) {
  if (!d.notificacion) continue;
  if (!nsos.has(d.notificacion)) nsos.set(d.notificacion, new Set());
  for (const c of d.codigos) nsos.get(d.notificacion).add(c.toUpperCase());
}

console.log(`\nPáginas capturadas: ${paginas.length}`);
if (fallidas.length) console.log(`⚠ páginas que fallaron: ${fallidas.join(", ")} — la captura NO está completa`);
console.log(`Declaraciones únicas: ${unicas.length}`);
console.log(`  con código:       ${unicas.filter((d) => d.codigos.length).length}`);
console.log(`  con más de uno:   ${unicas.filter((d) => d.codigos.length > 1).length}`);
console.log(`  con notificación: ${unicas.filter((d) => d.notificacion).length}`);
console.log(`  con lote:         ${unicas.filter((d) => d.lote).length}`);
console.log(`  con contenido:    ${unicas.filter((d) => d.contenido).length}`);
console.log(`\nCódigos distintos observados: ${codigos.size}`);
console.log(`   ${[...codigos].slice(0, 20).join(", ")}${codigos.size > 20 ? " …" : ""}`);

if (nsos.size) {
  console.log(`\nNotificaciones: ${nsos.size}`);
  for (const [n, cs] of [...nsos].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`   ${n}  →  ${cs.size} código(s)`);
    if (cs.size > 1) console.log(`      ⚠ ampara varios: NO es identidad de producto`);
  }
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const salida = path.join(ROOT, "outputs", `datosperu-${RUC}-p${PARTIDA}.json`);
writeFileSync(salida, JSON.stringify({
  ruc: RUC, partida: PARTIDA, capturadoEn: new Date().toISOString(),
  paginas: paginas.length, paginasFallidas: fallidas,
  declaraciones: unicas
}, null, 2), "utf8");
console.log(`\n→ ${salida}`);

if (!APLICAR) {
  console.log(`\nSin persistir. Añade --aplicar.`);
  process.exit(0);
}

// ── Persistencia ────────────────────────────────────────────────────────────
const { data: fuente, error: errFuente } = await db.from("catalog_sources").upsert({
  source_key: `datosperu-${RUC}`,
  name: `Comercio exterior · RUC ${RUC} (DatosPerú)`,
  authority: "trade_record",
  adapter: "html",
  base_url: BASE,
  is_active: true,
  metadata: { ruc: RUC, slug: SLUG, partida: PARTIDA }
}, { onConflict: "source_key" }).select("id").single();
if (errFuente) throw new Error(`catalog_sources: ${errFuente.message}`);

const hashGlobal = sha(paginas.map((p) => p.contentHash).join("|"));
let { data: snap, error: errSnap } = await db.from("catalog_source_snapshots").insert({
  source_id: fuente.id, status: "succeeded",
  started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  http_status: 200, content_hash: hashGlobal,
  product_count: unicas.length, variant_count: 0, image_count: 0,
  metadata: { paginas: paginas.length, paginasFallidas: fallidas, partida: PARTIDA }
}).select("id").single();

let snapshotId = snap?.id ?? null;
if (errSnap) {
  if (!/duplicate|unique/i.test(errSnap.message)) throw new Error(`catalog_source_snapshots: ${errSnap.message}`);
  const { data: previo } = await db.from("catalog_source_snapshots")
    .select("id").eq("source_id", fuente.id).eq("content_hash", hashGlobal).maybeSingle();
  snapshotId = previo?.id ?? null;
  console.log("   captura idéntica a una anterior: se reutiliza su snapshot");
}
if (!snapshotId) throw new Error("no hay snapshot con el que continuar");

const capturadoEn = new Date().toISOString();
const registros = unicas.map((d) => ({
  snapshot_id: snapshotId, source_id: fuente.id,
  entity_type: "document",
  external_id: `${RUC}:${sha(d.descripcionRaw).slice(0, 16)}`,
  title: d.codigos[0] ?? `declaración p${d.pagina}`,
  source_url: d.url,
  captured_at: capturadoEn,
  payload: {
    tipo: "declaracion_importacion",
    descripcion_raw: d.descripcionRaw,
    codigos_declarados: d.codigos,
    notificacion_declarada: d.notificacion,
    lote: d.lote,
    unidades_por_box: d.unidadesPorBox,
    contenido: d.contenido,
    unidad_contenido: d.unidadContenido,
    anio: d.anio,
    origen: d.origen,
    marca_declarada: d.marcaDeclarada,
    ruc_importador: RUC,
    partida: PARTIDA
  }
}));

let escritos = 0;
for (let i = 0; i < registros.length; i += 200) {
  const { error } = await db.from("catalog_source_records").insert(registros.slice(i, i + 200));
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(`catalog_source_records: ${error.message}`);
  if (error) { console.log("   declaraciones ya presentes: se conservan"); break; }
  escritos += Math.min(200, registros.length - i);
}
console.log(`\nsource_records escritos: ${escritos}`);

let notifs = 0, sujetos = 0;
for (const [valor, cs] of nsos) {
  const { data: n, error } = await db.from("regulatory_notifications").upsert({
    value: valor, jurisdiction: "PE", authority: "DIGEMID",
    notification_kind: "sanitary_notification",
    current_status: "observed", scope: "unknown",
    source_id: fuente.id,
    source_url: unicas.find((d) => d.notificacion === valor)?.url ?? BASE,
    raw_excerpt: unicas.find((d) => d.notificacion === valor)?.descripcionRaw?.slice(0, 500) ?? null,
    metadata: { codigosObservados: [...cs], ruc: RUC }
  }, { onConflict: "value,jurisdiction,authority" }).select("id").single();
  if (error) { console.error(`   ✗ ${valor}: ${error.message}`); continue; }
  notifs += 1;
  for (const codigo of cs) {
    const { error: e2 } = await db.from("regulatory_notification_subjects").insert({
      notification_id: n.id, declared_code: codigo,
      declared_name: unicas.find((d) => d.codigos.includes(codigo))?.descripcionRaw?.slice(0, 200) ?? null,
      observed_at: capturadoEn
    });
    if (!e2) sujetos += 1;
  }
}
console.log(`Notificaciones: ${notifs} · sujetos declarados: ${sujetos}`);
