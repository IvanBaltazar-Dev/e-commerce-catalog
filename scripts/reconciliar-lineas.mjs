/**
 * Cruza cada variante de los dos esmaltes publicados contra la ficha oficial de
 * su marca, y dice cuáles NO son un tono de esmalte.
 *
 * La pregunta que responde: «Ajo y Limón está como tono de Esmalte ADMISS —
 * ¿cuántas más hay así?». No adivina: compara contra
 * research/catalog-master/data, que es el rastreo de admiss.com.co y
 * masglo.com.es con confianza CONFIRMADO_OFICIAL.
 *
 * Salida: outputs/reconciliacion-lineas.json + un resumen por consola.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "research", "catalog-master", "data");

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
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
  return resto.filter((f) => f.length === cab.length).map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i]])));
}
const leer = (n) => parseCsv(readFileSync(path.join(DATA, n), "utf8"));

const oficiales = leer("external_official_products.csv");
const varOficiales = leer("external_official_variants.csv");
const imgOficiales = leer("external_official_images.csv");

const imgsPorProducto = new Map();
for (const im of imgOficiales) {
  if (!imgsPorProducto.has(im.external_product_id)) imgsPorProducto.set(im.external_product_id, []);
  imgsPorProducto.get(im.external_product_id).push(im.image_url);
}
const precioPorProducto = new Map();
for (const v of varOficiales) {
  if (!precioPorProducto.has(v.external_product_id)) precioPorProducto.set(v.external_product_id, v.price);
}

// Normaliza para comparar: sin tildes, sin puntuación, en minúsculas. El tono
// «Ajo y Limon» de nuestra base y «AJO Y LIMÓN» del sitio son el mismo.
const norm = (s) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function lineaDe(p) {
  const tags = (p.tags ?? "").split("|").map((t) => t.trim().toUpperCase());
  if (p.brand === "Masglo") {
    if (tags.includes("GEL POLISH") || tags.includes("MASGLO PROFESSIONAL")) return "Gel Polish";
    if (tags.includes("GEL EVOLUTION") || tags.includes("BASE GEL EVOLUTION")) return "Gel Evolution";
    if (tags.includes("MASGLO ADVANCED") || tags.includes("ADVANCED")) return "Advanced";
    if (tags.includes("TRADICIONAL") || tags.includes("ESMALTE TRADICIONAL") || tags.includes("BASE TRADICIONAL")) return "Tradicional";
  }
  if (p.brand === "Admiss") {
    if (tags.includes("BASES")) return "Bases";
    if (tags.includes("BRILLOS")) return "Brillos";
    if (tags.includes("ESMALTE TRADICIONAL") || tags.includes("TRADICIONAL")) return "Esmalte tradicional";
  }
  return p.product_type || "(sin línea)";
}

// La clase real del producto según la marca: lo que decide si es un tono de
// esmalte o es otra cosa que se coló como tono.
function claseDe(p) {
  const t = (p.product_type ?? "").toUpperCase();
  const titulo = (p.title ?? "").toUpperCase();
  if (t.startsWith("BASE") || titulo.startsWith("BASE ")) return "BASE";
  if (t.startsWith("BRILLO") || titulo.startsWith("BRILLO ")) return "BRILLO";
  if (titulo.includes("DECORACIÓN") || titulo.includes("DECORACION")) return "DECORACION";
  if (t === "ESMALTE" || t.includes("ESMALTE")) return "ESMALTE";
  if (t.includes("REMOVEDOR") || t.includes("LIQUIDO")) return "LIQUIDO";
  if (t.includes("KIT")) return "KIT";
  return t || "(otro)";
}

const CASOS = [
  { code: "ADM-ESM-CA6EEA", marca: "Admiss" },
  { code: "MAS-ESM-4C95F3", marca: "Masglo" }
];

const informe = [];

for (const caso of CASOS) {
  const { data: producto } = await db.from("products").select("id, code, name, presentation").eq("code", caso.code).single();
  const { data: variantes } = await db
    .from("product_variants")
    .select("id, sku, name, variant_key")
    .eq("product_id", producto.id)
    .order("name");

  const deLaMarca = oficiales.filter((p) => p.brand === caso.marca);

  // Índice por nombre normalizado del tono. El título oficial trae marca,
  // presentación y gama alrededor del nombre, así que se busca por contención
  // de palabras y no por igualdad.
  function buscarOficial(nombreVariante) {
    const n = norm(nombreVariante);
    if (!n) return null;
    const palabras = n.split(" ").filter((w) => w.length > 2);
    let mejor = null;
    let mejorPuntos = 0;
    for (const p of deLaMarca) {
      const titulo = norm(p.title);
      // El nombre del tono tiene que aparecer entero, como secuencia, para no
      // casar «Rosa» con cualquier título que lleve «rosada» suelta.
      if (!titulo.includes(n)) continue;
      const puntos = palabras.length * 10 - Math.abs(titulo.length - n.length) / 10;
      if (puntos > mejorPuntos) { mejorPuntos = puntos; mejor = p; }
    }
    return mejor;
  }

  const filas = variantes.map((v) => {
    const of = buscarOficial(v.name);
    return {
      sku: v.sku,
      variante: v.name,
      encontrada: Boolean(of),
      titulo_oficial: of?.title ?? null,
      linea_oficial: of ? lineaDe(of) : null,
      clase_oficial: of ? claseDe(of) : null,
      precio_oficial: of ? precioPorProducto.get(of.external_product_id) ?? null : null,
      imagenes_oficiales: of ? (imgsPorProducto.get(of.external_product_id) ?? []).length : 0,
      url: of?.source_product_url ?? null,
      descripcion: of?.description ? of.description.slice(0, 300) : null
    };
  });

  informe.push({ producto: producto.code, nombre: producto.name, marca: caso.marca, variantes: filas });

  const porClase = new Map();
  const porLinea = new Map();
  for (const f of filas) {
    const c = f.clase_oficial ?? "(sin ficha oficial)";
    const l = f.linea_oficial ?? "(sin ficha oficial)";
    porClase.set(c, (porClase.get(c) ?? 0) + 1);
    porLinea.set(l, (porLinea.get(l) ?? 0) + 1);
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`${producto.name}  (${producto.code})  ·  ${filas.length} variantes en nuestra base`);
  console.log("═".repeat(78));

  console.log("\n  Qué son en realidad, según la marca:");
  for (const [c, n] of [...porClase].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${c}`);

  console.log("\n  A qué línea pertenecen:");
  for (const [l, n] of [...porLinea].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${l}`);

  const intrusas = filas.filter((f) => f.clase_oficial && f.clase_oficial !== "ESMALTE");
  if (intrusas.length) {
    console.log(`\n  ⚠ ${intrusas.length} variantes que NO son un tono de esmalte y están como si lo fueran:`);
    for (const f of intrusas) {
      console.log(`     ${(f.sku ?? "—").padEnd(24)} ${f.variante.padEnd(28)} → ${f.clase_oficial} · ${f.linea_oficial}`);
      console.log(`       ${f.titulo_oficial}`);
    }
  }

  const sinFicha = filas.filter((f) => !f.encontrada);
  console.log(`\n  Sin ficha oficial encontrada: ${sinFicha.length}`);
  if (sinFicha.length && sinFicha.length <= 30) {
    console.log(`     ${sinFicha.map((f) => f.variante).join(", ")}`);
  }
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const salida = path.join(ROOT, "outputs", "reconciliacion-lineas.json");
writeFileSync(salida, JSON.stringify(informe, null, 2), "utf8");
console.log(`\n→ ${salida}`);
