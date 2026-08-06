// Verifica el resultado de aplicar 0005 sobre los fixtures V1 controlados.
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "verify-v1-backfill"
});

if (!isLocal) {
  throw new Error("La verificación de backfill solo puede ejecutarse en Supabase local.");
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function assert(condition, message) {
  if (!condition) throw new Error(`Backfill inválido: ${message}`);
}

const { data: products, error: productError } = await admin
  .from("products")
  .select("id, code, unit_price, wholesale_price, wholesale_min_quantity, availability, editorial_status")
  .like("code", "BF-%")
  .order("code");

if (productError) throw productError;
assert(products.length === 8, `se esperaban 8 productos y llegaron ${products.length}`);

const productIds = products.map((product) => product.id);
const { data: variants, error: variantError } = await admin
  .from("product_variants")
  .select("id, product_id, sku, availability_status, is_default, is_active")
  .in("product_id", productIds);

if (variantError) throw variantError;
assert(variants.length === 8, "cada producto V1 debe producir exactamente una variante");

for (const product of products) {
  const variant = variants.find((candidate) => candidate.product_id === product.id);
  assert(Boolean(variant), `${product.code} no tiene variante`);
  assert(variant.is_default && variant.is_active, `${product.code} no tiene default activa`);
  assert(variant.sku === product.code, `${product.code} no conservó el SKU`);
  assert(
    variant.availability_status === product.availability,
    `${product.code} perdió availability=${product.availability}`
  );
}

const variantIds = variants.map((variant) => variant.id);
const { data: prices, error: priceError } = await admin
  .from("variant_prices")
  .select("variant_id, amount, minimum_quantity, price_list:price_lists(code)")
  .in("variant_id", variantIds);

if (priceError) throw priceError;
assert(prices.length === 16, "deben existir precios retail y wholesale por cada variante");

const wholesaleFixture = products.find((product) => product.code === "BF-007");
const wholesaleVariant = variants.find((variant) => variant.product_id === wholesaleFixture.id);
const wholesalePrice = prices.find(
  (price) => price.variant_id === wholesaleVariant.id && price.price_list?.code === "wholesale-pen"
);
assert(Number(wholesalePrice?.amount) === 55, "BF-007 perdió el importe mayorista");
assert(wholesalePrice?.minimum_quantity === 12, "BF-007 perdió el mínimo mayorista");

const { data: media, error: mediaError } = await admin
  .from("product_media")
  .select("product_id, media_role, media:media_assets(storage_path)")
  .in("product_id", productIds);

if (mediaError) throw mediaError;
const expectedMedia = new Map([
  ["BF-002", ["main", "backfill/main.jpg"]],
  ["BF-003", ["color_chart", "backfill/chart.webp"]],
  ["BF-004", ["catalog_pdf", "backfill/chart.pdf"]],
  ["BF-005", ["gallery", "backfill/gallery.jpg"]]
]);

for (const [code, [role, storagePath]] of expectedMedia) {
  const product = products.find((candidate) => candidate.code === code);
  assert(
    media.some(
      (entry) =>
        entry.product_id === product.id &&
        entry.media_role === role &&
        entry.media?.storage_path === storagePath
    ),
    `${code} no migró ${role}`
  );
}

assert(
  products.find((product) => product.code === "BF-008")?.editorial_status === "incomplete",
  "el fixture incompleto no quedó marcado como incomplete"
);

console.log("Backfill V1 → V2 verificado: productos, variantes, estados, precios, medios y columnas V1.");
