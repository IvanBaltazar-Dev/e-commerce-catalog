import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function materialCatalogProduct(product) {
  const stableProduct = { ...product };
  const variants = stableProduct.variants ?? [];
  delete stableProduct.updated_at;
  delete stableProduct.variants;
  return {
    ...stableProduct,
    variants: variants.map((variant) => {
      const stableVariant = { ...variant };
      delete stableVariant.updated_at;
      return stableVariant;
    }),
  };
}

function sameOriginUrl(value, root) {
  try {
    const url = new URL(value, root);
    return url.origin === root.origin ? url : null;
  } catch {
    return null;
  }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSurface(url, expectedType = null) {
  // Reintento con espera creciente. Sin esto, un solo 429 aborta la campaña
  // entera a mitad de captura y deja la fuente sin cerrar — que es exactamente
  // lo que pasaba al reejecutar Bigen: la tienda limita, el adaptador pedía con
  // concurrencia 8 y sin reintento, y el primer 429 tiraba todo.
  //
  // Un 429 y un 5xx son temporales por definición: se espera y se vuelve. Un 404
  // es una respuesta y se propaga tal cual, porque insistir no la cambia.
  const esperas = [1500, 5000, 12000];
  let response = null, body = null;
  for (let intento = 0; intento <= esperas.length; intento += 1) {
    response = await fetch(url, {
      headers: {
        accept: expectedType === "json" ? "application/json" : "text/plain,text/html,application/xml;q=0.9,*/*;q=0.5",
        "user-agent": "BellarosheCatalogResearch/1.0 (+local-read-only)",
      },
      redirect: "follow",
    });
    body = await response.text();
    if (response.ok) break;
    const temporal = response.status === 429 || response.status === 408 || response.status >= 500;
    if (!temporal || intento === esperas.length) break;
    await espera(esperas[intento]);
  }
  if (!response.ok) throw new Error(`Fuente oficial ${response.status} en ${url}`);
  if (expectedType === "json") {
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`La superficie ${url} no devolvió JSON válido.`);
    }
  }
  return {
    url: response.url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    sha256: sha256(body),
    bytes: Buffer.byteLength(body),
  };
}

function discoverSitemapUrl(robots, root) {
  for (const line of robots.split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
    const candidate = match ? sameOriginUrl(match[1], root) : null;
    if (candidate) return candidate;
  }
  return new URL("/sitemap.xml", root);
}

function discoverAgentsUrl(robots, root) {
  const match = robots.match(/(?:^|\s)(\/agents\.md)(?:\s|$)/im);
  return new URL(match?.[1] ?? "/agents.md", root);
}

function discoverJsonPath(agents, resource) {
  const candidates = [...agents.matchAll(/\bGET\s+\x60?(\/[^\s\x60]+)/gi)]
    .map((match) => match[1])
    .filter((value) => !/[{}]/.test(value))
    .map((value) => value.replace(/\?.*$/, ""))
    .filter((value) => value.toLowerCase().includes(resource.toLowerCase()))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return candidates[0] ?? null;
}

function sitemapLocations(xml, root) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map((match) => match[1].replace(/&amp;/g, "&"))
    .map((value) => sameOriginUrl(value, root))
    .filter(Boolean);
}

function sanitizeName(url, index) {
  const pathname = url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9._-]+/gi, "-") || "root";
  return `${String(index).padStart(2, "0")}-${pathname}${url.search ? "-query" : ""}`;
}

async function fetchProducts(root, discoveredPath) {
  const products = [];
  const surfaces = [];
  const limit = 250;
  const pathname = discoveredPath || "/products.json";
  for (let page = 1; ; page += 1) {
    const url = new URL(pathname, root);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));
    const surface = await fetchSurface(url, "json");
    const payload = JSON.parse(surface.body);
    if (!Array.isArray(payload.products)) throw new Error(`${url} no contiene products[].`);
    surfaces.push({ ...surface, name: `products-page-${page}.json` });
    products.push(...payload.products);
    if (payload.products.length < limit) break;
  }
  return { products, surfaces };
}

