/**
 * Detector de incoherencias que NO necesita fuente oficial.
 *
 * La auditoría contra las tiendas oficiales solo alcanza al 3,6% del catálogo:
 * 56 de 1.570 variantes tienen un SKU verificable. El resto lleva correlativos
 * nuestros, que no significan nada fuera de esta base. Con esa vara, «no
 * encuentro más incoherencias» solo dice que no puedo mirar.
 *
 * Pero el catálogo se delata solo. Un producto que se llama «Base Ajos y Limon»
 * y vive en «Esmaltes» no necesita que Colombia lo confirme: su propio nombre
 * dice qué es. Esto revisa los 1.051 productos y las 1.570 variantes con esa
 * regla, y busca cuatro clases de error:
 *
 *   1. NOMBRE_CONTRA_CATEGORIA   se llama X y está en la categoría de Y
 *   2. VARIANTE_CONTRA_PRODUCTO  la variante declara otra clase que su producto
 *   3. DUPLICADO_INTERNO         lo mismo existe dos veces, en dos sitios
 *   4. PRODUCTO_SIN_LINEA        marca con líneas declaradas y producto sin ella
 *
 * No cambia nada. Enumera y agrupa por clase, para poder cerrar familias.
 *
 * Uso:  node scripts/auditar-coherencia-interna.mjs
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

const norm = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── Qué dice el nombre que es ───────────────────────────────────────────────
//
// El orden importa: «Brillo Gel Tapa» es un brillo, no un gel. Se evalúa de más
// específico a más general y gana la primera.
//
// Solo se afirma cuando la palabra encabeza el nombre o va sola. «Esmalte para
// base de acrílico» no es una base, y buscar «base» en cualquier posición lo
// convertiría en una.
//
// Cada clase lleva un CONJUNTO de categorías aceptables, no una sola. Con un
// único valor esperado, la primera versión denunció 104 productos por estar en
// «Limas, buffers y pulido» — que es como se llama la categoría de verdad —
// mientras mi tabla esperaba una «Limas, pulidores y buffers» inventada. Cien
// falsos positivos son peores que ninguna auditoría: mandan a corregir lo que
// ya estaba bien.
//
// Y donde el nombre no basta para decidir, no se decide. Una «Crema Corp
// Depilatoria» puede vivir en cremas depilatorias o en cuidado corporal, y las
// dos son defendibles: se aceptan ambas en vez de fingir certeza.
const CLASES = [
  { clase: "BASE",   patron: /^(base|bases)\b/,
    ok: ["Bases, tops y finalizadores", "Preparadores y adherencia"] },
  { clase: "BRILLO", patron: /^(brillo|brillos|top coat|matificador|sellante)\b/,
    ok: ["Bases, tops y finalizadores"] },
  { clase: "REMOVEDOR", patron: /^(removedor|removedores|quita esmalte|acetona|dilusor|diluyente|limpiador)\b/,
    ok: ["Remoción y limpieza", "Cuidado de cutícula, manos y pies", "Desinfección y mantenimiento", "Sanitización y esterilización"] },
  { clase: "LIMA", patron: /^(lima|limas|pulidor|pulidora|buffer)\b/,
    ok: ["Limas, buffers y pulido", "Brocas y repuestos de drill", "Herramientas de manicure y pedicure"] },
  { clase: "ACRILICO", patron: /^(polvo acrilico|monomero|liquido acrilico)\b/,
    ok: ["Sistema acrílico"] },
  { clase: "PINCEL", patron: /^(pincel|pinceles|brocha|brochas)\b/,
    ok: ["Pinceles y herramientas de diseño", "Diseño y tinturación de cejas", "Maquillaje de ojos y rostro", "Cepillos y peines", "Herramientas y consumibles"] },
  { clase: "DECORACION", patron: /^(decoracion|glitter|sticker|stickers|piedras|gemas)\b/,
    ok: ["Decoración y nail art"] },
  { clase: "ESMALTE", patron: /^(esmalte|esmaltes)\b/,
    ok: ["Esmaltes", "Esmaltes en gel", "Gel semipermanente", "Decoración y nail art"] }
];

function claseDelNombre(nombre) {
  const n = norm(nombre);
  for (const c of CLASES) if (c.patron.test(n)) return c;
  return null;
}

// Un nombre que es solo una medida —«15ML», «X6PZA», «100/180»— no nombra nada:
// es la presentación puesta donde debería ir el nombre. Agruparlos como si
// fueran el mismo producto daba «Cherimoya · 15ml» con cuatro entradas de
// cuatro productos sin relación.
const soloMedida = (s) => /^[\d\s.,/x×+-]*(ml|gr|g|oz|cc|kg|pza|pzas|und|uds|u|cm|mm|pcs)?$/i.test((s ?? "").trim());

const productos = await todas(
  "products",
  "id, code, name, presentation, is_active, editorial_status, category_id, brand_id, product_line_id, categories(name), brands(name), product_lines(name)"
);
const variantes = await todas("product_variants", "id, sku, name, is_active, product_id");

const porProducto = new Map(productos.map((p) => [p.id, p]));
const variantesDe = new Map();
for (const v of variantes) {
  if (!variantesDe.has(v.product_id)) variantesDe.set(v.product_id, []);
  variantesDe.get(v.product_id).push(v);
}

const hallazgos = [];

// ── 1. El nombre del producto contra su categoría ───────────────────────────
for (const p of productos) {
  const c = claseDelNombre(p.name);
  if (!c) continue;
  const categoria = p.categories?.name ?? "(sin categoría)";
  if (c.ok.includes(categoria)) continue;
  hallazgos.push({
    tipo: "NOMBRE_CONTRA_CATEGORIA",
    marca: p.brands?.name ?? "—",
    producto: p.code,
    nombre: p.name,
    activo: p.is_active,
    estado: p.editorial_status,
    categoria_actual: categoria,
    categoria_segun_nombre: c.ok[0],
    clase: c.clase
  });
}

// ── 2. La variante declara otra clase que su producto ───────────────────────
// Este es el patrón de «Ajo y Limón»: el producto es un esmalte y dentro hay
// una variante que se llama como una base. Se exige que la variante nombre una
// clase DISTINTA de la de su producto, no solo que nombre alguna.
for (const v of variantes) {
  const p = porProducto.get(v.product_id);
  if (!p) continue;
  const cv = claseDelNombre(v.name);
  if (!cv) continue;
  const cp = claseDelNombre(p.name);
  const categoria = p.categories?.name ?? "(sin categoría)";
  if (cv.ok.includes(categoria)) continue;
  if (cp && cp.clase === cv.clase) continue;
  hallazgos.push({
    tipo: "VARIANTE_CONTRA_PRODUCTO",
    marca: p.brands?.name ?? "—",
    producto: p.code,
    nombre: `${p.name} · ${v.name}`,
    sku: v.sku,
    activo: v.is_active,
    estado: p.editorial_status,
    categoria_actual: categoria,
    categoria_segun_nombre: cv.ok[0],
    clase: cv.clase
  });
}

// ── 3. Lo mismo, dos veces, en dos sitios ───────────────────────────────────
//
// El caso de «Brillo Benevolente»: existía como producto propio en Bases y como
// tono dentro del esmalte. Se busca por marca + nombre normalizado, mirando
// tanto productos como variantes, y se denuncia cuando caen en categorías
// distintas: dos entradas iguales en la MISMA categoría son presentaciones, no
// un error.
const porClaveNombre = new Map();
function apunta(marca, nombre, categoria, ref) {
  if (soloMedida(nombre)) return;
  const n = norm(nombre).replace(/\b(brillo|esmalte|base|decoracion)\b/g, "").trim();
  if (n.length < 4 || soloMedida(n)) return;
  const k = `${marca}::${n}`;
  if (!porClaveNombre.has(k)) porClaveNombre.set(k, []);
  porClaveNombre.get(k).push({ categoria, ...ref });
}
for (const p of productos) {
  apunta(p.brands?.name ?? "—", p.name, p.categories?.name ?? "—", { que: "producto", code: p.code, nombre: p.name, activo: p.is_active });
}
for (const v of variantes) {
  const p = porProducto.get(v.product_id);
  if (!p) continue;
  apunta(p.brands?.name ?? "—", v.name, p.categories?.name ?? "—", { que: "variante", code: p.code, nombre: `${p.name} · ${v.name}`, sku: v.sku, activo: v.is_active });
}
for (const [clave, entradas] of porClaveNombre) {
  const activas = entradas.filter((e) => e.activo);
  if (activas.length < 2) continue;
  const categorias = new Set(activas.map((e) => e.categoria));
  if (categorias.size < 2) continue;

  // Un duplicado de verdad tiene una entrada de cada rango: existe como
  // PRODUCTO en un sitio y como VARIANTE en otro. Eso es «Brillo Benevolente»,
  // que era producto en Bases y tono dentro del esmalte.
  //
  // Sin esta condición entraban los nombres de color: «Blanco» aparece como
  // variante de una vincha, de dos toallas, de un peine y de un extractor de
  // polvo. Cinco productos sin relación que comparten el nombre de un color no
  // son un duplicado, y tratarlos como tal mandaría a fusionar una toalla con
  // un torno.
  const hayProducto = activas.some((e) => e.que === "producto");
  const hayVarianteFuera = activas.some(
    (e) => e.que === "variante" && !activas.some((q) => q.que === "producto" && q.categoria === e.categoria)
  );
  if (!hayProducto || !hayVarianteFuera) continue;
  const [marca, nombre] = clave.split("::");
  hallazgos.push({
    tipo: "DUPLICADO_INTERNO",
    marca,
    nombre,
    categoria_actual: [...categorias].join("  ·vs·  "),
    entradas: activas.map((e) => `${e.que} ${e.code}${e.sku ? "/" + e.sku : ""} · ${e.nombre} [${e.categoria}]`)
  });
}

// ── 4. Marca con líneas declaradas y producto sin línea ─────────────────────
const marcasConLinea = new Set(productos.filter((p) => p.product_lines?.name).map((p) => p.brands?.name));
for (const p of productos) {
  const marca = p.brands?.name ?? "—";
  if (!marcasConLinea.has(marca)) continue;
  if (p.product_lines?.name) continue;
  hallazgos.push({
    tipo: "PRODUCTO_SIN_LINEA",
    marca,
    producto: p.code,
    nombre: p.name,
    activo: p.is_active,
    estado: p.editorial_status,
    categoria_actual: p.categories?.name ?? "—"
  });
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "coherencia-interna.json"), JSON.stringify(hallazgos, null, 2), "utf8");

console.log(`Productos revisados: ${productos.length}`);
console.log(`Variantes revisadas: ${variantes.length}`);
console.log(`Hallazgos: ${hallazgos.length}\n`);

const porTipo = new Map();
for (const h of hallazgos) {
  if (!porTipo.has(h.tipo)) porTipo.set(h.tipo, []);
  porTipo.get(h.tipo).push(h);
}
for (const [tipo, lista] of [...porTipo].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${"═".repeat(76)}\n${tipo} · ${lista.length}\n${"═".repeat(76)}`);
  if (tipo === "PRODUCTO_SIN_LINEA") {
    const porMarca = new Map();
    for (const h of lista) porMarca.set(h.marca, (porMarca.get(h.marca) ?? 0) + 1);
    for (const [m, n] of [...porMarca].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${m}`);
    console.log();
    continue;
  }
  const muestra = lista.slice(0, 22);
  for (const h of muestra) {
    if (tipo === "DUPLICADO_INTERNO") {
      console.log(`\n  ${h.marca} · «${h.nombre}»`);
      for (const e of h.entradas) console.log(`     ${e}`);
    } else {
      console.log(`  ${(h.producto ?? "").padEnd(16)} ${h.nombre.slice(0, 40).padEnd(42)} ${h.categoria_actual.slice(0, 26).padEnd(28)} → ${h.categoria_segun_nombre}`);
    }
  }
  if (lista.length > muestra.length) console.log(`  … y ${lista.length - muestra.length} más`);
  console.log();
}
console.log("→ outputs/coherencia-interna.json");
