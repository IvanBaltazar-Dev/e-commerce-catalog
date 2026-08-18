/**
 * Qué dice la fuente oficial sobre las líneas de Masglo y las bases de Admiss.
 *
 * No inventa clasificación: lee lo que el rastreo de masglo.com.es y
 * admiss.com.co dejó en research/catalog-master/data y lo pone en una tabla
 * que se pueda contrastar con lo que hay en la base.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "research", "catalog-master", "data");

// CSV con comillas: los campos traen comas dentro (descripciones, títulos con
// «13,5 ML»). Partir por comas a secas desplaza todas las columnas.
function parseCsv(texto) {
  const filas = [];
  let campo = "";
  let fila = [];
  let entreComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i += 1; }
        else entreComillas = false;
      } else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }

  const [cabecera, ...resto] = filas;
  return resto
    .filter((f) => f.length === cabecera.length)
    .map((f) => Object.fromEntries(cabecera.map((k, i) => [k, f[i]])));
}

const leer = (n) => parseCsv(readFileSync(path.join(DATA, n), "utf8"));

const productos = leer("external_official_products.csv");
const variantes = leer("external_official_variants.csv");
const imagenes = leer("external_official_images.csv");

const precioPorProducto = new Map();
for (const v of variantes) {
  if (!precioPorProducto.has(v.external_product_id)) {
    precioPorProducto.set(v.external_product_id, { precio: v.price, sku: v.sku });
  }
}
const imagenesPorProducto = new Map();
for (const im of imagenes) {
  imagenesPorProducto.set(im.external_product_id, (imagenesPorProducto.get(im.external_product_id) ?? 0) + 1);
}

// La línea vive en las etiquetas de Shopify. Se lee tal cual la publica la
// marca; no se deduce del nombre.
function lineaDe(p) {
  const tags = (p.tags ?? "").split("|").map((t) => t.trim().toUpperCase());
  if (p.brand === "Masglo") {
    if (tags.includes("GEL POLISH") || tags.includes("MASGLO PROFESSIONAL")) return "Gel Polish";
    if (tags.includes("GEL EVOLUTION") || tags.includes("EVOLUTION")) return "Gel Evolution";
    if (tags.includes("MASGLO ADVANCED") || tags.includes("ADVANCED")) return "Advanced";
    if (tags.includes("TRADICIONAL") || tags.includes("ESMALTE TRADICIONAL")) return "Tradicional";
  }
  if (p.brand === "Admiss") {
    if (tags.includes("BASES") || tags.includes("BASE")) return "Bases";
    if (tags.includes("BRILLOS") || tags.includes("BRILLO")) return "Brillos";
    if (tags.includes("ESMALTE TRADICIONAL") || tags.includes("TRADICIONAL")) return "Esmalte tradicional";
  }
  return p.product_type || "(sin línea)";
}

for (const marca of ["Masglo", "Admiss"]) {
  const suyos = productos.filter((p) => p.brand === marca);
  console.log(`\n${"═".repeat(78)}\n${marca} · ${suyos.length} productos oficiales\n${"═".repeat(78)}`);

  const porLinea = new Map();
  for (const p of suyos) {
    const l = lineaDe(p);
    if (!porLinea.has(l)) porLinea.set(l, []);
    porLinea.get(l).push(p);
  }

  for (const [linea, lista] of [...porLinea].sort((a, b) => b[1].length - a[1].length)) {
    const precios = lista
      .map((p) => Number(precioPorProducto.get(p.external_product_id)?.precio))
      .filter((n) => Number.isFinite(n) && n > 0);
    const imgs = lista.reduce((a, p) => a + (imagenesPorProducto.get(p.external_product_id) ?? 0), 0);
    const rango = precios.length
      ? `${Math.min(...precios).toFixed(2)}–${Math.max(...precios).toFixed(2)}`
      : "—";
    console.log(`\n  ${linea}  ·  ${lista.length} productos  ·  ${imgs} imágenes  ·  precio ${rango}`);
    if (linea === "Bases" || lista.length <= 12) {
      for (const p of lista.slice(0, 12)) {
        console.log(`      · ${p.title}`);
      }
    }
  }
}

// La pregunta concreta: ¿qué dice la marca de «Ajo y Limón»?
console.log(`\n${"═".repeat(78)}\nAjo y Limón, según la fuente oficial\n${"═".repeat(78)}`);
for (const p of productos.filter((p) => /ajo/i.test(p.title))) {
  console.log(`\n  ${p.brand} · ${p.title}`);
  console.log(`    línea deducida de etiquetas: ${lineaDe(p)}`);
  console.log(`    product_type oficial:        ${p.product_type}`);
  console.log(`    etiquetas:                   ${p.tags}`);
  console.log(`    url:                         ${p.source_product_url}`);
  console.log(`    imágenes:                    ${imagenesPorProducto.get(p.external_product_id) ?? 0}`);
}