async function fetchCollections(root, discoveredPath) {
  const pathname = discoveredPath || "/collections.json";
  const url = new URL(pathname, root);
  url.searchParams.set("limit", "250");
  url.searchParams.set("page", "1");
  const surface = await fetchSurface(url, "json");
  const payload = JSON.parse(surface.body);
  return {
    collections: Array.isArray(payload.collections) ? payload.collections : [],
    surface: { ...surface, name: "collections-page-1.json" },
  };
}

async function mapConcurrent(values, worker, concurrency = 3) {
  let cursor = 0;
  const output = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
}

async function fetchCollectionMemberships(root, collections) {
  const captured = await mapConcurrent(collections, async (collection) => {
    const productIds = [];
    const surfaces = [];
    for (let page = 1; ; page += 1) {
      const url = new URL(`/collections/${encodeURIComponent(collection.handle)}/products.json`, root);
      url.searchParams.set("limit", "250");
      url.searchParams.set("page", String(page));
      const surface = await fetchSurface(url, "json");
      const payload = JSON.parse(surface.body);
      const products = Array.isArray(payload.products) ? payload.products : [];
      surfaces.push({
        ...surface,
        name: `collection-${collection.id}-products-page-${page}.json`,
      });
      productIds.push(...products.map((product) => String(product.id)));
      if (products.length < 250) break;
    }
    return {
      membership: {
        id: String(collection.id),
        title: String(collection.title),
        handle: String(collection.handle),
        productIds: [...new Set(productIds)].sort(),
      },
      surfaces,
    };
  });
  return {
    memberships: captured.map((item) => item.membership),
    surfaces: captured.flatMap((item) => item.surfaces),
  };
}

async function writeManagedCapture(storageRoot, sourceKey, capture) {
  const sourceSlug = sourceKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const relativeRoot = path.posix.join("local", "research-runs", sourceSlug, capture.rawFingerprint);
  const absoluteRoot = path.join(storageRoot, ...relativeRoot.split("/"));
  await fs.mkdir(absoluteRoot, { recursive: true });

  const files = [];
  for (const surface of capture.surfaces) {
    const filePath = path.join(absoluteRoot, surface.name);
    await fs.writeFile(filePath, surface.body, "utf8");
    files.push({
      path: surface.name,
      url: surface.url,
      httpStatus: surface.status,
      contentType: surface.contentType,
      bytes: surface.bytes,
      sha256: surface.sha256,
    });
  }

  const manifest = {
    schemaVersion: 1,
    storageContract: "catalog-research-managed-run-v1",
    sourceKey,
    sourceRoot: capture.sourceRoot,
    capturedAt: capture.capturedAt,
    contentFingerprint: capture.contentFingerprint,
    rawFingerprint: capture.rawFingerprint,
    counts: capture.counts,
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(absoluteRoot, "manifest.json"), manifestText, "utf8");
  return {
    absoluteRoot,
    relativeRoot,
    manifest,
    manifestSha256: sha256(manifestText),
    storageReference: `local-storage://${relativeRoot}/manifest.json`,
  };
}

