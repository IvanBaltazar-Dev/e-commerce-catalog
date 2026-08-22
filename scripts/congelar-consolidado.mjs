/**
 * Congela el consolidado: una huella de lo que hay, para que cualquier cambio
 * posterior sea visible en vez de silencioso.
 *
 * La huella no cuenta filas. Cuenta IDENTIDADES, porque ya sabemos que un total
 * puede ser correcto y faltar el 43% de las identidades — pasó al paginar sin
 * orden y no lo detectó ningún recuento.
 *
 * Se congela después de rematar el residuo y con los invariantes en verde, no
 * antes: congelar un estado que sabemos incompleto sería fijar el error.
 *
 *   node --experimental-transform-types scripts/congelar-consolidado.mjs [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = ["masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"];
const { data: fuentes } = await db.from("catalog_sources").select("id, source_key").in("source_key", FUENTES);
const ids = fuentes.map((f) => f.id);
const clave = Object.fromEntries(fuentes.map((f) => [f.id, f.source_key]));

// ── Los invariantes, comprobados aquí y no dados por buenos ─────────────────
const invariantes = {};
const contar = async (t, f = (q) => q) => (await f(db.from(t).select("*", { count: "exact", head: true }))).count ?? 0;

invariantes.retiradas_circulando = await contar("catalog_reference_variants_vigentes_v1",
  (q) => q.not("superseded_at", "is", null));
invariantes.precios_retirados_circulando = await contar("catalog_reference_prices_vigentes_v1",
  (q) => q.not("superseded_at", "is", null));
invariantes.canonizaciones = await contar("catalog_semantic_claims", (q) => q.eq("epistemic_class", "CANONICAL_FACT"));
invariantes.politicas_por_fuente = await contar("catalog_source_predicate_authority", (q) => q.not("source_id", "is", null));
invariantes.stock = await contar("inventory_stock");

// ── El material de la huella: identidades, no recuentos ─────────────────────
const productos = await leerTodo({
  consulta: () => db.from("catalog_reference_products")
    .select("id, primary_source_id, primary_external_id").in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "productos",
});
const variantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, primary_source_id, primary_external_id, sku, barcode").in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes vigentes",
});
const precios = await leerTodo({
  consulta: () => db.from("catalog_reference_prices_vigentes_v1")
    .select("id, source_id, currency, amount").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "precios vigentes",
});
const medios = await leerTodo({
  consulta: () => db.from("catalog_reference_media")
    .select("id, source_id, remote_url, reference_variant_id").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "medios",
});
const enriquecimiento = await leerTodo({
  consulta: () => db.from("catalog_enrichment_vigente_v1").select("source_id, entity_kind, external_id, field, value"),
  orden: ["source_key", "external_id", "field"], clave: (r) => `${r.source_id}|${r.external_id}|${r.field}|${r.value}`,
  nombre: "enriquecimiento",
});

const identidad = (xs, f) => xs.map(f).sort();
const material = {
  productos: identidad(productos, (p) => `${clave[p.primary_source_id]}|${p.primary_external_id}`),
  variantes: identidad(variantes, (v) => `${clave[v.primary_source_id]}|${v.primary_external_id}|${v.sku ?? ""}|${v.barcode ?? ""}`),
  precios: identidad(precios, (p) => `${clave[p.source_id]}|${p.currency}|${p.amount}`),
  medios: identidad(medios, (m) => `${clave[m.source_id]}|${m.remote_url}|${m.reference_variant_id ? "v" : "p"}`),
  enriquecimiento: identidad(enriquecimiento, (e) => `${e.external_id}|${e.field}|${e.value}`),
};

const huella = sha(material);
const resumen = {
  fuentes: fuentes.length,
  productos: productos.length,
  variantes_vigentes: variantes.length,
  variantes_con_sku: variantes.filter((v) => v.sku).length,
  variantes_con_gtin: variantes.filter((v) => v.barcode).length,
  precios_vigentes: precios.length,
  imagenes: medios.length,
  imagenes_de_variante: medios.filter((m) => m.reference_variant_id).length,
  enriquecimiento: enriquecimiento.length,
};

console.log(`\n${"═".repeat(72)}`);
console.log(`CONGELADO DEL CONSOLIDADO`);
console.log(`${"═".repeat(72)}\n`);
for (const [k, v] of Object.entries(resumen)) console.log(`   ${k.replace(/_/g, " ").padEnd(28)} ${String(v).padStart(7)}`);
console.log(`\n   invariantes:`);
let rojo = 0;
for (const [k, v] of Object.entries(invariantes)) {
  const ok = v === 0;
  if (!ok) rojo += 1;
  console.log(`     ${ok ? "✓" : "✗"} ${k.replace(/_/g, " ").padEnd(34)} ${v}`);
}
console.log(`\n   huella  ${huella}`);

if (rojo) { console.error(`\n${rojo} invariante(s) en rojo: no se congela.\n`); process.exit(1); }
if (!APLICAR) { console.log(`\nEnsayo. Añade --aplicar para escribir el congelado.\n`); process.exit(0); }

const destino = path.join(ROOT, "docs", "consolidado-congelado.json");
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, JSON.stringify({
  huella, resumen, invariantes,
  nota: "Huella sobre identidades, no sobre recuentos: un total puede ser correcto "
      + "y faltar identidades, y eso ya pasó al paginar sin orden estable.",
  material_por_bloque: Object.fromEntries(Object.entries(material).map(([k, v]) => [k, { n: v.length, huella: sha(v) }])),
}, null, 2), "utf8");
console.log(`\n→ docs/consolidado-congelado.json`);
