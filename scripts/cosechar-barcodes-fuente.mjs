/**
 * Cosecha los códigos de barras que la fuente sí publicaba.
 *
 * El gate encontró la causa exacta de que tuviéramos cero: nuestro rastreo leyó
 * `/products.json`, que NO incluye `barcode` entre los campos de variante.
 * `/products/{handle}.js` sí lo incluye, y tres de las cinco tiendas lo tienen
 * cargado con EAN-13 reales:
 *
 *   masglo.com.es   7707773839938   (prefijo 770 · Colombia)
 *   admiss.com.co   7707109946750
 *   bigen-usa.com     33859001126
 *
 * O sea que el dato llevaba meses publicado y accesible, y la conclusión «hacen
 * falta 1.255 capturas físicas» estaba inflada por un campo que no pedimos.
 *
 * Esto los trae al universo de referencia. NO los escribe en el catálogo
 * comercial: pasarlos a product_variants es consecuencia de una identidad
 * reconciliada, no de haberlos encontrado. Aquí solo se recuerda lo que la
 * fuente dice.
 *
 * Una petición por ficha, con pausa entre ellas: son 442 y no hay prisa
 * ninguna. Se valida el dígito de control antes de guardar, igual que con la
 * captura física — un código mal leído del HTML es tan dañino como uno mal
 * tecleado en la estantería.
 *
 * Uso:
 *   node scripts/cosechar-barcodes-fuente.mjs             (ensayo)
 *   node scripts/cosechar-barcodes-fuente.mjs --aplicar
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const PAUSA_MS = 220;
const UA = "BellarosheCatalogResearch/1.0";

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Mismo validador que importar-captura.mjs. Un EAN que no cierra su dígito de
// control no se guarda venga de donde venga: el que falta se ve, el que está
// mal contesta con seguridad por otro producto.
function digitoDeControlValido(codigo) {
  if (!/^\d+$/.test(codigo)) return false;
  if (![8, 12, 13, 14].includes(codigo.length)) return false;
  const digitos = codigo.split("").map(Number);
  const control = digitos.pop();
  let suma = 0;
  for (let i = digitos.length - 1, peso = 3; i >= 0; i -= 1, peso = peso === 3 ? 1 : 3) suma += digitos[i] * peso;
  return (10 - (suma % 10)) % 10 === control;
}

const veredictos = JSON.parse(readFileSync(path.join(ROOT, "outputs", "gate-barcode-fuente.json"), "utf8"));
const conBarcode = veredictos.filter((v) => v.veredicto === "BARCODE_PRESENT");
console.log(`Tiendas que publican código de barras: ${conBarcode.map((v) => v.tienda).join(", ")}\n`);

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

const fuentes = await todas("catalog_sources", "id, source_key, base_url");
const refProductos = await todas("catalog_reference_products", "id, reference_key, primary_source_id, primary_external_id, name, metadata");
const refVariantes = await todas("catalog_reference_variants", "id, reference_product_id, primary_external_id, sku, barcode");

const varPorExterno = new Map(refVariantes.map((v) => [v.primary_external_id, v]));
const varPorSku = new Map(refVariantes.filter((v) => v.sku).map((v) => [v.sku.trim().toUpperCase(), v]));

const objetivo = [];
for (const t of conBarcode) {
  const f = fuentes.find((x) => x.source_key === t.tienda);
  if (!f) continue;
  for (const rp of refProductos) {
    if (rp.primary_source_id !== f.id) continue;
    const handle = rp.metadata?.handle;
    if (handle) objetivo.push({ base: f.base_url.replace(/\/$/, ""), handle, tienda: t.tienda, nombre: rp.name });
  }
}

console.log(`Fichas a consultar: ${objetivo.length}`);
if (!APLICAR) {
  console.log(`\nEnsayo. Añade --aplicar para consultarlas y guardar los códigos.`);
  process.exit(0);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const encontrados = [];
const invalidos = [];
let consultadas = 0, fallidas = 0, sinCodigo = 0;

for (const o of objetivo) {
  try {
    const respuesta = await fetch(`${o.base}/products/${o.handle}.js`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000)
    });
    if (!respuesta.ok) { fallidas += 1; await espera(PAUSA_MS); continue; }
    const ficha = await respuesta.json();
    consultadas += 1;

    for (const v of ficha.variants ?? []) {
      const bruto = (v.barcode ?? "").toString().trim();
      if (!bruto) { sinCodigo += 1; continue; }
      const codigo = bruto.replace(/[\s-]/g, "");
      if (!digitoDeControlValido(codigo)) {
        invalidos.push({ tienda: o.tienda, sku: v.sku, codigo, producto: ficha.title });
        continue;
      }
      // La variante se localiza por su id externo; si la tienda reindexó, se
      // cae al SKU de fabricante, que es más estable que el id interno.
      const destino = varPorExterno.get(String(v.id)) ?? (v.sku ? varPorSku.get(v.sku.trim().toUpperCase()) : null);
      if (!destino) continue;
      encontrados.push({ id: destino.id, barcode: codigo, sku: v.sku, producto: ficha.title, tienda: o.tienda });
    }
  } catch (error) {
    fallidas += 1;
  }
  if ((consultadas + fallidas) % 50 === 0) console.log(`   ${consultadas + fallidas}/${objetivo.length}…`);
  await espera(PAUSA_MS);
}

console.log(`\nFichas consultadas: ${consultadas} · fallidas: ${fallidas}`);
console.log(`Variantes con código válido:   ${encontrados.length}`);
console.log(`Variantes sin código en fuente: ${sinCodigo}`);
console.log(`Códigos que no pasan el dígito de control: ${invalidos.length}`);
for (const i of invalidos.slice(0, 6)) console.log(`   ${i.codigo.padEnd(16)} ${i.tienda} · ${String(i.producto).slice(0, 40)}`);

const porTienda = new Map();
for (const e of encontrados) porTienda.set(e.tienda, (porTienda.get(e.tienda) ?? 0) + 1);
console.log(`\nPor tienda:`);
for (const [t, n] of [...porTienda].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${t}`);

let guardados = 0;
for (let i = 0; i < encontrados.length; i += 300) {
  const lote = encontrados.slice(i, i + 300);
  for (const e of lote) {
    const { error } = await db.from("catalog_reference_variants")
      .update({ barcode: e.barcode }).eq("id", e.id);
    if (!error) guardados += 1;
  }
  console.log(`   guardando: ${Math.min(i + 300, encontrados.length)}/${encontrados.length}`);
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "cosecha-barcodes.json"),
  JSON.stringify({ consultadas, fallidas, encontrados: encontrados.length, sinCodigo, invalidos }, null, 2), "utf8");

console.log(`\nGuardados en el universo de referencia: ${guardados}`);
console.log(`No se ha tocado product_variants: eso depende de una identidad reconciliada.`);
