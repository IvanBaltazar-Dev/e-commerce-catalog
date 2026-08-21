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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { clasificarCierre, discrepanciaDeTotal, puedePromoverseComoCompleta, expandirCodigos } from "../src/lib/catalog-intelligence/captura-contratos.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APLICAR = process.argv.includes("--aplicar");
const ACEPTAR_INCOMPLETA = process.argv.includes("--aceptar-incompleta");
// Medido, nunca supuesto. El host limita por DOS cosas a la vez y hasta no
// separarlas cada ajuste empeoraba el anterior:
//
//   4 hilos ·  120 ms → fallaba el 81% (2.095 de 2.583)
//   1 hilo  ·  320 ms → fallaba el 39%
//   1 hilo  · 1100 ms → 17 de 20 · 1,68 s/ficha
//   2 hilos · 2200 ms → 18 de 20 · 1,40 s/ficha
//   3 hilos · 3300 ms →  0 de 20 · muro, por espaciado que vaya
//   2 hilos · 1400 ms → 17 de 20 · 1,12 s/ficha
//
// Con tres hilos no pasa nada aunque se espere muchísimo, así que hay un tope
// duro de simultaneidad en 2. Y por debajo de ese tope, dos hilos van MÁS
// rápido que uno: la espera es por hilo, el ritmo agregado sale igual, y
// mientras uno espera el otro absorbe la latencia de red.
//
// Descartado por A/B: el User-Agent no influye — 12 de 12 con el nuestro y con
// uno de navegador.
const CONCURRENCIA = 2;
const PAUSA_MS = 1600;

// Aviso para quien venga a «arreglar» esto viendo fallos: NO midas mientras el
// rastreador corre. Me costó dos horas aprenderlo.
//
// Con el rastreo en marcha lancé muestras con curl para diagnosticar y salían 16
// de 20 en error 400. Di por hecho que el host había escalado el bloqueo por
// volumen acumulado, bajé el ritmo y añadí enfriamientos. Todo falso: el
// rastreador iba en ese mismo momento a 95 de 100.
//
// Mis peticiones de diagnóstico eran la TERCERA conexión simultánea, que es
// exactamente la condición que ya había demostrado que tumba el 100%. La
// medición se rompía a sí misma, y encima culpaba al host.
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
// Cerrojo. Dos rastreadores a la vez son cuatro conexiones simultáneas, y a
// partir de tres el host rechaza el 100%: no se reparten el trabajo, se anulan.
//
// Pasó tres veces seguidas y siempre igual — parar la tarea mataba el bash pero
// no al node hijo, así que el siguiente arranque se montaba encima del anterior.
// Desde fuera se veía como «el host nos ha bloqueado» y desde dentro cada
// proceso creía ir solo. Un fichero con el PID lo corta en seco.
const CLAVE_TIENDA = args[0] ?? "bellespa";
const CERROJO = path.join(ROOT, "outputs", `.rastreo-${CLAVE_TIENDA}.lock`);
function vivo(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
if (existsSync(CERROJO)) {
  const previo = Number(readFileSync(CERROJO, "utf8").trim());
  if (previo && previo !== process.pid && vivo(previo)) {
    console.error(`Ya hay un rastreo de ${CLAVE_TIENDA} en marcha (PID ${previo}).`);
    console.error(`Dos a la vez se estorban: el host corta a partir de 3 conexiones.`);
    process.exit(2);
  }
}
mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(CERROJO, String(process.pid), "utf8");
for (const señal of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(señal, () => { try { unlinkSync(CERROJO); } catch {} if (señal !== "exit") process.exit(1); });
}

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

// Las esperas de 400 ms no servían de nada contra un limitador por ritmo: los
// tres reintentos caían dentro de la misma ventana estrangulada y fallaban los
// tres. Ahora la espera crece de verdad y da tiempo a que el cubo se rellene.
async function traer(url) {
  // Una sola reespera, y corta. La escalera de 2 s + 6 s + 15 s costaba hasta
  // 23 s por URL muerta y era justo lo que hundía el ritmo medio a 3,7 s/ficha.
  // Insistir aquí ya no hace falta: el rastreo es reanudable, así que lo que
  // falle en esta pasada lo recoge la siguiente, cuando el cubo esté lleno.
  const esperas = [2500];
  for (let intento = 0; intento < esperas.length + 1; intento += 1) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.text();
      // Un 404 es una respuesta correcta: la ficha ya no existe. Reintentarlo
      // solo gasta cuota que necesitan las que sí están vivas.
      if (r.status === 404) return null;
    } catch { /* red: se reintenta igual */ }
    if (intento < esperas.length) await espera(esperas[intento]);
  }
  return null;
}

