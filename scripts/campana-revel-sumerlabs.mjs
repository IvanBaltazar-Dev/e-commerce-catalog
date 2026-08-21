/**
 * Campaña REVEL · catálogo Sumerlabs del operador de marca.
 *
 * Primera campaña que entra por el mecanismo definitivo: fuente registrada →
 * captura → source_records → universo de referencia → reconciliación. Si el
 * patrón aguanta aquí, aguanta para LS241, Charm Limit, SUN y los bloques de
 * 5.000 que vengan.
 *
 * La fuente no es Shopify ni Woo: es una SPA de Sumerlabs que sirve su catálogo
 * como JSON embebido en el HTML renderizado. 29 páginas de 24 productos, 680 en
 * total. Y la descripción trae la estructura mayorista completa:
 *
 *   "(SH-437) CARNIVAL INTERSTELLAR PALETTE REVEL\nBOX X6PCS\n\nCAJON X48UNIDADES"
 *
 * Código, nombre, unidades por box y por cajón, todo en un campo de texto.
 *
 * Dos separaciones que NO se colapsan:
 *
 *   La categoría de la fuente es de la fuente. «CREMAS CORPORALES 🦋» y «CREMAS
 *   CORPORALES» conviven en su catálogo, y «RUBORES» con «RUBOR». Eso se guarda
 *   como source_category y jamás como clase técnica nuestra.
 *
 *   El código va como CODE_SYSTEM, y la marca escrita en el nombre va como
 *   observación. `SH-*` cruza categorías —esmaltes, cremas corporales, gloss— y
 *   ya sabemos que los sistemas de código cruzan marcas.
 *
 * Uso:
 *   node scripts/campana-revel-sumerlabs.mjs             (captura y resume)
 *   node scripts/campana-revel-sumerlabs.mjs --aplicar   (persiste)
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { clasificarCierre, puedePromoverseComoCompleta } from "../src/lib/catalog-intelligence/captura-contratos.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const BASE = "https://tiendaenperu-revelonline98g.sumerlabs.com";
const RUTA = "/todos-los-productos";
const PAUSA_MS = 1200;
const UA = "BellarosheCatalogResearch/1.0";

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * El JSON del producto vive suelto dentro del HTML, sin un contenedor que lo
 * delimite. Se localiza por su campo `friendlyUrl` y se recorta contando llaves
 * hacia atrás y hacia adelante: un `JSON.parse` de todo el documento no existe,
 * y una expresión regular no sabe equilibrar llaves anidadas.
 */
function extraerProductos(html) {
  const productos = [];
  for (const m of html.matchAll(/"friendlyUrl":"/g)) {
    let inicio = m.index;
    let nivel = 0;
    while (inicio > 0) {
      const c = html[inicio];
      if (c === "}") nivel += 1;
      if (c === "{") { if (nivel === 0) break; nivel -= 1; }
      inicio -= 1;
    }
    let fin = m.index, prof = 0, dentro = false, escapa = false;
    for (let i = inicio; i < html.length; i += 1) {
      const c = html[i];
      if (escapa) { escapa = false; continue; }
      if (c === "\\") { escapa = true; continue; }
      if (c === '"') { dentro = !dentro; continue; }
      if (dentro) continue;
      if (c === "{") prof += 1;
      if (c === "}") { prof -= 1; if (prof === 0) { fin = i; break; } }
    }
    try {
      const obj = JSON.parse(html.slice(inicio, fin + 1));
      if (obj.friendlyUrl && obj.id) productos.push(obj);
    } catch { /* fragmento incompleto: se ignora sin ruido */ }
  }
  return productos;
}

/**
 * La descripción mayorista, desmontada. Se conserva SIEMPRE el texto original:
 * lo que se derive de él es derivación, y si mañana mejora la regla hay que
 * poder volver a leer lo que la fuente dijo de verdad.
 */
function desmontarDescripcion(texto) {
  const bruto = (texto ?? "").trim();
  const codigo = (bruto.match(/^\(([^)]{2,20})\)/) ?? [])[1] ?? null;
  const porBox = (bruto.match(/BOX\s*X\s*(\d+)\s*(?:PCS|PZAS|UNID)?/i) ?? [])[1] ?? null;
  const porCajon = (bruto.match(/CAJ[OÓ]N\s*X\s*(\d+)/i) ?? [])[1] ?? null;
  const contenido = (bruto.match(/(\d+(?:[.,]\d+)?)\s*(ML|GR?|G|OZ|PCS)\b/i) ?? []);
  return {
    codigoObservado: codigo,
    unidadesPorBox: porBox ? Number(porBox) : null,
    unidadesPorCajon: porCajon ? Number(porCajon) : null,
    contenido: contenido[1] ? Number(String(contenido[1]).replace(",", ".")) : null,
    unidadContenido: contenido[2] ? contenido[2].toUpperCase() : null
  };
}

