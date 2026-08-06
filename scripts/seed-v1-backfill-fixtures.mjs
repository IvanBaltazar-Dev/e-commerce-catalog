// Carga fixtures V1 después de resetear la base local hasta 0004.
// No puede ejecutarse contra remoto sin la doble confirmación del cargador común.
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "seed-v1-backfill-fixtures"
});

if (!isLocal) {
  throw new Error("Los fixtures de backfill solo pueden cargarse en Supabase local.");
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const { data: brand, error: brandError } = await admin
  .from("brands")
  .insert({ name: "Backfill Fixture", slug: "backfill-fixture", sort_order: 990 })
  .select("id")
  .single();

if (brandError) throw brandError;

const { data: category, error: categoryError } = await admin
  .from("categories")
  .insert({ name: "Backfill V1", slug: "backfill-v1", sort_order: 990 })
  .select("id")
  .single();

if (categoryError) throw categoryError;

const fixtures = [
  {
    code: "BF-001",
    availability: "available",
    description: "Producto disponible sin imagen.",
    unit_price: 10,
    wholesale_price: 8,
    wholesale_min_quantity: 3
  },
  {
    code: "BF-002",
    availability: "sold_out",
    description: "Producto agotado con imagen principal.",
    main_image_path: "backfill/main.jpg",
    unit_price: 20,
    wholesale_price: 17,
    wholesale_min_quantity: 4
  },
  {
    code: "BF-003",
    availability: "consult",
    description: "Producto en consulta con carta de color.",
    color_chart_image_path: "backfill/chart.webp",
    color_chart_status: "available",
    unit_price: 30,
    wholesale_price: 26,
    wholesale_min_quantity: 5
  },
  {
    code: "BF-004",
    availability: "available",
    description: "Producto con PDF.",
    color_chart_pdf_path: "backfill/chart.pdf",
    unit_price: 40,
    wholesale_price: 34,
    wholesale_min_quantity: 6
  },
  {
    code: "BF-005",
    availability: "available",
    description: "Producto con imagen de galería.",
    unit_price: 50,
    wholesale_price: 42,
    wholesale_min_quantity: 7
  },
  {
    code: "BF-006",
    availability: "sold_out",
    description: "Segundo estado agotado.",
    unit_price: 60,
    wholesale_price: 51,
    wholesale_min_quantity: 8
  },
  {
    code: "BF-007",
    availability: "available",
    description: "Regla mayorista con mínimo alto.",
    unit_price: 70,
    wholesale_price: 55,
    wholesale_min_quantity: 12
  },
  {
    code: "BF-008",
    availability: "consult",
    description: null,
    unit_price: 0,
    wholesale_price: 0,
    wholesale_min_quantity: 1
  }
].map((fixture, index) => ({
  slug: fixture.code.toLowerCase(),
  brand_id: brand.id,
  category_id: category.id,
  name: `Fixture ${fixture.code}`,
  presentation: "Presentación V1",
  product_type: "Fixture V1",
  requires_lamp: false,
  lamp_type: "No",
  color_chart_status: "consult_advisor",
  is_active: true,
  sort_order: index + 1,
  ...fixture
}));

const { data: products, error: productsError } = await admin
  .from("products")
  .insert(fixtures)
  .select("id, code");

if (productsError) throw productsError;

const galleryProduct = products.find((product) => product.code === "BF-005");
const { error: imageError } = await admin.from("product_images").insert({
  product_id: galleryProduct.id,
  path: "backfill/gallery.jpg",
  alt_text: "Galería V1",
  sort_order: 1
});

if (imageError) throw imageError;

console.log(`Fixtures V1 cargados: ${products.length} productos.`);
