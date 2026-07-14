// Siembra los 11 productos + sube imágenes optimizadas al Storage (catalog-assets).
// Idempotente (upsert por code/slug). Requiere SUPABASE_SERVICE_ROLE_KEY (secret) y GRANTs aplicados.
// Uso: node scripts/seed-products.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS, STORE, lampLabel } from "./catalog-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "catalog-preview", "assets", "products");
const BUCKET = "catalog-assets";

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const slugify = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const lampToType = { no: "No", si: "Sí", uvled: "UV/LED" };

async function upsertTaxonomy() {
  const brandNames = [...new Set(PRODUCTS.map((p) => p.brand))];
  const brandRows = brandNames.map((name, i) => ({ name, slug: slugify(name), sort_order: (i + 1) * 10 }));
  const { data: brands, error: bErr } = await admin
    .from("brands")
    .upsert(brandRows, { onConflict: "slug" })
    .select("id, slug");
  if (bErr) throw new Error(`brands: ${bErr.message}`);

  const catRows = [{ name: "Esmaltes en gel", slug: "esmaltes-en-gel", sort_order: 10 }];
  const { data: cats, error: cErr } = await admin
    .from("categories")
    .upsert(catRows, { onConflict: "slug" })
    .select("id, slug");
  if (cErr) throw new Error(`categories: ${cErr.message}`);

  await admin
    .from("store_settings")
    .upsert(
      {
        id: true,
        business_name: STORE.brand,
        whatsapp_number: STORE.whatsapp.replace(/\s/g, ""),
        stock_notice: STORE.notice,
      },
      { onConflict: "id" }
    );

  const brandId = Object.fromEntries(brands.map((b) => [b.slug, b.id]));
  return { brandId, categoryId: cats[0].id };
}

async function uploadImg(localPath, destPath) {
  const buf = readFileSync(localPath);
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(destPath, buf, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`upload ${destPath}: ${error.message}`);
  return destPath;
}

async function seedProduct(p, ctx) {
  const dir = path.join(ASSETS, p.folder);
  const base = `products/${p.slug}`;

  // Imágenes: foto-1 = principal, foto-2..N = galería, carta.jpg = tonos.
  const mainLocal = path.join(dir, "foto-1.jpg");
  const mainPath = existsSync(mainLocal) ? await uploadImg(mainLocal, `${base}/main.jpg`) : null;

  const gallery = [];
  for (let i = 2; i <= 4; i += 1) {
    const f = path.join(dir, `foto-${i}.jpg`);
    if (existsSync(f)) gallery.push(await uploadImg(f, `${base}/gallery-${i - 1}.jpg`));
  }

  let cartaPath = null;
  const cartaLocal = path.join(dir, "carta.jpg");
  if (p.chart === "available" && existsSync(cartaLocal)) {
    cartaPath = await uploadImg(cartaLocal, `${base}/carta.jpg`);
  }

  const row = {
    code: `BR-${String(p.order).padStart(2, "0")}`,
    slug: p.slug,
    brand_id: ctx.brandId[slugify(p.brand)],
    category_id: ctx.categoryId,
    name: p.line,
    presentation: p.presentation,
    product_type: p.type,
    requires_lamp: p.lamp !== "no",
    lamp_type: lampToType[p.lamp],
    description: p.description,
    unit_price: p.unit,
    wholesale_price: p.wholesale,
    wholesale_min_quantity: STORE.wholesaleFrom,
    availability: "available",
    color_chart_status: p.chart === "available" && cartaPath ? "available" : "consult_advisor",
    main_image_path: mainPath,
    color_chart_image_path: cartaPath,
    is_active: true,
    sort_order: p.order,
  };

  const { data: prod, error: pErr } = await admin
    .from("products")
    .upsert(row, { onConflict: "code" })
    .select("id")
    .single();
  if (pErr) throw new Error(`product ${p.slug}: ${pErr.message}`);

  await admin.from("product_images").delete().eq("product_id", prod.id);
  if (gallery.length) {
    const imgs = gallery.map((path, i) => ({ product_id: prod.id, path, sort_order: i + 1 }));
    const { error: iErr } = await admin.from("product_images").insert(imgs);
    if (iErr) throw new Error(`images ${p.slug}: ${iErr.message}`);
  }

  console.log(`  ✓ ${p.brand} ${p.line} — ${gallery.length + 1} fotos${cartaPath ? " + carta" : " · sin carta"} · ${lampLabel(p.lamp)}`);
}

console.log("== Sembrando taxonomía ==");
const ctx = await upsertTaxonomy();
console.log("== Sembrando 11 productos + imágenes ==");
for (const p of PRODUCTS) await seedProduct(p, ctx);
console.log("\n✅ Seed completo.");