// ── Captura ─────────────────────────────────────────────────────────────────
const capturadoEn = new Date().toISOString();
const paginas = [];
let pagina = 1;

console.log("Capturando catálogo REVEL…");
// Un HTTP 400 a mitad de recorrido NO es el fin del catálogo. La primera versión
// de esto lo trató como tal, paró en la página 15 y reportó 336 productos como
// si fueran todos — cuando las páginas 15 y 16 respondían 200 al pedirlas
// sueltas. Era limitación por ritmo.
//
// Un catálogo a medias que se presenta como completo es peor que un fallo: el
// universo de referencia habría aprendido la mitad y nadie lo habría sabido.
// Por eso solo se acepta el final cuando una respuesta CORRECTA viene vacía.
const REINTENTOS = 4;
let fallosSeguidos = 0;
// Cómo terminó el recorrido: solo una respuesta CORRECTA y vacía cierra bien.
let terminoLimpio = false;
let terminoPorTope = false;

for (;;) {
  const url = `${BASE}${RUTA}${pagina > 1 ? `?page=${pagina}` : ""}`;
  let html = null;

  for (let intento = 1; intento <= REINTENTOS && html === null; intento += 1) {
    try {
      const respuesta = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (respuesta.ok) { html = await respuesta.text(); break; }
      const pausa = PAUSA_MS * 4 * intento;
      console.log(`   página ${pagina}: HTTP ${respuesta.status}, reintento ${intento}/${REINTENTOS} en ${pausa} ms`);
      await espera(pausa);
    } catch (error) {
      console.log(`   página ${pagina}: ${error.message}, reintento ${intento}/${REINTENTOS}`);
      await espera(PAUSA_MS * 4 * intento);
    }
  }

  if (html === null) {
    fallosSeguidos += 1;
    // Se cuenta y se sigue: saltar una página y avisar es mejor que parar y
    // fingir que el catálogo terminó ahí.
    console.log(`   página ${pagina}: NO SE PUDO CAPTURAR tras ${REINTENTOS} intentos — se salta`);
    if (fallosSeguidos >= 3) { console.log(`   tres páginas seguidas sin respuesta: se detiene`); break; }
    pagina += 1;
    await espera(PAUSA_MS * 6);
    continue;
  }

  fallosSeguidos = 0;
  const productos = extraerProductos(html);
  if (!productos.length) { terminoLimpio = true; console.log(`   página ${pagina}: respuesta correcta y vacía — fin real del catálogo`); break; }
  paginas.push({ pagina, url, productos, contentHash: sha(html) });
  if (pagina % 5 === 0) console.log(`   ${pagina} páginas · ${paginas.reduce((a, p) => a + p.productos.length, 0)} productos…`);
  pagina += 1;
  if (pagina > 60) { terminoPorTope = true; console.log("   tope de seguridad a 60 páginas"); break; }
  await espera(PAUSA_MS);
}

const paginasFallidas = [];
for (let i = 1; i < pagina; i += 1) if (!paginas.some((p) => p.pagina === i)) paginasFallidas.push(i);
if (paginasFallidas.length) {
  console.log(`\n⚠ Páginas que no se pudieron capturar: ${paginasFallidas.join(", ")}`);
  console.log(`  La captura NO está completa y no debe promoverse como si lo estuviera.`);
}

