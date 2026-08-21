/**
 * Captura por sitemap. La anterior se dejaba tres cuartas partes del catálogo.
 *
 * `/todos-los-productos` cerró como COMPLETE con 649 productos de BELLESPA y 680
 * de REVEL. Sus sitemaps declaran 2.583 y 1.804. Faltaban 3.058 productos y el
 * contrato de cierre dijo que todo estaba bien.
 *
 * No fue un fallo del contrato: la paginación SÍ terminaba limpiamente. El fallo
 * era el punto de entrada. `/todos-los-productos` tiene tope —con limit=200
 * responde dos páginas y a la tercera devuelve vacío— y ese vacío es un final
 * verdadero de ESE listado, no del catálogo.
 *
 * La lección, que vale para cualquier fuente futura: que un recorrido termine
 * bien no prueba que haya recorrido todo. Hace falta una cifra externa contra la
 * que contrastar, y el sitemap es exactamente eso.
 *
 * Aquí el sitemap hace las dos cosas: da la lista completa de URLs y da el
 * declared_total con el que el cierre puede juzgarse.
 *
 * Uso:
 *   node --experimental-transform-types scripts/captura-sitemap-sumerlabs.mjs bellespa
 *   node --experimental-transform-types scripts/captura-sitemap-sumerlabs.mjs revel --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { clasificarCierre, discrepanciaDeTotal, expandirCodigos } from "../src/lib/catalog-intelligence/captura-contratos.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APLICAR = process.argv.includes("--aplicar");
// Medido, no supuesto: con cuatro peticiones en paralelo fallaron 2.095 de
// 2.583 URLs — el 81%. Secuencial con 300 ms de pausa da 8 de 8. El límite del
// host es de CONCURRENCIA, no de ritmo, y acelerar en paralelo salía mucho más
// lento que ir de una en una porque casi todo había que reintentarlo.
const CONCURRENCIA = 1;
const PAUSA_MS = 320;
const UA = "BellarosheCatalogResearch/1.0";

const TIENDAS = {
  revel: {
    base: "https://tiendaenperu-revelonline98g.sumerlabs.com",
    sourceKey: "revel-pe-sumerlabs",
    nombre: "REVE'L Professional · catálogo mayorista del operador peruano",
    operador: "REVE'L Cosmetics Import Export E.I.R.L.", ruc: "20551491278"
  },
  bellespa: {
    base: "https://bellespacosmetics.sumerlabs.com",
    sourceKey: "bellespa-pe-sumerlabs",
    nombre: "BELLESPA Cosmetics · catálogo mayorista del operador peruano",
    operador: "Droguería Bellaspa Import E.I.R.L.", ruc: "20522264904"
  }
};
const CLAVE = args[0] ?? "bellespa";
const TIENDA = TIENDAS[CLAVE];
if (!TIENDA) { console.error(`Tiendas: ${Object.keys(TIENDAS).join(", ")}`); process.exit(1); }

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** El JSON del producto va suelto en el HTML; se recorta equilibrando llaves. */
function extraerProducto(html) {
  const m = html.match(/"friendlyUrl":"/);
  if (!m) return null;
  let inicio = m.index, nivel = 0;
  while (inicio > 0) {
    const c = html[inicio];
    if (c === "}") nivel += 1;
    if (c === "{") { if (nivel === 0) break; nivel -= 1; }
    inicio -= 1;
  }
  let prof = 0, dentro = false, escapa = false;
  for (let i = inicio; i < html.length; i += 1) {
    const c = html[i];
    if (escapa) { escapa = false; continue; }
    if (c === "\\") { escapa = true; continue; }
    if (c === '"') { dentro = !dentro; continue; }
    if (dentro) continue;
    if (c === "{") prof += 1;
    if (c === "}") { prof -= 1; if (prof === 0) { try { return JSON.parse(html.slice(inicio, i + 1)); } catch { return null; } } }
  }
  return null;
}

function desmontar(texto, nombre) {
  const bruto = `${nombre ?? ""} ${texto ?? ""}`.trim();
  const entre = (bruto.match(/\(([^)]{2,24})\)/) ?? [])[1] ?? null;
  return {
    codigoObservado: entre,
    // Un producto puede declarar varios códigos; se usa la pieza compartida.
    codigosExpandidos: entre ? expandirCodigos(entre) : [],
    unidadesPorBox: Number((bruto.match(/BOX\s*X\s*(\d+)/i) ?? [])[1]) || null,
    unidadesPorCajon: Number((bruto.match(/CAJ[OÓ]N\s*X\s*(\d+)/i) ?? [])[1]) || null,
    marcaEnNombre: (bruto.match(/\b(REVE[`´']?L|BELLESPA)\b/i) ?? [])[1]?.replace(/[`´']/g, "'").toUpperCase() ?? null
  };
}

// ── Sitemap: la lista completa y el total declarado ─────────────────────────
console.log(`Leyendo el sitemap de ${CLAVE}…`);
const xml = await (await fetch(`${TIENDA.base}/sitemap.xml`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) })).text();
const urls = [...new Set([...xml.matchAll(/<loc>([^<]+\/producto\/[^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/https:\/\/[^/]+/, TIENDA.base)))];
const declaredTotal = urls.length;
console.log(`   el sitemap declara ${declaredTotal} productos`);

// ── Recorrido ───────────────────────────────────────────────────────────────
const capturadoEn = new Date().toISOString();
const productos = [];
const fallidas = [];
let hechas = 0;

async function traer(url) {
  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
      if (r.ok) return await r.text();
      await espera(400 * intento);
    } catch { await espera(400 * intento); }
  }
  return null;
}

const cola = [...urls];
await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
  for (;;) {
    const url = cola.shift();
    if (!url) return;
    const html = await traer(url);
    hechas += 1;
    if (hechas % 250 === 0) console.log(`   ${hechas}/${declaredTotal} · capturados ${productos.length} · fallidos ${fallidas.length}`);
    if (!html) { fallidas.push(url); continue; }
    const p = extraerProducto(html);
    if (!p) { fallidas.push(url); continue; }
    const d = desmontar(p.description, p.name);
    productos.push({
      externalId: p.id, url,
      nombre: (p.name ?? "").trim() || (p.description ?? "").split("\n")[0].trim(),
      descripcionRaw: p.description ?? null,
      friendlyUrl: p.friendlyUrl,
      precio: Number(p.price) || null, moneda: "PEN",
      disponible: p.available ?? null,
      categoriaFuente: p.category ?? null,
      imagenes: Array.isArray(p.images) ? p.images.filter((u) => /^https?:\/\//.test(u)) : [],
      ...d
    });
    await espera(PAUSA_MS);
  }
}));

