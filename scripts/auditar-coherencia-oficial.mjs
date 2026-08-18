/**
 * Detector general de incoherencias contra la fuente oficial.
 *
 * El caso «Ajo y Limón es una base y estaba como tono de esmalte» no era único.
 * Arreglarlos de uno en uno es un bucle: cada arreglo destapa el siguiente y
 * nunca se sabe cuántos quedan. Esto los busca todos a la vez y los agrupa por
 * CLASE de error, para poder cerrar familias enteras en vez de instancias.
 *
 * Identificador: el SKU. Ya está demostrado que el nombre no sirve — Masglo
 * vende «Campeona» en tres líneas, con tres precios y tres envases.
 *
 * Fuente: research/catalog-master/data (rastreo oficial, CONFIRMADO_OFICIAL).
 *
 * No cambia nada. Solo dice qué está mal y con qué evidencia.
 *
 * Uso:  node scripts/auditar-coherencia-oficial.mjs
 * Sale: outputs/coherencia-oficial.json  +  resumen por consola
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "research", "catalog-master", "data");

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function parseCsv(texto) {
  const filas = [];
  let campo = "", fila = [], comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i += 1; } else comillas = false; }
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas;
  return resto.filter((f) => f.length === cab.length).map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i]])));
}
const leer = (n) => parseCsv(readFileSync(path.join(DATA, n), "utf8"));

const oficialesProd = leer("external_official_products.csv");
const oficialesVar = leer("external_official_variants.csv");
const oficialesImg = leer("external_official_images.csv");

const prodPorId = new Map(oficialesProd.map((p) => [p.external_product_id, p]));
const imgsPorProd = new Map();
for (const im of oficialesImg) {
  if (!imgsPorProd.has(im.external_product_id)) imgsPorProd.set(im.external_product_id, []);
  imgsPorProd.get(im.external_product_id).push({ url: im.image_url, pos: Number(im.image_position) || 99, rol: im.role });
}

// Índice por SKU. Un SKU puede repetirse entre marcas distintas, así que la
// clave lleva marca: si no, un «1001» de Cherimoya contestaría por un «1001»
// de Masglo y el detector inventaría incoherencias que no existen.
const oficialPorSku = new Map();
for (const v of oficialesVar) {
  const p = prodPorId.get(v.external_product_id);
  if (!p) continue;
  const sku = (v.sku ?? "").trim();
  if (!sku) continue;
  const clave = `${p.brand.toLowerCase()}::${sku}`;
  if (!oficialPorSku.has(clave)) {
    oficialPorSku.set(clave, {
      marca: p.brand,
      titulo: p.title,
      tipo: p.product_type ?? "",
      etiquetas: p.tags ?? "",
      descripcion: p.description ?? "",
      precio: v.price,
      url: p.source_product_url,
      productoExternoId: p.external_product_id,
      imagenes: (imgsPorProd.get(p.external_product_id) ?? []).sort((a, b) => a.pos - b.pos)
    });
  }
}

// ── Qué clase de cosa es, según la marca ────────────────────────────────────
// Se lee del product_type y del título oficiales. Es la pregunta que decide si
// algo pertenece a «Esmaltes» o a otra categoría.
function claseOficial(of) {
  const t = (of.tipo || "").toUpperCase();
  const titulo = (of.titulo || "").toUpperCase();
  const etq = (of.etiquetas || "").toUpperCase();
  const dice = (...ps) => ps.some((p) => t.startsWith(p) || titulo.startsWith(p + " ") || titulo.includes(" " + p + " "));

  if (dice("BASE") || /\bBASES\b/.test(etq)) return "BASE";
  if (dice("BRILLO", "TOP COAT") || /\bBRILLOS\b/.test(etq)) return "BRILLO";
  if (titulo.includes("DECORACIÓN") || titulo.includes("DECORACION")) return "DECORACION";
  if (dice("LIMA")) return "LIMA";
  if (dice("REMOVEDOR", "LIQUIDO", "LÍQUIDO", "DILUSOR", "LIMPIADOR", "BALANCEADOR")) return "LIQUIDO";
  if (dice("ACEITE", "CREMA", "SERUM", "SÉRUM")) return "CUIDADO";
  if (dice("TIPS", "TIP")) return "TIP";
  if (dice("PINCEL", "BROCHA")) return "PINCEL";
  if (dice("POLVO", "ACRILICO", "ACRÍLICO", "MONOMERO", "MONÓMERO")) return "ACRILICO";
  if (dice("KIT")) return "KIT";
  if (t.includes("ESMALTE") || titulo.includes("ESMALTE")) return "ESMALTE";
  if (dice("GEL")) return "GEL";
  return t || "(otro)";
}

// A qué categoría nuestra debería ir cada clase. Es la traducción entre el
// vocabulario de la marca y el nuestro, escrita una vez.
const CATEGORIA_ESPERADA = {
  BASE: "Bases, tops y finalizadores",
  BRILLO: "Bases, tops y finalizadores",
  DECORACION: "Decoración y nail art",
  LIMA: "Limas, pulidores y buffers",
  LIQUIDO: "Removedores y líquidos",
  CUIDADO: "Cuidado de cutícula, manos y pies",
  ACRILICO: "Sistema acrílico",
  ESMALTE: "Esmaltes"
};

function lineaOficial(of) {
  const t = (of.etiquetas || "").split("|").map((x) => x.trim().toUpperCase());
  if (of.marca === "Masglo") {
    if (t.includes("GEL POLISH") || t.includes("MASGLO PROFESSIONAL")) return "Gel Polish";
    if (t.includes("GEL EVOLUTION") || t.includes("BASE GEL EVOLUTION")) return "Gel Evolution";
    if (t.includes("MASGLO ADVANCED")) return "Advanced";
    if (t.includes("TRADICIONAL") || t.includes("ESMALTE TRADICIONAL") || t.includes("BASE TRADICIONAL")) return "Tradicional";
  }
  if (of.marca === "Admiss") {
    if (t.includes("BASES")) return "Bases";
    if (t.includes("BRILLOS")) return "Brillos";
    if (t.includes("ESMALTE TRADICIONAL") || t.includes("TRADICIONAL")) return "Esmalte tradicional";
  }
  return null;
}

// ── Nuestro catálogo ────────────────────────────────────────────────────────
// PostgREST corta en 1.000 filas por respuesta y no avisa: la primera versión
// de esto auditó 1.000 de 1.570 y habría dado por limpio lo que ni miró.
const variantes = [];
for (let desde = 0; ; desde += 1000) {
  const { data, error } = await db
    .from("product_variants")
    .select("id, sku, name, is_active, product_id, products(id, code, name, product_type, is_active, editorial_status, categories(name), brands(name), product_lines(name))")
    .not("sku", "is", null)
    .order("id")
    .range(desde, desde + 999);
  if (error) throw error;
  variantes.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

// ── Un SKU igual no siempre es el mismo producto ────────────────────────────
//
// Nuestro catálogo mezcla dos clases de código en la misma columna:
//
//   310028, 311428   SKU real del fabricante
//   CHE017, MAS014   correlativo NUESTRO (prefijo de marca + 3 dígitos)
//
// Y los correlativos chocan. «CHE017» es «Base Coat 15ML» para nosotros y
// «Polvo Compacto Facial» en el catálogo de Cherimoya: dos numeraciones
// distintas que coinciden por casualidad. La primera versión de esta auditoría
// dio seis incoherencias por ese choque, todas falsas — y proponía mover
// productos por ellas.
//
// Así que un SKU igual no basta. Se exige que los nombres se toquen: alguna
// palabra con contenido en común entre lo nuestro y el título oficial. Un
// emparejamiento sin corroborar no se descarta en silencio, se cuenta aparte:
// que un detector calle lo que no entiende es cómo se llega a un bucle.
const palabrasVacias = new Set([
  "de", "del", "la", "el", "los", "las", "con", "sin", "para", "por", "en", "y",
  "ml", "gr", "oz", "unidad", "und", "pza", "x", "kit", "set"
]);

function tokens(s) {
  return new Set(
    (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").split(" ")
      .filter((w) => w.length > 2 && !palabrasVacias.has(w) && !/^\d+$/.test(w))
  );
}

function seCorroboran(nuestroProducto, nuestraVariante, tituloOficial) {
  const of = tokens(tituloOficial);
  const nuestro = new Set([...tokens(nuestroProducto), ...tokens(nuestraVariante)]);
  for (const t of nuestro) if (of.has(t)) return true;
  return false;
}

const hallazgos = [];
const colisiones = [];
let contrastables = 0;

for (const v of variantes ?? []) {
  const p = v.products;
  if (!p) continue;
  const marca = p.brands?.name ?? "";
  const clave = `${marca.toLowerCase()}::${(v.sku ?? "").trim()}`;
  const of = oficialPorSku.get(clave);
  if (!of) continue;

  if (!seCorroboran(p.name, v.name, of.titulo)) {
    colisiones.push({
      sku: v.sku, marca, nuestro: `${p.name} · ${v.name}`, oficial: of.titulo, url: of.url
    });
    continue;
  }
  contrastables += 1;

  const clase = claseOficial(of);
  const categoriaNuestra = p.categories?.name ?? "(sin categoría)";
  const categoriaEsperada = CATEGORIA_ESPERADA[clase];
  const lineaOf = lineaOficial(of);
  const lineaNuestra = p.product_lines?.name ?? null;

  const problemas = [];

  if (categoriaEsperada && categoriaNuestra !== categoriaEsperada) {
    problemas.push({
      tipo: "CATEGORIA_EQUIVOCADA",
      detalle: `está en «${categoriaNuestra}» y la marca lo clasifica como ${clase} → «${categoriaEsperada}»`
    });
  }
  if (lineaOf && lineaNuestra && lineaOf !== lineaNuestra) {
    problemas.push({ tipo: "LINEA_EQUIVOCADA", detalle: `nuestra línea «${lineaNuestra}», oficial «${lineaOf}»` });
  }
  if (lineaOf && !lineaNuestra) {
    problemas.push({ tipo: "LINEA_AUSENTE", detalle: `la marca lo pone en «${lineaOf}» y nosotros no le damos línea` });
  }

  if (problemas.length) {
    hallazgos.push({
      sku: v.sku,
      variante: v.name,
      variante_activa: v.is_active,
      producto: p.code,
      producto_nombre: p.name,
      marca,
      categoria_nuestra: categoriaNuestra,
      linea_nuestra: lineaNuestra,
      clase_oficial: clase,
      categoria_esperada: categoriaEsperada ?? null,
      linea_oficial: lineaOf,
      titulo_oficial: of.titulo,
      precio_oficial: of.precio,
      url: of.url,
      imagenes_oficiales: of.imagenes.length,
      problemas
    });
  }
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "coherencia-oficial.json"), JSON.stringify(hallazgos, null, 2), "utf8");

writeFileSync(path.join(ROOT, "outputs", "coherencia-colisiones-sku.json"), JSON.stringify(colisiones, null, 2), "utf8");

console.log(`Variantes nuestras con SKU: ${(variantes ?? []).length}`);
console.log(`SKU coincide y los nombres se corroboran: ${contrastables}`);
console.log(`SKU coincide pero los nombres NO se tocan (choque de numeraciones): ${colisiones.length}`);
console.log(`De los contrastables, con incoherencia: ${hallazgos.length}\n`);

if (colisiones.length) {
  console.log(`${"═".repeat(76)}\nCHOQUES DE NUMERACIÓN · ${colisiones.length} · descartados como evidencia\n${"═".repeat(76)}`);
  for (const c of colisiones.slice(0, 10)) {
    console.log(`  ${c.sku.padEnd(10)} nuestro: ${c.nuestro.slice(0, 42).padEnd(44)} oficial: ${c.oficial.slice(0, 40)}`);
  }
  if (colisiones.length > 10) console.log(`  … y ${colisiones.length - 10} más en outputs/coherencia-colisiones-sku.json`);
  console.log();
}

const porTipo = new Map();
for (const h of hallazgos) for (const pr of h.problemas) {
  if (!porTipo.has(pr.tipo)) porTipo.set(pr.tipo, []);
  porTipo.get(pr.tipo).push(h);
}

for (const [tipo, lista] of [...porTipo].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${"═".repeat(76)}\n${tipo} · ${lista.length}\n${"═".repeat(76)}`);
  const agrupado = new Map();
  for (const h of lista) {
    const k = `${h.marca} · ${h.producto_nombre} → ${h.clase_oficial}`;
    if (!agrupado.has(k)) agrupado.set(k, []);
    agrupado.get(k).push(h);
  }
  for (const [k, hs] of [...agrupado].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${k}  (${hs.length})`);
    for (const h of hs.slice(0, 6)) {
      console.log(`     ${(h.sku ?? "—").padEnd(22)} ${h.variante.slice(0, 26).padEnd(28)} ${h.variante_activa ? "" : "[inactiva] "}${h.titulo_oficial.slice(0, 58)}`);
    }
    if (hs.length > 6) console.log(`     … y ${hs.length - 6} más`);
  }
}

console.log(`\n→ outputs/coherencia-oficial.json`);
