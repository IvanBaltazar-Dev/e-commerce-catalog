/**
 * Qué falta, por dimensión, y en qué clase de hueco cae.
 *
 * La regla que evita el bucle: un hueco que el sistema puede representar
 * correctamente COMO hueco no reabre nada. Que 2.060 variantes no tengan foto
 * propia no es un fallo — es que la fuente no publica foto por tono, y eso se
 * dice y se acaba. Solo se reabre por corrupción o pérdida real, como los precios
 * ×100 o las filas que la paginación perdía.
 *
 * Las cuatro clases, y la diferencia entre ellas es quién puede resolverlo:
 *
 *   NO_DECLARADO_POR_FUENTE    la fuente no lo publica. Ninguna cantidad de
 *                              peticiones lo va a crear.
 *   REQUIERE_CAPTURA_FISICA    está en el envase, no en internet. Código de
 *                              barras de las cinco marcas que no lo exponen,
 *                              ingredientes de un rotulado.
 *   REQUIERE_DECISION_HUMANA   el dato existe pero la decisión es del negocio:
 *                              precio de venta, si una referencia entra al
 *                              catálogo, si dos códigos parecidos son el mismo.
 *   ENRIQUECIMIENTO_OPCIONAL   se podría conseguir y no cambia nada crítico.
 *
 *   node --experimental-transform-types scripts/clasificar-huecos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FUENTES = ["masglo-es-official", "cherimoya-pe-official", "admiss-co-official",
  "bigen-usa-official", "acrylove-official", "mc-nails-mx-official"];
const { data: fuentes } = await db.from("catalog_sources").select("id, source_key, metadata").in("source_key", FUENTES);
const ids = fuentes.map((f) => f.id);
const clave = Object.fromEntries(fuentes.map((f) => [f.id, f.source_key]));

const productos = await leerTodo({
  consulta: () => db.from("catalog_reference_products")
    .select("id, primary_source_id, primary_external_id, name, product_type, presentation, primary_image_url, primary_source_record_id")
    .in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "productos",
});
const variantes = await leerTodo({
  consulta: () => db.from("catalog_reference_variants_vigentes_v1")
    .select("id, reference_product_id, primary_source_id, sku, barcode, shade_name, presentation, primary_image_url, metadata")
    .in("primary_source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "variantes",
});
const registros = await leerTodo({
  consulta: () => db.from("catalog_source_records").select("id, source_id, entity_type, payload").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "registros",
});
const precios = await leerTodo({
  consulta: () => db.from("catalog_reference_prices_vigentes_v1").select("id, source_id, reference_product_id, reference_variant_id").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "precios",
});
const medios = await leerTodo({
  consulta: () => db.from("catalog_reference_media").select("id, reference_product_id, reference_variant_id").in("source_id", ids),
  orden: ["id"], clave: (r) => r.id, nombre: "medios",
});

const payloadPorRegistro = new Map(registros.map((r) => [r.id, r.payload]));
const conPrecioProducto = new Set(precios.map((p) => p.reference_product_id).filter(Boolean));
const conPrecioVariante = new Set(precios.map((p) => p.reference_variant_id).filter(Boolean));
const conImagenProducto = new Set(medios.map((m) => m.reference_product_id).filter(Boolean));
const conImagenVariante = new Set(medios.map((m) => m.reference_variant_id).filter(Boolean));

/** Un texto que no dice nada no es una descripción. */
const tieneTexto = (p) => {
  const t = [p?.description, p?.short_description, p?.descriptionSha256 ? "hay" : null].filter(Boolean).join(" ");
  return t.replace(/<[^>]*>/g, "").trim().length > 20;
};

const huecos = [];
const anota = (dimension, sujeto, n, clase, motivo) => huecos.push({ dimension, sujeto, n, clase, motivo });

// ── 1 · Identidad ───────────────────────────────────────────────────────────
const sinSku = variantes.filter((v) => !v.sku);
const sinGtin = variantes.filter((v) => !v.barcode);
const sinGtinPorFuente = {};
for (const v of sinGtin) sinGtinPorFuente[clave[v.primary_source_id]] = (sinGtinPorFuente[clave[v.primary_source_id]] ?? 0) + 1;

if (sinSku.length) anota("identidad · SKU", "variante", sinSku.length, "NO_DECLARADO_POR_FUENTE",
  "la fuente no publica código para esa variante; el producto padre sí lo tiene");
anota("identidad · GTIN", "variante", sinGtin.length, "REQUIERE_CAPTURA_FISICA",
  "solo Masglo expone código de barras por API. Cherimoya y Bigen devuelven null, Admiss bloquea la ficha individual, "
  + "y en Acrylove y MC Nails el campo viene vacío. Está impreso en el envase, no en internet");

