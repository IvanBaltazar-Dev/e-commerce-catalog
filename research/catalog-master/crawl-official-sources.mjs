import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogResearchStorageRoot } from "../../scripts/lib/catalog-research-paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORAGE_ROOT = catalogResearchStorageRoot(REPO_ROOT);
const RAW_ROOT = path.join(STORAGE_ROOT, "sources");
const DATA_ROOT = path.join(STORAGE_ROOT, "data");
const capturedAt = new Date().toISOString();

const sources = [
  { brand: "Masglo", slug: "masglo", type: "shopify", baseUrl: "https://masglo.com.es" },
  { brand: "Admiss", slug: "admiss", type: "shopify", baseUrl: "https://admiss.com.co" },
  { brand: "AcryLove", slug: "acrylove", type: "shopify", baseUrl: "https://acrylove.com" },
  { brand: "MC Nails", slug: "mc-nails", type: "shopify", baseUrl: "https://mcnails.mx" },
  { brand: "Cherimoya", slug: "cherimoya", type: "woocommerce", baseUrl: "https://cherimoya.pe" },
  { brand: "Bigen", slug: "bigen", type: "shopify", baseUrl: "https://www.bigen-usa.com" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "BellarosheCatalogResearch/1.0",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return { data: await response.json(), headers: response.headers };
}

async function crawlShopify(source) {
  const products = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = `${source.baseUrl}/products.json?limit=250&page=${page}`;
    const { data } = await fetchJson(url);
    const batch = Array.isArray(data.products) ? data.products : [];
    products.push(...batch);
    if (batch.length < 250) break;
    await sleep(150);
  }
  return products;
}

async function crawlWooCommerce(source) {
  const products = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const url = `${source.baseUrl}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const { data, headers } = await fetchJson(url);
    if (!Array.isArray(data)) throw new Error(`Unexpected WooCommerce payload: ${url}`);
    products.push(...data);
    totalPages = Number(headers.get("x-wp-totalpages") || totalPages);
    await sleep(150);
  }
  return products;
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeShopify(source, products) {
  const normalizedProducts = [];
  const normalizedVariants = [];
  const normalizedImages = [];

  for (const product of products) {
    const productUrl = `${source.baseUrl}/products/${product.handle}`;
    const imageUrls = (product.images || []).map((image) => image.src).filter(Boolean);
    normalizedProducts.push({
      brand: source.brand,
      source_type: "official_shopify",
      source_root_url: source.baseUrl,
      source_product_url: productUrl,
      captured_at: capturedAt,
      confidence: "CONFIRMADO_OFICIAL",
      external_product_id: product.id,
      handle: product.handle,
      title: product.title,
      description: stripHtml(product.body_html),
      vendor: product.vendor || "",
      product_type: product.product_type || "",
      tags: Array.isArray(product.tags) ? product.tags.join(" | ") : product.tags || "",
      published_at: product.published_at || "",
      updated_at: product.updated_at || "",
      variant_count: (product.variants || []).length,
      image_count: imageUrls.length,
      primary_image_url: imageUrls[0] || "",
    });

    for (const variant of product.variants || []) {
      normalizedVariants.push({
        brand: source.brand,
        source_type: "official_shopify",
        source_product_url: productUrl,
        captured_at: capturedAt,
        confidence: "CONFIRMADO_OFICIAL",
        external_product_id: product.id,
        external_variant_id: variant.id,
        product_title: product.title,
        variant_title: variant.title || "",
        sku: variant.sku || "",
        barcode: variant.barcode || "",
        price: variant.price ?? "",
        compare_at_price: variant.compare_at_price ?? "",
        available: variant.available ?? "",
        option1: variant.option1 || "",
        option2: variant.option2 || "",
        option3: variant.option3 || "",
      });
    }

    (product.images || []).forEach((image, index) => {
      normalizedImages.push({
        brand: source.brand,
        source_type: "official_shopify",
        source_product_url: productUrl,
        captured_at: capturedAt,
        confidence: "CONFIRMADO_OFICIAL",
        external_product_id: product.id,
        external_image_id: image.id || "",
        image_position: image.position ?? index + 1,
        role: index === 0 ? "main" : "gallery",
        image_url: image.src || "",
        width: image.width || "",
        height: image.height || "",
        variant_ids: Array.isArray(image.variant_ids) ? image.variant_ids.join(" | ") : "",
      });
    });
  }
  return { products: normalizedProducts, variants: normalizedVariants, images: normalizedImages };
}

function normalizeWooCommerce(source, products) {
  const normalizedProducts = [];
  const normalizedVariants = [];
  const normalizedImages = [];

  for (const product of products) {
    const productUrl = product.permalink || `${source.baseUrl}/?p=${product.id}`;
    const prices = product.prices || {};
    const categories = (product.categories || []).map((item) => item.name).filter(Boolean);
    const tags = (product.tags || []).map((item) => item.name).filter(Boolean);
    const images = product.images || [];
    normalizedProducts.push({
      brand: source.brand,
      source_type: "official_woocommerce",
      source_root_url: source.baseUrl,
      source_product_url: productUrl,
      captured_at: capturedAt,
      confidence: "CONFIRMADO_OFICIAL",
      external_product_id: product.id,
      handle: product.slug || "",
      title: product.name || "",
      description: stripHtml(product.description || product.short_description),
      vendor: source.brand,
      product_type: categories.join(" | "),
      tags: tags.join(" | "),
      published_at: "",
      updated_at: "",
      variant_count: 1,
      image_count: images.length,
      primary_image_url: images[0]?.src || "",
    });

    normalizedVariants.push({
      brand: source.brand,
      source_type: "official_woocommerce",
      source_product_url: productUrl,
      captured_at: capturedAt,
      confidence: "CONFIRMADO_OFICIAL",
      external_product_id: product.id,
      external_variant_id: product.id,
      product_title: product.name || "",
      variant_title: "Default",
      sku: product.sku || "",
      barcode: "",
      price: prices.price || "",
      compare_at_price: prices.regular_price || "",
      available: product.is_in_stock ?? "",
      option1: "",
      option2: "",
      option3: "",
    });

    images.forEach((image, index) => {
      normalizedImages.push({
        brand: source.brand,
        source_type: "official_woocommerce",
        source_product_url: productUrl,
        captured_at: capturedAt,
        confidence: "CONFIRMADO_OFICIAL",
        external_product_id: product.id,
        external_image_id: image.id || "",
        image_position: index + 1,
        role: index === 0 ? "main" : "gallery",
        image_url: image.src || "",
        width: "",
        height: "",
        variant_ids: "",
      });
    });
  }
  return { products: normalizedProducts, variants: normalizedVariants, images: normalizedImages };
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")).join("\n")}\n`;
}

