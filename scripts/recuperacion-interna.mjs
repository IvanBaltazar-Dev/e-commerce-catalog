/**
 * Fase 1 · Recuperar lo que ya sabemos antes de salir a internet.
 *
 * Antes de rastrear una sola web hay que agotar lo propio. El Excel de origen
 * —bellaroshe_source_catalog.csv, 1.500 filas— conserva columnas que la
 * importación no llevó del todo a la base:
 *
 *   Código proveedor    526 filas · en la base hay 428
 *   Proveedor          1.497 filas
 *   Código             731 filas
 *   Descripción original / normalizada
 *
 * «Genérica / sin marca» no significa «sin identidad»: un adorno sin marca pero
 * con código DY-050 del proveedor CHINO PUNO SÍ está identificado, solo que por
 * el eje equivocado. Investigar en Google lo que ya está en un CSV nuestro es
 * pagar dos veces por el mismo dato.
 *
 * Este script NO escribe: mide el hueco y dice exactamente qué se puede
 * recuperar, para poder decidir con números.
 *
 * Uso: node scripts/recuperacion-interna.mjs
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

const origen = parseCsv(
  readFileSync(path.join(ROOT, "research", "catalog-master", "data", "bellaroshe_source_catalog.csv"), "utf8")
);

async function todas(tabla, select, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db.from(tabla).select(select).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const productos = await todas("products", "id, code, name, presentation, description, is_active, brands(name)");
const variantes = await todas("product_variants", "id, product_id, name, sku, sku_interno, barcode, is_active");
const enlaces = await todas("product_suppliers", "id, product_id, variant_id, supplier_id, supplier_sku, supplier_item_name");
const proveedores = await todas("suppliers", "id, trade_name");

const provPorNombre = new Map(proveedores.map((s) => [s.trade_name.trim().toUpperCase(), s.id]));
const productoDeVariante = new Map(variantes.map((v) => [v.id, v.product_id]));

// Lo que la base ya sabe, por producto.
const skuPorProducto = new Map();
for (const e of enlaces) {
  const pid = e.product_id ?? productoDeVariante.get(e.variant_id);
  if (!pid) continue;
  if (!skuPorProducto.has(pid)) skuPorProducto.set(pid, new Set());
  if (e.supplier_sku) skuPorProducto.get(pid).add(e.supplier_sku.trim().toUpperCase());
}

// El puente entre Excel y base es la descripción original: la importación la
// guardó tal cual en products.description. Es más fiable que el nombre, que sí
// pasó por normalización.
const norm = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

const porDescripcion = new Map();
for (const p of productos) {
  for (const clave of [norm(p.description), norm(`${p.name} ${p.presentation ?? ""}`)]) {
    if (!clave) continue;
    if (!porDescripcion.has(clave)) porDescripcion.set(clave, []);
    porDescripcion.get(clave).push(p);
  }
}

const recuperables = [];
const yaEstaba = [];
const sinEnlazar = [];
const proveedorNuevo = new Map();

for (const fila of origen) {
  const codigo = (fila["Código proveedor"] ?? "").trim();
  const proveedor = (fila["Proveedor"] ?? "").trim();
  const descripcion = fila["Descripción original"] ?? "";
  if (!codigo) continue;

  const candidatos = porDescripcion.get(norm(descripcion)) ?? [];
  if (candidatos.length !== 1) {
    sinEnlazar.push({
      codigo, proveedor, descripcion,
      motivo: candidatos.length === 0 ? "no encuentro el producto en la base" : `${candidatos.length} productos comparten esa descripción`
    });
    continue;
  }

  const p = candidatos[0];
  const yaTiene = skuPorProducto.get(p.id);
  if (yaTiene && yaTiene.has(codigo.toUpperCase())) {
    yaEstaba.push({ codigo, proveedor, producto: p.code });
    continue;
  }

  const supplierId = provPorNombre.get(proveedor.toUpperCase()) ?? null;
  if (!supplierId) proveedorNuevo.set(proveedor, (proveedorNuevo.get(proveedor) ?? 0) + 1);

  recuperables.push({
    codigo,
    proveedor,
    supplierId,
    productId: p.id,
    productCode: p.code,
    producto: p.name,
    marca: p.brands?.name ?? "",
    descripcion,
    tieneOtroSku: yaTiene ? [...yaTiene].join(", ") : ""
  });
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(
  path.join(ROOT, "outputs", "recuperacion-interna.json"),
  JSON.stringify({ recuperables, sinEnlazar, yaEstaba: yaEstaba.length }, null, 2),
  "utf8"
);

const conCodigo = origen.filter((f) => (f["Código proveedor"] ?? "").trim()).length;

console.log(`Excel de origen: ${origen.length} filas · ${conCodigo} con código de proveedor\n`);
console.log(`  ya estaban en la base:        ${yaEstaba.length}`);
console.log(`  RECUPERABLES:                 ${recuperables.length}`);
console.log(`  no se pueden enlazar:         ${sinEnlazar.length}`);

const motivos = new Map();
for (const s of sinEnlazar) motivos.set(s.motivo, (motivos.get(s.motivo) ?? 0) + 1);
for (const [m, n] of [...motivos].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${m}`);

if (proveedorNuevo.size) {
  console.log(`\n  proveedores del Excel que no están en la base: ${proveedorNuevo.size}`);
  for (const [p, n] of [...proveedorNuevo].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`     ${String(n).padStart(4)}  ${p}`);
}

console.log(`\nMuestra de lo recuperable:`);
for (const r of recuperables.slice(0, 12)) {
  console.log(`  ${r.codigo.padEnd(12)} ${r.proveedor.padEnd(14)} ${r.productCode.padEnd(18)} ${r.descripcion.slice(0, 42)}`);
}

// Y lo que de verdad importa para el motor: cuántos productos SIN ninguna pista
// quedarían después de recuperar. Ese es el número que manda a la estantería.
const conPistaTras = new Set([...skuPorProducto].filter(([, v]) => v.size).map(([k]) => k));
for (const r of recuperables) conPistaTras.add(r.productId);
const activos = productos.filter((p) => p.is_active);
console.log(`\nProductos activos: ${activos.length}`);
console.log(`  con código de proveedor hoy:            ${activos.filter((p) => (skuPorProducto.get(p.id)?.size ?? 0) > 0).length}`);
console.log(`  con código de proveedor tras recuperar: ${activos.filter((p) => conPistaTras.has(p.id)).length}`);
console.log(`\n→ outputs/recuperacion-interna.json`);