const porId = new Map(productos.map((p) => [p.externalId, p]));
const unicos = [...porId.values()];

const cierre = clasificarCierre({
  declaredTotal,
  itemsCaptured: unicos.length,
  pagesCompleted: urls.length - fallidas.length,
  failedPages: fallidas.length ? [fallidas.length] : [],
  terminoPorVacioCorrecto: true,
  terminoPorTope: false
});
const disc = discrepanciaDeTotal(declaredTotal, unicos.length);

console.log(`\nCierre: ${cierre.closure}${cierre.completion_reason ? ` (${cierre.completion_reason})` : ""} — ${cierre.closure_reason}`);
console.log(`Productos capturados: ${unicos.length} de ${declaredTotal} declarados`);
console.log(`URLs fallidas: ${fallidas.length}`);
console.log(`  con código:  ${unicos.filter((p) => p.codigoObservado).length}`);
console.log(`  con precio:  ${unicos.filter((p) => p.precio).length}`);
console.log(`  con imagen:  ${unicos.filter((p) => p.imagenes.length).length}`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const salida = path.join(ROOT, "outputs", `sitemap-sumerlabs-${CLAVE}.json`);
writeFileSync(salida, JSON.stringify({ capturadoEn, declaredTotal, ...cierre, ...disc, fallidas, productos: unicos }, null, 2), "utf8");
console.log(`\n→ ${salida}`);

if (!APLICAR) { console.log(`\nSin persistir. Añade --aplicar.`); process.exit(0); }

const { data: fuente, error: eF } = await db.from("catalog_sources").upsert({
  source_key: TIENDA.sourceKey, name: TIENDA.nombre,
  authority: "first_party_commercial", adapter: "sumer_ssr_json", base_url: TIENDA.base, is_active: true,
  metadata: { canal: "sumerlabs", operadorDeclarado: TIENDA.operador, rucAportadoPorInvestigacion: TIENDA.ruc, via: "sitemap" }
}, { onConflict: "source_key" }).select("id").single();
if (eF) throw new Error(`catalog_sources: ${eF.message}`);

const hash = sha(unicos.map((p) => p.externalId).sort().join("|"));
let { data: snap, error: eS } = await db.from("catalog_source_snapshots").insert({
  source_id: fuente.id, status: "succeeded",
  started_at: capturadoEn, completed_at: new Date().toISOString(),
  http_status: 200, content_hash: hash,
  product_count: unicos.length, variant_count: 0,
  image_count: unicos.reduce((a, p) => a + p.imagenes.length, 0),
  metadata: {
    via: "sitemap", declared_total: declaredTotal,
    pages_expected: declaredTotal, pages_completed: declaredTotal - fallidas.length,
    items_captured: unicos.length, failed_pages: fallidas.length,
    captured_at: capturadoEn, ...cierre, ...disc
  }
}).select("id").single();
let snapshotId = snap?.id ?? null;
if (eS) {
  if (!/duplicate|unique/i.test(eS.message)) throw new Error(`snapshots: ${eS.message}`);
  const { data: previo } = await db.from("catalog_source_snapshots")
    .select("id").eq("source_id", fuente.id).eq("content_hash", hash).maybeSingle();
  snapshotId = previo?.id ?? null;
  console.log("   captura idéntica a una anterior: se reutiliza su snapshot");
}
if (!snapshotId) throw new Error("sin snapshot con el que continuar");

const registros = unicos.map((p) => ({
  snapshot_id: snapshotId, source_id: fuente.id, entity_type: "product",
  external_id: p.externalId, title: p.nombre || p.codigoObservado || p.externalId,
  source_url: p.url, captured_at: capturadoEn,
  payload: {
    brand: null, source_type: "sumer_sitemap", confidence: "OBSERVADO_CANAL_PRIMERA_PARTE",
    external_product_id: p.externalId, handle: p.friendlyUrl,
    source_product_url: p.url, source_root_url: TIENDA.base,
    description: p.descripcionRaw, product_type: p.categoriaFuente, source_category: p.categoriaFuente,
    marca_en_nombre: p.marcaEnNombre,
    codigo_observado: p.codigoObservado, codigos_declarados: p.codigosExpandidos,
    unidades_por_box: p.unidadesPorBox, unidades_por_cajon: p.unidadesPorCajon,
    price: p.precio, currency: p.moneda, available: p.disponible,
    primary_image_url: p.imagenes[0] ?? null, image_count: String(p.imagenes.length),
    captured_at: capturadoEn
  }
}));

let escritos = 0;
for (let i = 0; i < registros.length; i += 300) {
  const { error } = await db.from("catalog_source_records").insert(registros.slice(i, i + 300));
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(`source_records: ${error.message}`);
  if (error) { console.log("   registros ya presentes: se conservan"); break; }
  escritos += Math.min(300, registros.length - i);
  if (escritos % 1200 === 0 || escritos === registros.length) console.log(`   registros: ${escritos}/${registros.length}`);
}
console.log(`\nFuente ${TIENDA.sourceKey} · snapshot ${snapshotId} · ${escritos} registros`);