await mkdir(RAW_ROOT, { recursive: true });
await mkdir(DATA_ROOT, { recursive: true });

const allProducts = [];
const allVariants = [];
const allImages = [];
const summary = [];

for (const source of sources) {
  const raw = source.type === "shopify" ? await crawlShopify(source) : await crawlWooCommerce(source);
  const normalized = source.type === "shopify"
    ? normalizeShopify(source, raw)
    : normalizeWooCommerce(source, raw);

  const sourceDir = path.join(RAW_ROOT, source.slug);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, `products-${capturedAt.slice(0, 10)}.json`),
    JSON.stringify({ source, captured_at: capturedAt, products: raw }, null, 2),
  );

  allProducts.push(...normalized.products);
  allVariants.push(...normalized.variants);
  allImages.push(...normalized.images);
  summary.push({
    brand: source.brand,
    source_type: source.type,
    source_root_url: source.baseUrl,
    captured_at: capturedAt,
    products: normalized.products.length,
    variants: normalized.variants.length,
    images: normalized.images.length,
  });
  process.stdout.write(`${source.brand}: ${normalized.products.length} products, ${normalized.variants.length} variants, ${normalized.images.length} images\n`);
}

await writeFile(path.join(DATA_ROOT, "external_official_products.csv"), toCsv(allProducts));
await writeFile(path.join(DATA_ROOT, "external_official_variants.csv"), toCsv(allVariants));
await writeFile(path.join(DATA_ROOT, "external_official_images.csv"), toCsv(allImages));
await writeFile(path.join(DATA_ROOT, "external_official_sources_summary.csv"), toCsv(summary));
await writeFile(
  path.join(DATA_ROOT, "external_official_metrics.json"),
  JSON.stringify({
    captured_at: capturedAt,
    source_count: sources.length,
    product_count: allProducts.length,
    variant_count: allVariants.length,
    image_count: allImages.length,
    sources: summary,
  }, null, 2),
);