const crudos = paginas.flatMap((p) => p.productos);
const porId = new Map(crudos.map((p) => [p.id, p]));
const productos = [...porId.values()];

// El cierre se clasifica, no se supone. Una corrida solo puede promoverse como
// el catálogo entero si demuestra que llegó al final; cualquier otra cosa queda
// marcada y visible.
const cierre = clasificarCierre({
  declaredTotal: null,
  itemsCaptured: productos.length,
  pagesCompleted: paginas.length,
  failedPages: paginasFallidas,
  terminoPorVacioCorrecto: terminoLimpio,
  terminoPorTope: terminoPorTope
});
console.log(`\nCierre de la captura: ${cierre.closure} — ${cierre.closure_reason}`);
if (!puedePromoverseComoCompleta(cierre.closure)) {
  console.log(`  Esta captura NO debe promoverse como el catálogo completo.`);
}

const normalizados = productos.map((p) => {
  const d = desmontarDescripcion(p.description);
  return {
    externalId: p.id,
    nombre: (p.name ?? p.title ?? "").trim() || (p.description ?? "").split("\n")[0].trim(),
    descripcionRaw: p.description ?? null,
    friendlyUrl: p.friendlyUrl,
    url: `${BASE}/producto/${p.friendlyUrl}`,
    precio: typeof p.price === "number" ? p.price : (Number(p.price) || null),
    moneda: "PEN",
    disponible: p.available ?? p.isAvailable ?? null,
    // La categoría de la fuente se guarda como es, con emoji y con sus
    // duplicados. Es un hecho sobre cómo ELLOS ordenan, no sobre qué es.
    categoriaFuente: p.category ?? null,
    imagenes: Array.isArray(p.images) ? p.images.filter((u) => /^https?:\/\//.test(u)) : [],
    ...d
  };
});

const conCodigo = normalizados.filter((p) => p.codigoObservado);
const sistemas = new Map();
for (const p of conCodigo) {
  const s = (p.codigoObservado.match(/^([A-Za-z]{1,5})/) ?? [])[1]?.toUpperCase() ?? "(sin prefijo)";
  sistemas.set(s, (sistemas.get(s) ?? 0) + 1);
}
const categorias = new Set(normalizados.map((p) => p.categoriaFuente).filter(Boolean));

console.log(`\nPáginas capturadas: ${paginas.length}`);
console.log(`Productos: ${productos.length}  (únicos por id)`);
console.log(`  con código en la descripción: ${conCodigo.length} (${Math.round(conCodigo.length / productos.length * 100)}%)`);
console.log(`  con precio:                   ${normalizados.filter((p) => p.precio).length}`);
console.log(`  con imagen:                   ${normalizados.filter((p) => p.imagenes.length).length}`);
console.log(`  con unidades por box:         ${normalizados.filter((p) => p.unidadesPorBox).length}`);
console.log(`  con unidades por cajón:       ${normalizados.filter((p) => p.unidadesPorCajon).length}`);
console.log(`  con contenido (ml/gr):        ${normalizados.filter((p) => p.contenido).length}`);
console.log(`\nSistemas de código observados: ${sistemas.size}`);
for (const [s, n] of [...sistemas].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(n).padStart(4)}  ${s}`);
console.log(`\nCategorías de la fuente: ${categorias.size}  (se guardan como suyas, no como nuestras)`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "campana-revel.json"),
  JSON.stringify({ capturadoEn, paginas: paginas.length, productos: normalizados }, null, 2), "utf8");
console.log(`\n→ outputs/campana-revel.json`);

if (!APLICAR) {
  console.log(`\nCaptura sin persistir. Añade --aplicar para registrar fuente y source_records.`);
  process.exit(0);
}

// ── Persistencia ────────────────────────────────────────────────────────────
const { data: fuente, error: errFuente } = await db.from("catalog_sources").upsert({
  source_key: "revel-pe-sumerlabs",
  name: "REVE'L Professional · catálogo mayorista del operador peruano",
  // Canal propio de quien opera la marca en Perú: manda sobre código, nombre
  // comercial, precio y disponibilidad. No sobre fabricante ni composición.
  authority: "first_party_commercial",
  adapter: "sumer_ssr_json",
  base_url: BASE,
  is_active: true,
  metadata: {
    canal: "sumerlabs",
    operadorDeclarado: "REVE'L Cosmetics Import Export E.I.R.L.",
    // Aportado por investigación externa, no por esta captura: se marca como tal
    // para que nadie lo tome por un hecho verificado desde la fuente.
    rucAportadoPorInvestigacion: "20551491278",
    corroboracionPendiente: "RUC y titularidad de marca no verificados desde esta fuente"
  }
}, { onConflict: "source_key" }).select("id").single();
if (errFuente) throw new Error(`catalog_sources: ${errFuente.message}`);

const { data: snap, error: errSnap } = await db.from("catalog_source_snapshots").insert({
  source_id: fuente.id,
  status: "succeeded",
  started_at: capturadoEn,
  completed_at: new Date().toISOString(),
  http_status: 200,
  content_hash: sha(paginas.map((p) => p.contentHash).join("|")),
  product_count: productos.length,
  variant_count: 0,
  image_count: normalizados.reduce((a, p) => a + p.imagenes.length, 0),
  // El contrato de captura, completo. Sin esto, una corrida que trajera 640 de
  // 698 quedaría indistinguible de un catálogo que encogió — y son cosas
  // opuestas: la primera es un fallo nuestro, la segunda un hecho de la fuente.
  metadata: {
    ruta: RUTA,
    declared_total: null,   // Sumerlabs no publica un total; si algún día lo hace, aquí va
    pages_expected: paginas.length + paginasFallidas.length,
    pages_completed: paginas.length,
    items_captured: productos.length,
    first_page: paginas.length ? paginas[0].pagina : null,
    last_page: paginas.length ? paginas[paginas.length - 1].pagina : null,
    failed_pages: paginasFallidas,
    captured_at: capturadoEn,
    ...cierre
  }
}).select("id").single();
if (errSnap) throw new Error(`catalog_source_snapshots: ${errSnap.message}`);

const registros = normalizados.map((p) => ({
  snapshot_id: snap.id,
  source_id: fuente.id,
  entity_type: "product",
  external_id: p.externalId,
  title: p.nombre || p.codigoObservado || p.externalId,
  source_url: p.url,
  captured_at: capturadoEn,
  payload: {
    brand: "REVEL",
    source_type: "sumer_ssr",
    confidence: "OBSERVADO_CANAL_PRIMERA_PARTE",
    external_product_id: p.externalId,
    handle: p.friendlyUrl,
    source_product_url: p.url,
    source_root_url: BASE,
    // El texto entero, sin recortar. Lo derivado va aparte y puede recalcularse.
    description: p.descripcionRaw,
    product_type: p.categoriaFuente,
    source_category: p.categoriaFuente,
    codigo_observado: p.codigoObservado,
    unidades_por_box: p.unidadesPorBox,
    unidades_por_cajon: p.unidadesPorCajon,
    contenido: p.contenido,
    unidad_contenido: p.unidadContenido,
    price: p.precio,
    currency: p.moneda,
    available: p.disponible,
    primary_image_url: p.imagenes[0] ?? null,
    image_count: String(p.imagenes.length),
    captured_at: capturadoEn
  }
}));

let escritos = 0;
for (let i = 0; i < registros.length; i += 300) {
  const { error } = await db.from("catalog_source_records").insert(registros.slice(i, i + 300));
  if (error) throw new Error(`catalog_source_records: ${error.message}`);
  escritos += Math.min(300, registros.length - i);
  console.log(`   registros: ${escritos}/${registros.length}`);
}

console.log(`\nFuente registrada: revel-pe-sumerlabs`);
console.log(`Snapshot ${snap.id} · ${escritos} source_records`);
console.log(`Siguiente: promover-universo-referencia.mjs --aplicar`);
