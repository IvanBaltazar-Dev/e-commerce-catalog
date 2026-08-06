import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-v2-scale" });
if (!isLocal) throw new Error("La prueba de escala solo puede ejecutarse contra Supabase local.");

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const prefix = `SCALE-${stamp.toUpperCase()}-`;
const slugPrefix = `scale-${stamp}-`;
const count = 1505;

function assert(condition, message) {
  if (!condition) throw new Error(`Prueba de escala V2: ${message}`);
}

async function chunks(items, size, operation) {
  for (let index = 0; index < items.length; index += size) await operation(items.slice(index, index + size));
}

async function cleanupScale(pattern) {
  while (true) {
    const existing = await client.from("products").select("id").like("code", pattern).limit(200);
    if (existing.error) throw existing.error;
    if (!existing.data.length) return;
    const removed = await client.from("products").delete().in("id", existing.data.map((row) => row.id));
    if (removed.error) throw removed.error;
  }
}

await cleanupScale("SCALE-%");

try {
  const [brandResult, categoryResult, templateResult, retailListResult] = await Promise.all([
    client.from("brands").select("id").eq("slug", "demo-professional").single(),
    client.from("categories").select("id").eq("slug", "accesorios").is("parent_id", null).single(),
    client.from("attribute_templates").select("id").eq("code", "LEGACY_V1").single(),
    client.from("price_lists").select("id").eq("code", "retail-pen").single()
  ]);
  for (const result of [brandResult, categoryResult, templateResult, retailListResult]) if (result.error) throw result.error;

  const products = Array.from({ length: count }, (_, index) => ({
    code: `${prefix}${String(index).padStart(4, "0")}`,
    slug: `${slugPrefix}${String(index).padStart(4, "0")}`,
    brand_id: brandResult.data.id,
    category_id: categoryResult.data.id,
    template_id: templateResult.data.id,
    name: `Producto escala ${String(index).padStart(4, "0")}`,
    presentation: "Presentación única",
    product_type: "Prueba de escala",
    description: "Fila temporal local para validar paginación superior a 1,500 artículos.",
    unit_price: 10,
    wholesale_price: 10,
    wholesale_min_quantity: 1,
    availability: "available",
    editorial_status: "draft",
    is_active: false,
    sort_order: 5000 + index
  }));

  const created = [];
  await chunks(products, 200, async (rows) => {
    const result = await client.from("products").insert(rows).select("id, code");
    if (result.error) throw result.error;
    created.push(...result.data);
  });
  assert(created.length === count, "no se insertaron todos los productos temporales");

  const variants = created.map((product, index) => ({
    product_id: product.id,
    sku: `${product.code}-SKU`,
    name: "Presentación única",
    variant_key: "presentation=default",
    availability_status: "available",
    is_default: true,
    is_active: true,
    sort_order: index
  }));
  const createdVariants = [];
  await chunks(variants, 200, async (rows) => {
    const result = await client.from("product_variants").insert(rows).select("id");
    if (result.error) throw result.error;
    createdVariants.push(...result.data);
  });

  await chunks(createdVariants.map((variant) => ({ variant_id: variant.id, price_list_id: retailListResult.data.id, amount: 10, minimum_quantity: 1 })), 200, async (rows) => {
    const result = await client.from("variant_prices").insert(rows);
    if (result.error) throw result.error;
  });

  const publishedAt = new Date().toISOString();
  await chunks(created.map((product) => product.id), 100, async (ids) => {
    const published = await client.from("products").update({ is_active: true, editorial_status: "published", published_at: publishedAt }).in("id", ids);
    if (published.error) throw published.error;
  });

  const started = performance.now();
  const result = await client.rpc("catalog_list_v2", { p_page: 16, p_page_size: 100, p_search: "Producto escala", p_sort: "name_asc" });
  const elapsed = Math.round(performance.now() - started);
  if (result.error) throw result.error;
  assert(result.data.totalItems === count, `el total fue ${result.data.totalItems}, se esperaban ${count}`);
  assert(result.data.totalPages === 16, "la paginación debe superar 15 páginas sin truncarse");
  assert(result.data.items.length === 5, "la última página debe contener los cinco artículos restantes");
  console.log(`Escala V2 verificada: ${count} productos, 16 páginas, consulta final ${elapsed} ms.`);
} finally {
  await cleanupScale(`${prefix}%`);
}
