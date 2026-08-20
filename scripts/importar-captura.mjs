/**
 * Lee de vuelta la hoja de captura física y guarda los códigos de barras.
 *
 * Esta es la pieza que faltaba. El checklist anterior pedía «Código de barras»
 * en sus 423 fichas y volvieron cero de 1.570 variantes: se pedía el dato y no
 * había nadie esperándolo del otro lado.
 *
 * Valida antes de escribir, porque un código mal tecleado es peor que ninguno:
 * el que no está se ve, el que está mal contesta con seguridad por otro
 * producto.
 *
 *   · dígito de control EAN-13 / EAN-8 / UPC-A
 *   · prefijo GS1 → país de la empresa que lo registró
 *   · duplicados: dos variantes con el mismo código son el mismo producto
 *     cargado dos veces, y eso se denuncia en vez de escribirse
 *
 * Uso:
 *   node scripts/importar-captura.mjs outputs/hoja-captura-fisica.csv
 *   node scripts/importar-captura.mjs outputs/hoja-captura-fisica.csv --aplicar
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const RUTA = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!RUTA) {
  console.error("Uso: node scripts/importar-captura.mjs <hoja.csv> [--aplicar]");
  process.exit(1);
}

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
  const H = cab.map((x) => x.replace(/^﻿/, "").trim());
  return resto.filter((f) => f.length === H.length).map((f) => Object.fromEntries(H.map((k, i) => [k, f[i]])));
}

// ── Dígito de control ───────────────────────────────────────────────────────
// EAN-13, EAN-8 y UPC-A llevan el mismo esquema: suma ponderada 3/1 desde la
// derecha, y el último dígito cierra a múltiplo de diez. Un código que no cierra
// está mal copiado, y escribirlo sería peor que dejar el hueco.
function digitoDeControlValido(codigo) {
  if (!/^\d+$/.test(codigo)) return false;
  if (![8, 12, 13, 14].includes(codigo.length)) return false;
  const digitos = codigo.split("").map(Number);
  const control = digitos.pop();
  let suma = 0;
  for (let i = digitos.length - 1, peso = 3; i >= 0; i -= 1, peso = peso === 3 ? 1 : 3) {
    suma += digitos[i] * peso;
  }
  return (10 - (suma % 10)) % 10 === control;
}

// Prefijo GS1: los tres primeros dígitos dicen dónde se registró la empresa.
// No es el país de fabricación —eso es un mito común— pero sí acota quién puso
// el código, que es información que hoy no tenemos de ninguna otra forma.
const PREFIJOS_GS1 = [
  [0, 19, "Estados Unidos y Canadá"], [30, 39, "Estados Unidos"],
  [300, 379, "Francia y Mónaco"], [380, 380, "Bulgaria"], [400, 440, "Alemania"],
  [450, 459, "Japón"], [460, 469, "Rusia"], [471, 471, "Taiwán"],
  [480, 480, "Filipinas"], [489, 489, "Hong Kong"], [490, 499, "Japón"],
  [500, 509, "Reino Unido"], [520, 521, "Grecia"], [540, 549, "Bélgica y Luxemburgo"],
  [560, 560, "Portugal"], [569, 569, "Islandia"], [570, 579, "Dinamarca"],
  [590, 590, "Polonia"], [600, 601, "Sudáfrica"], [608, 608, "Baréin"],
  [611, 611, "Marruecos"], [613, 613, "Argelia"], [619, 619, "Túnez"],
  [621, 621, "Siria"], [622, 622, "Egipto"], [625, 625, "Jordania"],
  [626, 626, "Irán"], [628, 628, "Arabia Saudí"], [629, 629, "Emiratos Árabes"],
  [640, 649, "Finlandia"], [690, 699, "China"], [700, 709, "Noruega"],
  [729, 729, "Israel"], [730, 739, "Suecia"], [740, 745, "Centroamérica"],
  [746, 746, "República Dominicana"], [750, 750, "México"], [754, 755, "Canadá"],
  [759, 759, "Venezuela"], [760, 769, "Suiza"], [770, 771, "Colombia"],
  [773, 773, "Uruguay"], [775, 775, "Perú"], [777, 777, "Bolivia"],
  [778, 779, "Argentina"], [780, 780, "Chile"], [784, 784, "Paraguay"],
  [786, 786, "Ecuador"], [789, 790, "Brasil"], [800, 839, "Italia"],
  [840, 849, "España"], [850, 850, "Cuba"], [858, 858, "Eslovaquia"],
  [859, 859, "Chequia"], [860, 860, "Serbia"], [865, 865, "Mongolia"],
  [867, 867, "Corea del Norte"], [868, 869, "Turquía"], [870, 879, "Países Bajos"],
  [880, 880, "Corea del Sur"], [884, 884, "Camboya"], [885, 885, "Tailandia"],
  [888, 888, "Singapur"], [890, 890, "India"], [893, 893, "Vietnam"],
  [896, 896, "Pakistán"], [899, 899, "Indonesia"], [900, 919, "Austria"],
  [930, 939, "Australia"], [940, 949, "Nueva Zelanda"], [955, 955, "Malasia"],
  [958, 958, "Macao"], [977, 977, "Publicación periódica"],
  [978, 979, "Libro (ISBN)"], [980, 980, "Recibo de devolución"],
  [200, 299, "Uso interno del comercio — NO identifica al fabricante"],
  [20, 29, "Uso interno del comercio — NO identifica al fabricante"]
];

function paisGs1(codigo) {
  const n = codigo.length === 13 ? Number(codigo.slice(0, 3)) : Number(codigo.slice(0, 2));
  for (const [desde, hasta, pais] of PREFIJOS_GS1) if (n >= desde && n <= hasta) return pais;
  return "prefijo no asignado";
}

// Se aceptan las dos hojas: la técnica y la de tienda. La de tienda no lleva
// variant_id —a propósito, quien recorre la estantería no debe ver un uuid— así
// que se localiza por el código del sistema, que es el que ya aparece en las
// hojas y albaranes y sobrevive a que se reordenen las filas.
const CABECERAS = {
  codigo_barras: ["codigo_barras", "CÓDIGO DE BARRAS", "CODIGO DE BARRAS"],
  codigo_interno: ["codigo_interno", "Código del sistema", "Codigo del sistema"],
  producto: ["producto", "Producto"],
  variante: ["variante", "Variante"],
  // «Referencia» es como se llama variant_id en las hojas que ve la tienda: un
  // uuid con ese nombre no invita a teclearlo, y es lo único que localiza el 58%
  // de las variantes cuyo código del sistema es uno de los largos generados.
  variant_id: ["variant_id", "Referencia", "referencia"]
};

function campo(fila, cual) {
  for (const nombre of CABECERAS[cual]) {
    if (fila[nombre] !== undefined && String(fila[nombre]).trim() !== "") return String(fila[nombre]).trim();
  }
  return "";
}

const crudas = parseCsv(readFileSync(path.resolve(RUTA), "utf8"));
const filas = crudas.map((f) => ({
  codigo_barras: campo(f, "codigo_barras"),
  codigo_interno: campo(f, "codigo_interno"),
  producto: campo(f, "producto"),
  variante: campo(f, "variante"),
  variant_id: campo(f, "variant_id")
}));
const conCodigo = filas.filter((f) => f.codigo_barras);

console.log(`Filas en la hoja: ${filas.length}`);
console.log(`Con código de barras rellenado: ${conCodigo.length}`);

if (!conCodigo.length) {
  console.log(`\nLa hoja está vacía todavía. Es lo esperado antes de la sesión de captura.`);
  console.log(`Cuando vuelva rellenada, este script valida y guarda.`);
  process.exit(0);
}

const validas = [];
const invalidas = [];
const sinCodigo = [];

for (const f of conCodigo) {
  const bruto = f.codigo_barras.trim();

  // «SIN CODIGO» no es un error de tecleo: es la respuesta de quien tuvo el
  // envase en la mano y comprobó que no lo trae. Descartarla como inválida
  // devolvería el producto a la lista de pendientes y obligaría a mirarlo otra
  // vez — perdiendo justo el trabajo que sí se hizo.
  //
  // Se guarda como «se miró y no hay»: barcode en null, pero con fecha de
  // captura. Esa pareja de valores no la produce ningún otro camino.
  if (/^sin\s*codigo$/i.test(bruto.normalize("NFD").replace(/[̀-ͯ]/g, ""))) {
    sinCodigo.push(f);
    continue;
  }

  const codigo = bruto.replace(/[\s-]/g, "");
  if (!digitoDeControlValido(codigo)) {
    invalidas.push({ ...f, codigo, motivo: "el dígito de control no cierra: mal copiado o incompleto" });
    continue;
  }
  validas.push({ ...f, codigo, pais: paisGs1(codigo) });
}

// Dos variantes con el mismo código son el mismo producto cargado dos veces.
// Eso no se escribe: se denuncia, porque fusionar productos es una decisión de
// la dueña y no de un script de importación.
const porCodigo = new Map();
for (const v of validas) {
  if (!porCodigo.has(v.codigo)) porCodigo.set(v.codigo, []);
  porCodigo.get(v.codigo).push(v);
}
const duplicados = [...porCodigo].filter(([, v]) => v.length > 1);
const unicas = validas.filter((v) => porCodigo.get(v.codigo).length === 1);

console.log(`  con código:                                ${validas.length}`);
console.log(`  sin código de barras (comprobado en mano):  ${sinCodigo.length}`);
console.log(`  inválidas:                                 ${invalidas.length}`);
console.log(`  duplicadas: ${validas.length - unicas.length} (en ${duplicados.length} códigos)`);

if (invalidas.length) {
  console.log(`\nCódigos que no pasan el dígito de control:`);
  for (const i of invalidas.slice(0, 12)) console.log(`   ${i.codigo.padEnd(16)} ${i.producto} · ${i.variante}`);
}
if (duplicados.length) {
  console.log(`\nMismo código en más de una variante — probablemente el mismo producto duplicado:`);
  for (const [c, v] of duplicados.slice(0, 10)) {
    console.log(`   ${c}`);
    for (const x of v) console.log(`      ${x.codigo_interno.padEnd(24)} ${x.producto} · ${x.variante}`);
  }
}

const porPais = new Map();
for (const v of unicas) porPais.set(v.pais, (porPais.get(v.pais) ?? 0) + 1);
console.log(`\nDe dónde vienen (prefijo GS1):`);
for (const [p, n] of [...porPais].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${p}`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar para guardar ${unicas.length} con código y ${sinCodigo.length} sin él.`);
  process.exit(0);
}

let hechas = 0, fallos = 0, sinLocalizar = 0, marcadas = 0;

// Sin uuid —la hoja lo lleva como «Referencia», y quien la imprime en papel
// puede quedarse sin él— se busca por el código del sistema, mirando también
// sku_interno: una variante que ya migró a SKU de fabricante conserva ahí el
// correlativo que la hoja imprimió, y si no se mirase ahí, todo lo migrado
// volvería «no encontrado».
async function localizar(v) {
  if (v.variant_id) return v.variant_id;
  if (!v.codigo_interno) return null;
  const { data } = await db
    .from("product_variants")
    .select("id")
    .or(`sku.eq.${v.codigo_interno},sku_interno.eq.${v.codigo_interno}`)
    .limit(2);
  if (!data || data.length !== 1) {
    console.error(`   ? ${v.codigo_interno.padEnd(24)} ${v.producto} · ${v.variante} — ${!data || !data.length ? "no encontrado" : "ambiguo"}`);
    return null;
  }
  return data[0].id;
}

for (const v of unicas) {
  const id = await localizar(v);
  if (!id) { sinLocalizar += 1; continue; }
  const { error } = await db.from("product_variants").update({
    barcode: v.codigo,
    barcode_origen: "CAPTURA_FISICA",
    barcode_capturado_en: new Date().toISOString()
  }).eq("id", id);
  if (error) { fallos += 1; console.error(`   ✗ ${v.codigo}: ${error.message}`); continue; }
  hechas += 1;
}

// «Se miró y no hay»: sin código pero con fecha de captura. Esa pareja de
// valores no la produce ningún otro camino, y es lo que saca al producto de la
// lista de pendientes para que nadie lo vuelva a buscar.
for (const v of sinCodigo) {
  const id = await localizar(v);
  if (!id) { sinLocalizar += 1; continue; }
  const { error } = await db.from("product_variants").update({
    barcode: null,
    barcode_origen: "CAPTURA_FISICA",
    barcode_capturado_en: new Date().toISOString()
  }).eq("id", id);
  if (error) { fallos += 1; console.error(`   ✗ sin código: ${error.message}`); continue; }
  marcadas += 1;
}

console.log(`\nGuardados con código: ${hechas}`);
console.log(`Marcados «no tiene código»: ${marcadas}`);
console.log(`Sin localizar en el catálogo: ${sinLocalizar}`);
console.log(`Fallos: ${fallos}`);
console.log(`\nSiguiente: npm run graph:sync  — para que el grafo cuente la identidad nueva.`);
