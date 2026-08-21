/**
 * Cosecha códigos de barras desde la ficha individual de una tienda Shopify.
 *
 * El endpoint paginado /products.json NO devuelve el campo barcode. La ficha
 * individual {url}.json SÍ. Es la misma tienda y la misma API: simplemente el
 * listado recorta campos y nadie lo había notado, porque sin barcode el catálogo
 * seguía pareciendo completo.
 *
 * Comprobado marca por marca antes de cosechar, para no gastar 3.400 peticiones
 * en balde:
 *
 *   masglo-es      EAN-13 reales, prefijo 7707 (GS1 Colombia)
 *   mc-nails-mx    barcode: null
 *   acrylove       barcode: null
 *   bigen-usa      barcode: null
 *   cherimoya-pe   WooCommerce, gtin: null
 *   admiss-co      la ficha individual responde 404
 *
 * Así que hoy solo Masglo aporta. Importa igual: el código de barras es la única
 * identidad que no depende de que dos catálogos escriban el nombre igual, y
 * hasta ahora teníamos cero de esta marca.
 *
 *   node --experimental-transform-types scripts/cosechar-barcodes-marca.mjs <source-key> [--aplicar]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const CLAVE = process.argv.slice(2).find((a) => !a.startsWith("--"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** EAN-13 y UPC-A con dígito de control. Un código que no valida no se guarda. */
function digitoValido(codigo) {
  const d = String(codigo).replace(/\D/g, "");
  if (d.length !== 13 && d.length !== 12) return false;
  const cifras = d.split("").map(Number);
  const control = cifras.pop();
  const pesos = d.length === 13 ? [1, 3] : [3, 1];
  const suma = cifras.reduce((a, n, i) => a + n * pesos[i % 2], 0);
  return ((10 - (suma % 10)) % 10) === control;
}
/** Los tres primeros dígitos dicen qué organización GS1 lo emitió. */
function paisGs1(codigo) {
  const p = Number(String(codigo).slice(0, 3));
  if (p >= 770 && p <= 771) return "CO";
  if (p >= 775 && p <= 775) return "PE";
  if (p >= 840 && p <= 849) return "ES";
  if (p >= 750 && p <= 750) return "MX";
  if (p >= 0 && p <= 139) return "US/CA";
  return null;
}

const { data: fuente } = await db.from("catalog_sources").select("id, base_url, metadata").eq("source_key", CLAVE).single();
const { data: prods } = await db.from("catalog_source_records")
  .select("id, source_url, payload").eq("source_id", fuente.id).eq("entity_type", "product").order("id");

console.log(`${CLAVE}: ${prods.length} fichas que consultar`);
const hallados = [];
let sinBarcode = 0, fallos = 0, hechas = 0;

for (const p of prods) {
  const url = (p.source_url ?? p.payload?.source_product_url ?? "").split("?")[0];
  if (!url) { fallos += 1; continue; }
  try {
    const r = await fetch(`${url}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
    if (r.ok) {
      const j = await r.json();
      for (const v of j.product?.variants ?? []) {
        if (!v.barcode) { sinBarcode += 1; continue; }
        hallados.push({
          externalId: `v:${v.id}`, barcode: String(v.barcode).trim(), sku: v.sku || null,
          titulo: j.product.title, valido: digitoValido(v.barcode), pais: paisGs1(v.barcode)
        });
      }
    } else fallos += 1;
  } catch { fallos += 1; }
  hechas += 1;
  if (hechas % 50 === 0) console.log(`   ${hechas}/${prods.length} · ${hallados.length} códigos`);
  await espera(650);
}

const validos = hallados.filter((h) => h.valido);
const invalidos = hallados.filter((h) => !h.valido);
console.log(`\nfichas consultadas:   ${hechas}`);
console.log(`códigos encontrados:  ${hallados.length}`);
console.log(`  con dígito válido:  ${validos.length}`);
console.log(`  con dígito INVÁLIDO:${invalidos.length}   (no se guardan: un GTIN que no valida no es un GTIN)`);
console.log(`variantes sin código: ${sinBarcode}`);
console.log(`fichas fallidas:      ${fallos}`);
const porPais = {};
for (const h of validos) porPais[h.pais ?? "desconocido"] = (porPais[h.pais ?? "desconocido"] ?? 0) + 1;
console.log(`\nemisor GS1:`);
for (const [k, v] of Object.entries(porPais).sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
if (invalidos.length) {
  console.log(`\nrechazados por dígito de control:`);
  for (const h of invalidos.slice(0, 5)) console.log(`   ${h.barcode.padEnd(16)} ${h.titulo.slice(0, 50)}`);
}

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

let escritos = 0;
for (const h of validos) {
  const { error, count } = await db.from("catalog_source_records")
    .update({ barcode: h.barcode }, { count: "exact" })
    .eq("source_id", fuente.id).eq("entity_type", "variant").eq("external_id", h.externalId);
  if (error) throw new Error(`update barcode: ${error.message}`);
  escritos += count ?? 0;
}
console.log(`\nvariantes actualizadas con código de barras: ${escritos}`);