// El intento anterior murió a las 500 URLs y se perdió una hora entera de
// rastreo, porque todo vivía en memoria hasta el final. Ahora cada ficha se
// escribe en cuanto se obtiene y una corrida nueva salta lo ya hecho.
//
// Solo se guardan los aciertos: los fallos deben reintentarse en la siguiente
// pasada, que es justamente lo que convierte varias corridas cortas en una
// captura completa.
const CACHE = path.join(ROOT, "outputs", "cache", `sitemap-${CLAVE}`);
mkdirSync(CACHE, { recursive: true });
// El nombre de caché se saca de un hash de la URL, no de una versión saneada del
// slug. La versión saneada ya me falló una vez: escribí /[^w.-]/g en vez de
// /[^\w.-]/g —perdí una barra invertida al generar el parche— y el sanitizador
// pasó a sustituir todo salvo la letra «w», el punto y el guion. Los nombres
// quedaban en «--________-_____-____.json» y URLs distintas colisionaban en el
// mismo fichero, sobrescribiéndose. 2.583 URLs entraron en 2.142 ficheros y el
// rastreo dio por hecho que había terminado.
//
// Un hash no tiene esa clase de fallo: no depende de qué caracteres traiga el
// slug ni de recortarlo a lo ancho.
// El nombre de caché es el SHA-256 COMPLETO de la URL. Nada de saneados ni de
// recortes: un saneado ya falló una vez —quedó /[^w.-]/g en vez de /[^\w.-]/g y
// convirtió los nombres en «--________-_____.json»— y 2.583 URLs se sobrescribieron
// hasta quedar en 2.142 ficheros sin que nada lo denunciara.
//
// El hash resuelve el nombre. Lo que NO resuelve es la pérdida silenciosa, así que
// va aparte: cada ficha guarda su url y, antes de escribir, se comprueba que el
// fichero que hay (si lo hay) sea de esta misma URL. Si no lo es, se para la
// campaña. Una colisión de SHA-256 es imposible en la práctica, pero un fichero
// reaprovechado de otra corrida o una migración a medias sí ocurren, y ese es
// exactamente el fallo que no debe volver a pasar por silencio.
const ficheroDe = (u) => path.join(CACHE, sha(u) + ".json");

function leerFicha(url) {
  const fp = ficheroDe(url);
  if (!existsSync(fp)) return null;
  let ficha;
  try { ficha = JSON.parse(readFileSync(fp, "utf8")); }
  catch { return null; }                       // corrupta: se vuelve a pedir
  if (ficha?.url && ficha.url !== url) {
    throw new Error(
      `COLISIÓN DE CACHÉ en ${path.basename(fp)}\n` +
      `  el fichero dice ser de ${ficha.url}\n` +
      `  y se está leyendo como ${url}\n` +
      `La campaña se detiene: una sobrescritura silenciosa invalida el cierre.`
    );
  }
  return ficha;
}

function escribirFicha(url, registro) {
  leerFicha(url);                              // si hay fichero de otra URL, lanza
  writeFileSync(ficheroDe(url), JSON.stringify({ ...registro, url }), "utf8");
}

let reusados = 0;
const pendientes = [];
for (const u of urls) {
  const ficha = leerFicha(u);                  // lanza si el fichero es de otra URL
  if (ficha) { productos.push(ficha); reusados += 1; continue; }
  pendientes.push(u);
}
if (reusados) console.log(`   ${reusados} fichas ya estaban en caché · quedan ${pendientes.length}`);

const cola = [...pendientes];
await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
  for (;;) {
    const url = cola.shift();
    if (!url) return;
    const html = await traer(url);
    hechas += 1;
    if (hechas % 100 === 0) console.log(`   ${hechas}/${pendientes.length} pedidas · capturadas ${productos.length} · fallidas ${fallidas.length}`);
    if (!html) { fallidas.push(url); continue; }
    const p = extraerProducto(html);
    if (!p) { fallidas.push(url); continue; }
    const d = desmontar(p.description, p.name);
    const registro = {
      externalId: p.id, url,
      nombre: (p.name ?? "").trim() || (p.description ?? "").split("\n")[0].trim(),
      descripcionRaw: p.description ?? null,
      friendlyUrl: p.friendlyUrl,
      precio: Number(p.price) || null, moneda: "PEN",
      disponible: p.available ?? null,
      categoriaFuente: p.category ?? null,
      imagenes: Array.isArray(p.images) ? p.images.filter((u) => /^https?:\/\//.test(u)) : [],
      ...d
    };
    productos.push(registro);
    escribirFicha(url, registro);
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

// Una captura incompleta SÍ puede persistirse, pero nunca por defecto.
//
// La distinción que importa no es «datos buenos» contra «datos malos»: los 488
// productos que sí se capturaron son 488 observaciones ciertas. Lo que una
// captura incompleta no puede sostener es un razonamiento de AUSENCIA.
//
//   «vimos LA-139 en su catálogo»    → válido aunque falte el 80%
//   «SH-168 no está en su catálogo»  → inválido si falta el 80%
//
// Y el embudo vive justamente de la segunda clase de afirmación: los «36 sin
// resolver» eran ausencias medidas contra un catálogo al que le faltaba el 75%.
// De los 36, veinte aparecieron en cuanto se miró el catálogo completo.
//
// Por eso persistir una captura parcial tiene que ser un acto deliberado.
if (!puedePromoverseComoCompleta(cierre.closure)) {
  if (!ACEPTAR_INCOMPLETA) {
    console.error(
      "\nNo se persiste: el cierre es " + cierre.closure + ", no COMPLETE.\n" +
      "Los " + unicos.length + " productos capturados son observaciones válidas, pero este\n" +
      "catálogo no puede servir para afirmar que un código NO existe.\n" +
      "Si aun así los quieres como evidencia parcial: --aceptar-incompleta"
    );
    process.exit(1);
  }
  console.log("\n⚠ Persistiendo captura " + cierre.closure + " por petición explícita.");
  console.log("  Sirve como evidencia de presencia; NO para concluir ausencias.");
}

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
