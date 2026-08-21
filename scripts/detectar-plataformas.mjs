/**
 * Qué plataforma usa cada fuente y qué estructura publica de verdad.
 *
 * Se hace antes de tocar ningún conector, porque la lección de Cherimoya fue
 * justo esa: rendía tono 0% y presentación 40% y parecía una fuente pobre;
 * resultó que publicaba atributos estructurados y los estábamos buscando con un
 * regex en el título. El desajuste era del adaptador, no de la fuente.
 *
 * Así que la pregunta no es «qué marca es» sino «qué superficie ofrece la
 * plataforma y cuánta estamos usando».
 *
 *   node --experimental-transform-types scripts/detectar-plataformas.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: fuentes } = await db.from("catalog_sources")
  .select("source_key, base_url, adapter")
  .in("source_key", ["masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
    "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"])
  .order("source_key");

/** La plataforma se pregunta, no se deduce del dominio. */
async function detectar(base) {
  try {
    const r = await fetch(base, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
    const powered = r.headers.get("powered-by") ?? r.headers.get("x-powered-by") ?? "";
    if (/shopify/i.test(powered)) return { plataforma: "Shopify", evidencia: `cabecera powered-by: ${powered}` };
    const html = await r.text();
    if (/wp-json\/wc\/store|woocommerce/i.test(html)) return { plataforma: "WooCommerce", evidencia: "referencias a wc/store en el HTML" };
    const gen = html.match(/<meta name="generator" content="([^"]*)"/i)?.[1];
    return { plataforma: gen ?? "desconocida", evidencia: gen ? "meta generator" : "sin señal clara" };
  } catch (e) { return { plataforma: "error", evidencia: String(e?.name ?? e) }; }
}

/** Cuánta estructura publica, y de qué clase. */
async function estructuraShopify(base) {
  const r = await fetch(`${base.replace(/\/$/, "")}/products.json?limit=100&page=1`,
    { headers: { "user-agent": UA }, signal: AbortSignal.timeout(40000) });
  if (!r.ok) return null;
  const ps = (await r.json()).products ?? [];
  const ejes = new Set();
  let conEjes = 0, multiVariante = 0, variantes = 0, conBarcode = 0;
  for (const p of ps) {
    // Shopify inventa una opción «Title / Default Title» cuando no hay ejes
    // reales. Contarla como estructura sería contarse un cuento.
    const reales = (p.options ?? []).filter(
      (o) => !(o.values ?? []).every((v) => String(v).toLowerCase() === "default title"));
    if (reales.length) conEjes += 1;
    for (const o of reales) ejes.add(o.name);
    variantes += (p.variants ?? []).length;
    if ((p.variants ?? []).length > 1) multiVariante += 1;
    conBarcode += (p.variants ?? []).filter((v) => v.barcode).length;
  }
  return { muestra: ps.length, conEjes, multiVariante, variantes, conBarcode, ejes: [...ejes] };
}

const informe = [];
for (const f of fuentes) {
  const plataforma = await detectar(f.base_url);
  let estructura = null;
  if (plataforma.plataforma === "Shopify") estructura = await estructuraShopify(f.base_url);
  informe.push({ ...f, ...plataforma, estructura });
  await espera(1200);
}

console.log(`\n${"═".repeat(84)}`);
console.log(`PLATAFORMA Y ESTRUCTURA REAL`);
console.log(`${"═".repeat(84)}\n`);
for (const i of informe) {
  console.log(`── ${i.source_key}`);
  console.log(`   plataforma detectada  ${i.plataforma}   (${i.evidencia})`);
  console.log(`   adaptador declarado   ${i.adapter}${i.plataforma === "Shopify" && i.adapter !== "shopify_products_json" ? "   ← NO COINCIDE" : ""}`);
  if (i.estructura) {
    const e = i.estructura;
    console.log(`   en ${e.muestra} fichas: ${e.conEjes} con ejes reales · ${e.multiVariante} multi-variante · ${e.variantes} variantes · ${e.conBarcode} con código de barras`);
    console.log(`   ejes de variación: ${e.ejes.length ? e.ejes.join(" | ") : "ninguno — cada tono es un producto suelto"}`);
  }
  console.log();
}

const porPlataforma = {};
for (const i of informe) (porPlataforma[i.plataforma] ??= []).push(i.source_key);
console.log(`${"═".repeat(84)}`);
console.log(`AGRUPACIÓN POR CONECTOR`);
console.log(`${"═".repeat(84)}`);
for (const [p, ks] of Object.entries(porPlataforma)) {
  console.log(`   ${p.padEnd(14)} ${ks.length}   ${ks.join(", ")}`);
}

fs.writeFileSync(path.join(ROOT, "outputs", "plataformas.json"), JSON.stringify(informe, null, 2), "utf8");
console.log(`\n→ outputs/plataformas.json`);
