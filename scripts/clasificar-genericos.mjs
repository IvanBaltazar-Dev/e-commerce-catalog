/**
 * «Genérica / sin marca» no significa «sin identidad recuperable».
 *
 * Dije que los 399 genéricos son captura física y era una conclusión demasiado
 * fuerte. Que hoy no tengamos una marca utilizable no demuestra que el artículo
 * no tenga identidad: puede tener código de proveedor, un modelo dentro del
 * nombre, una referencia en la descripción original, o compartir proveedor con
 * otros que sí están identificados.
 *
 * Mandar los 399 a la estantería sin mirar eso sería convertir ausencia de
 * evidencia en trabajo humano, que es justo lo que este sistema existe para
 * evitar. La captura física es una clase propia y va AL FINAL, no por defecto.
 *
 * Clases, de más barata a más cara:
 *
 *   IDENTIFICABLE_POR_CODIGO     tiene código de proveedor: se resuelve
 *                                preguntando al proveedor, no fotografiando
 *   IDENTIFICABLE_POR_MODELO     el nombre o la descripción llevan un modelo
 *                                o referencia con forma de código
 *   AGRUPABLE_POR_PROVEEDOR      sin código propio, pero su proveedor tiene
 *                                otros productos ya identificados
 *   BUSQUEDA_WEB_ACOTADA         hay suficiente texto distintivo para buscar
 *   REQUIERE_CAPTURA_FISICA      no queda nada más que mirar el envase
 *
 * Uso: node scripts/clasificar-genericos.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
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

const productos = await todas("products",
  "id, code, name, presentation, description, is_active, brand_id, categories(name), brands(name, is_generic)");
const variantes = await todas("product_variants", "id, product_id, name, sku, is_active");
const enlaces = await todas("product_suppliers", "product_id, variant_id, supplier_id, supplier_sku");
const proveedores = await todas("suppliers", "id, trade_name");

const provPorId = new Map(proveedores.map((s) => [s.id, s.trade_name]));
const productoDeVariante = new Map(variantes.map((v) => [v.id, v.product_id]));

const codigoDe = new Map();
const proveedorDe = new Map();
for (const e of enlaces) {
  const pid = e.product_id ?? productoDeVariante.get(e.variant_id);
  if (!pid) continue;
  if (e.supplier_sku && String(e.supplier_sku).trim() && String(e.supplier_sku).trim().toUpperCase() !== "S/C") {
    if (!codigoDe.has(pid)) codigoDe.set(pid, new Set());
    codigoDe.get(pid).add(e.supplier_sku.trim());
  }
  if (!proveedorDe.has(pid)) proveedorDe.set(pid, new Set());
  proveedorDe.get(pid).add(e.supplier_id);
}

// Un proveedor «rinde» si alguno de sus productos ya tiene código: significa
// que ese proveedor SÍ documenta, y que el hueco es nuestro, no suyo.
const proveedorConCodigos = new Set();
for (const [pid, provs] of proveedorDe) {
  if (!codigoDe.has(pid)) continue;
  for (const s of provs) proveedorConCodigos.add(s);
}

// Un modelo tiene que identificar, no describir. «100/180» en una lima es un
// grano y sirve para reconocerla; «X12» es la cantidad de la caja y lo lleva
// media tienda.
//
// La primera versión de esto contaba «X12» y «X500» como modelo y daba 50
// identificables donde no los había — el mismo tipo de cifra inflada que ya
// tuve que corregir con los «88 SKU».
const PATRON_EMPAQUE = /^x\s?\d{1,4}$/i;
const PATRON_MODELO = /\b([A-Z]{2,5}[-]?\d{2,6}|\d{2,4}\/\d{2,4}|\d{2,4}\s?(?:w|watts|wts)\b)/i;

function modeloDe(texto) {
  const encontrado = (texto.match(PATRON_MODELO) ?? [])[0];
  if (!encontrado) return null;
  if (PATRON_EMPAQUE.test(encontrado.trim())) return null;
  return encontrado;
}

const genericos = productos.filter((p) => p.is_active && p.brands?.is_generic);
const clasificados = [];
const conteo = new Map();
const anota = (k) => conteo.set(k, (conteo.get(k) ?? 0) + 1);

for (const p of genericos) {
  const vs = variantes.filter((v) => v.product_id === p.id && v.is_active);
  const textoCompleto = [p.name, p.presentation, p.description, ...vs.map((v) => v.name)].filter(Boolean).join(" ");
  const codigos = codigoDe.get(p.id);
  const provs = [...(proveedorDe.get(p.id) ?? [])];

  let clase, pista;
  if (codigos?.size) {
    clase = "IDENTIFICABLE_POR_CODIGO";
    pista = [...codigos].join(", ");
  } else if (modeloDe(textoCompleto)) {
    clase = "IDENTIFICABLE_POR_MODELO";
    pista = modeloDe(textoCompleto);
  } else if (provs.some((s) => proveedorConCodigos.has(s))) {
    clase = "AGRUPABLE_POR_PROVEEDOR";
    pista = provs.map((s) => provPorId.get(s)).filter(Boolean).join(", ");
  } else if (textoCompleto.split(/\s+/).filter((w) => w.length > 3).length >= 3) {
    clase = "BUSQUEDA_WEB_ACOTADA";
    pista = p.name;
  } else {
    clase = "REQUIERE_CAPTURA_FISICA";
    pista = "nombre corto y sin código ni proveedor documentado";
  }

  anota(clase);
  clasificados.push({
    code: p.code, nombre: p.name, presentacion: p.presentation ?? "",
    categoria: p.categories?.name ?? "—",
    proveedores: provs.map((s) => provPorId.get(s)).filter(Boolean),
    clase, pista
  });
}

console.log(`Productos con marca genérica: ${genericos.length}\n`);
const orden = ["IDENTIFICABLE_POR_CODIGO", "IDENTIFICABLE_POR_MODELO", "AGRUPABLE_POR_PROVEEDOR", "BUSQUEDA_WEB_ACOTADA", "REQUIERE_CAPTURA_FISICA"];
let acumulado = 0;
for (const c of orden) {
  const n = conteo.get(c) ?? 0;
  acumulado += n;
  console.log(`   ${String(n).padStart(4)}  ${String(Math.round(n / genericos.length * 100)).padStart(3)}%   ${c}`);
}
console.log(`\n   ${genericos.length - (conteo.get("REQUIERE_CAPTURA_FISICA") ?? 0)} de ${genericos.length} tienen algo por donde empezar SIN tocar el envase.`);

for (const c of orden) {
  const lista = clasificados.filter((x) => x.clase === c);
  if (!lista.length) continue;
  console.log(`\n▸ ${c} · ${lista.length}`);
  for (const x of lista.slice(0, 5)) {
    console.log(`     ${x.nombre.slice(0, 36).padEnd(38)} ${String(x.pista).slice(0, 30).padEnd(32)} ${x.proveedores[0] ?? ""}`);
  }
  if (lista.length > 5) console.log(`     … y ${lista.length - 5} más`);
}

// Los que se agrupan por proveedor: cuántos proveedores hay que preguntar.
const porProveedor = new Map();
for (const x of clasificados) {
  if (!["IDENTIFICABLE_POR_CODIGO", "AGRUPABLE_POR_PROVEEDOR"].includes(x.clase)) continue;
  const p = x.proveedores[0] ?? "(sin proveedor)";
  porProveedor.set(p, (porProveedor.get(p) ?? 0) + 1);
}
console.log(`\n▸ Si se pregunta por proveedor, ${porProveedor.size} conversaciones cubren ${[...porProveedor.values()].reduce((a, b) => a + b, 0)} productos:`);
for (const [p, n] of [...porProveedor].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(n).padStart(4)}  ${p}`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "clasificacion-genericos.json"), JSON.stringify({ conteo: Object.fromEntries(conteo), clasificados }, null, 2), "utf8");
console.log(`\n→ outputs/clasificacion-genericos.json`);
