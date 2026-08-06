// Prueba de integración de contratos públicos V2 usando exclusivamente la llave anon local.
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "test-v2-contracts"
});

if (!isLocal) {
  throw new Error("Los contratos V2 solo se prueban automáticamente contra Supabase local.");
}

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

function assert(condition, message) {
  if (!condition) throw new Error(`Contrato V2 inválido: ${message}`);
}

async function rpc(name, parameters) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw error;
  return data;
}

const list = await rpc("catalog_list_v2", {
  p_page: 1,
  p_page_size: 2,
  p_sort: "name_asc"
});

assert(Array.isArray(list.items) && list.items.length === 2, "el listado no respeta page_size=2");
assert(list.totalItems === 5, `se esperaban 5 productos públicos y llegaron ${list.totalItems}`);
assert(list.totalPages === 3, "el total de páginas debe derivarse en servidor");
assert(Array.isArray(list.availableFilters), "faltan filtros disponibles");
assert(!("variants" in list.items[0]), "la tarjeta no debe incluir todas las variantes");

const clamped = await rpc("catalog_list_v2", {
  p_page: -5,
  p_page_size: 500,
  p_sort: "featured"
});
assert(clamped.page === 1 && clamped.pageSize === 100, "los limites deben normalizarse en base de datos");

const empty = await rpc("catalog_list_v2", {
  p_page: 1,
  p_page_size: 24,
  p_search: "producto-que-no-existe-xyz"
});
assert(empty.totalItems === 0 && empty.items.length === 0, "la respuesta vacia debe conservar el contrato paginado");

const invalidSort = await client.rpc("catalog_list_v2", { p_sort: "drop_table" });
assert(invalidSort.error?.code === "22023", "un orden invalido debe producir un error controlado");

const filtered = await rpc("catalog_list_v2", {
  p_page: 1,
  p_page_size: 24,
  p_attribute_filters: { shape: ["coffin"] }
});

assert(filtered.totalItems === 1, "el filtro de atributo shape=coffin debe devolver una ficha");
assert(filtered.items[0].slug === "demo-extensiones-profesionales", "el filtro devolvió otro producto");

const detail = await rpc("catalog_product_detail_v2", {
  p_slug: "demo-masglo-gel-evolution"
});

assert(detail.productId, "el detalle no devolvió productId");
assert(detail.variants.length === 3, "el detalle de esmalte debe devolver tres tonos");
assert(detail.variants.every((variant) => variant.sku), "cada variante pública debe incluir SKU");

const red = detail.variants.find((variant) => variant.sku === "DEMO-ESM-ROJO");
const missingDetail = await rpc("catalog_product_detail_v2", { p_slug: "producto-inexistente" });
assert(missingDetail === null, "un detalle inexistente debe devolver null sin sobreexponer datos");

const nude = detail.variants.find((variant) => variant.sku === "DEMO-ESM-NUDE");
const cart = await rpc("evaluate_cart_v2", {
  p_lines: [
    { variantId: red.id, quantity: 6 },
    { variantId: nude.id, quantity: 6 }
  ]
});

assert(cart.totalUnits === 12, "el carrito no sumó las variantes del producto");
assert(cart.lines.every((line) => line.purchaseMode === "wholesale"), "no aplicó mezcla mayorista");
assert(cart.lines.every((line) => Number(line.unitPrice) === 12), "no aplicó el precio mayorista");

const machine = await rpc("catalog_product_detail_v2", {
  p_slug: "demo-torno-profesional"
});
const consultCart = await rpc("evaluate_cart_v2", {
  p_lines: [{ variantId: machine.variants[0].id, quantity: 1 }]
});

assert(consultCart.lines[0].purchaseMode === "consult", "consult debe conservar su modalidad");
assert(consultCart.lines[0].unitPrice === null, "una línea consult no debe fijar precio definitivo");

console.log("Contratos V2 verificados: listado, paginación, filtros, detalle, mayorista y consult.");
