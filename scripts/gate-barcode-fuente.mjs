/**
 * ¿Por qué no tenemos ni un código de barras de las fuentes oficiales?
 *
 * Dije que «Shopify no expone barcodes» y me pasé de la evidencia. Lo único
 * demostrado es que en NUESTRAS capturas no recuperamos ninguno. La API pública
 * de Shopify sí incluye `barcode` dentro de cada variante cuando el comercio lo
 * tiene cargado, tanto en /products.json como en /products/{handle}.js.
 *
 * Hay cuatro causas posibles y llevan a acciones distintas:
 *
 *   BARCODE_PRESENT                 lo hay y no lo estábamos leyendo
 *   BARCODE_NULL_AT_SOURCE          la tienda no lo cargó — nada que rascar
 *   BARCODE_NOT_CAPTURED_PREVIOUSLY el campo existe pero nuestro rastreo lo tiró
 *   BARCODE_ENDPOINT_UNAVAILABLE    no se puede comprobar desde aquí
 *
 * Sin esta distinción, dentro de tres meses alguien vuelve a leer «faltan
 * códigos de barras» y no sabe si ya se miró. Una comprobación guardada vale
 * más que una suposición repetida.
 *
 * Muestrea, no barre: una ficha por tienda basta para distinguir las cuatro
 * causas, y machacar seis tiendas con miles de peticiones para confirmar lo
 * mismo sería maleducado y lento.
 *
 * Uso: node scripts/gate-barcode-fuente.mjs
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

const MUESTRA_POR_TIENDA = 3;
const UA = "BellarosheCatalogResearch/1.0";

const { data: fuentes } = await db
  .from("catalog_sources")
  .select("id, source_key, base_url, adapter")
  .eq("adapter", "shopify_products_json");

console.log(`Tiendas Shopify registradas: ${fuentes?.length ?? 0}\n`);

const veredictos = [];

for (const f of fuentes ?? []) {
  // Se toman handles de lo ya rastreado: son fichas que sabemos que existían.
  const { data: registros } = await db
    .from("catalog_source_records")
    .select("payload")
    .eq("source_id", f.id).eq("entity_type", "product")
    .limit(MUESTRA_POR_TIENDA);

  const handles = (registros ?? []).map((r) => r.payload?.handle).filter(Boolean);
  if (!handles.length) {
    veredictos.push({ tienda: f.source_key, veredicto: "BARCODE_ENDPOINT_UNAVAILABLE", detalle: "no hay handles rastreados" });
    continue;
  }

  let campoPresente = 0, conValor = 0, consultadas = 0, fallos = 0;
  const ejemplos = [];

  for (const handle of handles) {
    const url = `${f.base_url.replace(/\/$/, "")}/products/${handle}.js`;
    try {
      const respuesta = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (!respuesta.ok) { fallos += 1; continue; }
      const ficha = await respuesta.json();
      consultadas += 1;
      for (const v of ficha.variants ?? []) {
        // «El campo no viene» y «viene en null» son cosas distintas: la primera
        // dice que el adaptador no lo pide, la segunda que la tienda no lo tiene.
        if ("barcode" in v) campoPresente += 1;
        if ((v.barcode ?? "").toString().trim()) {
          conValor += 1;
          if (ejemplos.length < 3) ejemplos.push({ sku: v.sku, barcode: v.barcode, titulo: ficha.title });
        }
      }
    } catch (error) {
      fallos += 1;
    }
  }

  let veredicto;
  if (!consultadas) veredicto = "BARCODE_ENDPOINT_UNAVAILABLE";
  else if (conValor > 0) veredicto = "BARCODE_PRESENT";
  else if (campoPresente > 0) veredicto = "BARCODE_NULL_AT_SOURCE";
  else veredicto = "BARCODE_NOT_CAPTURED_PREVIOUSLY";

  veredictos.push({
    tienda: f.source_key, base: f.base_url, veredicto,
    fichasConsultadas: consultadas, fichasFallidas: fallos,
    variantesConCampo: campoPresente, variantesConValor: conValor, ejemplos
  });

  console.log(`${f.source_key.padEnd(24)} ${veredicto.padEnd(32)} ${consultadas} fichas · ${campoPresente} variantes con campo · ${conValor} con valor`);
  for (const e of ejemplos) console.log(`     ${String(e.barcode).padEnd(16)} ${String(e.sku ?? "").padEnd(12)} ${String(e.titulo).slice(0, 44)}`);
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "gate-barcode-fuente.json"), JSON.stringify(veredictos, null, 2), "utf8");

const resumen = new Map();
for (const v of veredictos) resumen.set(v.veredicto, (resumen.get(v.veredicto) ?? 0) + 1);
console.log(`\nVeredicto por tienda:`);
for (const [k, n] of [...resumen].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);

if (resumen.get("BARCODE_PRESENT")) {
  console.log(`\n⚠ Hay tiendas que SÍ publican código de barras. El rastreo debe volver a`);
  console.log(`  pasar por ellas leyendo ese campo: son GTIN gratis, sin tocar un envase.`);
} else if (resumen.get("BARCODE_NULL_AT_SOURCE")) {
  console.log(`\nEl campo existe en la respuesta y viene vacío: estas tiendas no lo cargaron.`);
  console.log(`No es un fallo nuestro y no se arregla volviendo a rastrear.`);
}
console.log(`\n→ outputs/gate-barcode-fuente.json`);
