/**
 * La hoja de captura física, agrupada por PROVEEDOR y no por marca.
 *
 * El checklist anterior ya pedía «Código de barras» en sus 423 fichas y
 * volvieron cero de 1.570. Dos cosas cambian aquí:
 *
 * 1. Se agrupa por prefijo de código de proveedor, no por marca. «SHEY» son 73
 *    códigos repartidos en 14 marcas nuestras —AIFER, STRONGER, SUN, GLOBAL
 *    NAIL, NEW SHOW, ZOLA…— que en realidad son un solo surtido. Una sesión de
 *    captura por proveedor recorre estantería contigua; una por marca fantasma
 *    manda a la persona a dar vueltas.
 *
 * 2. La hoja trae columnas VACÍAS para rellenar y un script que las lee de
 *    vuelta (importar-captura.mjs). Un dato que se pide sin sitio donde
 *    aterrizar no se pide de verdad.
 *
 * Salida: outputs/hoja-captura-fisica.csv
 *
 * Uso: node scripts/generar-hoja-captura.mjs
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

const variantes = await todas(
  "product_variants",
  "id, sku, sku_interno, sku_origen, barcode, name, is_active, product_id, " +
    "products(id, code, name, presentation, is_active, categories(name), brands(name))"
);
const prefijos = await todas("catalog_supplier_prefix_v1", "prefijo, product_id, supplier_sku", "product_id");

const prefijoPorProducto = new Map();
const codigoPorProducto = new Map();
for (const p of prefijos) {
  if (!prefijoPorProducto.has(p.product_id)) prefijoPorProducto.set(p.product_id, p.prefijo);
  if (!codigoPorProducto.has(p.product_id)) codigoPorProducto.set(p.product_id, p.supplier_sku);
}

// Quién necesita captura: todo lo que no tiene ya un identificador contrastable.
// Una variante con SKU de fabricante ya se puede reconciliar; volver a
// fotografiarla es tiempo de alguien tirado.
const pendientes = variantes.filter((v) => {
  if (!v.is_active || !v.products?.is_active) return false;
  if (v.sku_origen === "OFICIAL_MARCA") return false;
  if (v.barcode) return false;
  return true;
});

const filas = pendientes.map((v) => {
  const p = v.products;
  const prefijo = prefijoPorProducto.get(p.id) ?? "";
  return {
    // Lo que la persona usa para encontrarlo en la estantería
    grupo_sesion: prefijo ? `Proveedor ${prefijo}` : `Sin proveedor · ${p.categories?.name ?? "sin categoría"}`,
    prefijo_proveedor: prefijo,
    codigo_proveedor: codigoPorProducto.get(p.id) ?? "",
    marca_etiqueta: p.brands?.name ?? "",
    categoria: p.categories?.name ?? "",
    producto: p.name,
    presentacion: p.presentation ?? "",
    variante: v.name,
    codigo_interno: v.sku ?? "",
    // ── Columnas A RELLENAR en la sesión ──
    codigo_barras: "",
    codigo_impreso_en_envase: "",
    marca_impresa_en_envase: "",
    contenido_neto: "",
    pais_origen: "",
    fotos_tomadas: "",
    notas: "",
    // Trazabilidad
    variant_id: v.id,
    product_code: p.code
  };
});

// Orden: los grupos grandes primero, porque una sesión que empieza por el
// surtido de 73 códigos rinde más que una que empieza por un producto suelto.
const tamano = new Map();
for (const f of filas) tamano.set(f.grupo_sesion, (tamano.get(f.grupo_sesion) ?? 0) + 1);
filas.sort((a, b) =>
  (tamano.get(b.grupo_sesion) - tamano.get(a.grupo_sesion)) ||
  a.grupo_sesion.localeCompare(b.grupo_sesion) ||
  a.producto.localeCompare(b.producto)
);

function csv(valor) {
  const s = valor === null || valor === undefined ? "" : String(valor);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const cabeceras = Object.keys(filas[0]);
const salida = path.join(ROOT, "outputs", "hoja-captura-fisica.csv");
writeFileSync(
  salida,
  "﻿" + [cabeceras.join(","), ...filas.map((f) => cabeceras.map((c) => csv(f[c])).join(","))].join("\n") + "\n",
  "utf8"
);

console.log(`Variantes activas: ${variantes.filter((v) => v.is_active && v.products?.is_active).length}`);
console.log(`Ya identificadas (SKU de fabricante o código de barras): ${variantes.filter((v) => v.is_active && v.products?.is_active && (v.sku_origen === "OFICIAL_MARCA" || v.barcode)).length}`);
console.log(`A capturar: ${filas.length}\n`);

console.log("Sesiones por tamaño (las primeras rinden más):");
for (const [g, n] of [...tamano].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`   ${String(n).padStart(4)}  ${g}`);
}
const conPrefijo = filas.filter((f) => f.prefijo_proveedor).length;
console.log(`\nCon proveedor conocido: ${conPrefijo}  ·  sin proveedor: ${filas.length - conPrefijo}`);
console.log(`\n→ ${salida}`);
console.log(`Rellenar «codigo_barras» y devolver con:  node scripts/importar-captura.mjs <ruta>`);