// ── 2 · Variante y eje ──────────────────────────────────────────────────────
const sinEje = variantes.filter((v) => !(v.metadata?.ejes ?? v.metadata?.optionAxes ?? []).length);
anota("variante · eje", "variante", sinEje.length, "NO_DECLARADO_POR_FUENTE",
  "en cuatro de las seis tiendas cada tono es un producto suelto, así que no hay eje de variación que declarar. "
  + "No es un dato que falte: es que ahí no existe");

// ── 3 · Presentación ────────────────────────────────────────────────────────
const sinPresentacionProd = productos.filter((p) => !p.presentation);
anota("presentación", "producto", sinPresentacionProd.length, "NO_DECLARADO_POR_FUENTE",
  "no viene como campo. Cuando aparece en el título se extrae por regla, y el resto no está publicado en ningún sitio");

// ── 4 · Descripción ─────────────────────────────────────────────────────────
const sinDescripcion = productos.filter((p) => !tieneTexto(payloadPorRegistro.get(p.primary_source_record_id)));
anota("descripción", "producto", sinDescripcion.length, "NO_DECLARADO_POR_FUENTE",
  "la ficha no trae texto útil. Y donde sí lo trae, es texto comercial: extraer de ahí ingredientes o compatibilidad "
  + "sería inferencia, y queda NOT_STATED hasta que haya ficha técnica");

// ── 5 · Atributos comerciales ───────────────────────────────────────────────
const conAtributos = new Set();
for (const r of registros.filter((x) => x.entity_type === "product")) {
  if ((r.payload?.attributes ?? []).length) conAtributos.add(r.id);
}
const sinAtributos = productos.filter((p) => !conAtributos.has(p.primary_source_record_id));
anota("atributos comerciales", "producto", sinAtributos.length, "NO_DECLARADO_POR_FUENTE",
  "solo WooCommerce publica atributos estructurados. Shopify los expone como ejes de variación, y donde no hay "
  + "variación no hay atributo que leer");

// ── 6 · Precio externo ──────────────────────────────────────────────────────
const sinPrecio = productos.filter((p) => !conPrecioProducto.has(p.id));
anota("precio externo", "producto", sinPrecio.length, "ENRIQUECIMIENTO_OPCIONAL",
  "precio de mercado ajeno. No puede tocar el precio de Bellaroshé, así que su ausencia no bloquea nada");

// ── 7 · Imágenes ────────────────────────────────────────────────────────────
const sinImagenProducto = productos.filter((p) => !conImagenProducto.has(p.id));
const sinImagenVariante = variantes.filter((v) => !conImagenVariante.has(v.id));
if (sinImagenProducto.length) anota("imagen · producto", "producto", sinImagenProducto.length, "NO_DECLARADO_POR_FUENTE",
  "la ficha no publica ninguna imagen");
anota("imagen · variante", "variante", sinImagenVariante.length, "NO_DECLARADO_POR_FUENTE",
  "imagen de variante no demostrada: la fuente sirve la misma foto del producto para todos los tonos. "
  + "Registrarla como imagen de la variante haría creer que hay swatch por tono donde no lo hay");

// ── 8 · Lo que es decisión, no dato ─────────────────────────────────────────
const { count: refNuevas } = { count: null };
const consolidado = JSON.parse(fs.readFileSync(path.join(ROOT, "outputs", "consolidacion-global.json"), "utf8"));
anota("catálogo Bellaroshé", "referencia externa", consolidado.veredictos?.REFERENCIA_NUEVA ?? 0, "REQUIERE_DECISION_HUMANA",
  "referencias que no están en nuestro catálogo. Que existan no significa que debamos venderlas");

// ── Impresión ───────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(92)}`);
console.log(`HUECOS CLASIFICADOS`);
console.log(`universo: ${productos.length} productos · ${variantes.length} variantes vigentes`);
console.log(`${"═".repeat(92)}\n`);

const porClase = {};
for (const h of huecos) (porClase[h.clase] ??= []).push(h);
const ORDEN = ["NO_DECLARADO_POR_FUENTE", "REQUIERE_CAPTURA_FISICA", "REQUIERE_DECISION_HUMANA", "ENRIQUECIMIENTO_OPCIONAL"];
for (const clase of ORDEN) {
  const lista = porClase[clase] ?? [];
  if (!lista.length) continue;
  console.log(`── ${clase}`);
  for (const h of lista) {
    console.log(`   ${String(h.n).padStart(6)}  ${h.dimension.padEnd(24)} (${h.sujeto})`);
    console.log(`           ${h.motivo}`);
  }
  console.log();
}

console.log(`GTIN que falta, por fuente:`);
for (const [k, n] of Object.entries(sinGtinPorFuente).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(5)}  ${k}`);
}

fs.writeFileSync(path.join(ROOT, "outputs", "huecos-clasificados.json"),
  JSON.stringify({ universo: { productos: productos.length, variantes: variantes.length }, huecos, sinGtinPorFuente }, null, 2), "utf8");
console.log(`\n→ outputs/huecos-clasificados.json`);