export async function discoverShopifyOfficialCatalog({ sourceKey, sourceRoot, storageRoot }) {
  const root = new URL(sourceRoot);
  if (!/^https?:$/.test(root.protocol)) throw new Error("La fuente raíz debe usar HTTP(S). ");
  root.pathname = "/";
  root.search = "";
  root.hash = "";

  const capturedAt = new Date().toISOString();
  const home = { ...await fetchSurface(root), name: "homepage.html" };
  const robotsUrl = new URL("/robots.txt", root);
  const robots = { ...await fetchSurface(robotsUrl), name: "robots.txt" };
  const agentsUrl = discoverAgentsUrl(robots.body, root);
  const agents = { ...await fetchSurface(agentsUrl), name: "agents.md" };
  const sitemapUrl = discoverSitemapUrl(robots.body, root);
  const sitemap = { ...await fetchSurface(sitemapUrl), name: "sitemap.xml" };

  const childSitemaps = [];
  const locations = sitemapLocations(sitemap.body, root).filter((url) => /sitemap/i.test(url.pathname));
  for (const [index, url] of locations.entries()) {
    childSitemaps.push({
      ...await fetchSurface(url),
      name: `${sanitizeName(url, index + 1)}.xml`,
    });
  }

  const productPath = discoverJsonPath(agents.body, "products.json");
  const collectionPath = discoverJsonPath(agents.body, "collections.json");
  const productCapture = await fetchProducts(root, productPath);
  const collectionCapture = await fetchCollections(root, collectionPath);
  const collectionMembershipCapture = await fetchCollectionMemberships(root, collectionCapture.collections);
  const products = productCapture.products.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const stableCatalog = JSON.stringify(products.map(materialCatalogProduct));
  const contentFingerprint = sha256(stableCatalog);
  const imageCount = products.reduce((sum, product) => sum + (product.images?.length ?? 0), 0);
  const variantCount = products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0);
  const surfaces = [
    home,
    robots,
    agents,
    sitemap,
    ...childSitemaps,
    ...productCapture.surfaces,
    collectionCapture.surface,
    ...collectionMembershipCapture.surfaces,
  ];
  const rawFingerprint = sha256(surfaces.map((surface) => `${surface.url}\0${surface.sha256}`).join("\n"));

  const capture = {
    sourceRoot: root.origin,
    capturedAt,
    contentFingerprint,
    rawFingerprint,
    products,
    collections: collectionCapture.collections,
    collectionMemberships: collectionMembershipCapture.memberships,
    counts: {
      products: products.length,
      variants: variantCount,
      images: imageCount,
      collections: collectionCapture.collections.length,
      collectionMemberships: collectionMembershipCapture.memberships.reduce(
        (total, collection) => total + collection.productIds.length,
        0,
      ),
      discoverySurfaces: surfaces.length,
    },
    discovery: {
      robotsUrl: robots.url,
      agentsUrl: agents.url,
      sitemapUrl: sitemap.url,
      productApiPath: productPath || "/products.json",
      collectionApiPath: collectionPath || "/collections.json",
      childSitemaps: childSitemaps.map((item) => item.url),
    },
    surfaces,
  };
  capture.storage = await writeManagedCapture(storageRoot, sourceKey, capture);
  return capture;
}

export function normalizeOfficialText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseOfficialProduct(product) {
  const tags = Array.isArray(product.tags) ? product.tags.map(String) : [];
  const searchable = [product.title, product.product_type, ...tags].join(" ");
  const presentationMatch = searchable.match(/\b(\d+(?:[.,]\d+)?)\s*(ml|g|gr|kg|oz)\b/i);
  const presentation = presentationMatch
    ? `${presentationMatch[1].replace(",", ".")} ${presentationMatch[2].toLowerCase().replace(/^gr$/, "g")}`
    : null;
  const titleSegments = String(product.title ?? "").split(/\s+-\s+/);
  const shadeName = titleSegments.length > 1 ? titleSegments[0].trim() : null;
  const normalizedTags = tags.map(normalizeOfficialText);
  const line = tags.find((tag) => /\b(tradicional|semipermanente|decoraci[oó]n|tratamiento)\b/i.test(tag)) ?? null;
  const finish = tags.find((tag) => /\b(cremos|perlad|metaliz|trasl[uú]cid|escarch|jelly|mate)\w*/i.test(tag)) ?? null;
  const gamut = tags.find((tag) => /^gama\b/i.test(tag)) ?? null;
  return {
    presentation,
    shadeName,
    line,
    finish,
    gamut,
    tags,
    normalizedTags,
  };
}
