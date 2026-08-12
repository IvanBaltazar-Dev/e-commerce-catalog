import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { catalogResearchPath } from "../../scripts/lib/catalog-research-paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INPUT = catalogResearchPath(REPO_ROOT, "data", "internal_official_tone_reconciliation.csv");
const outputRoot = path.resolve(
  process.argv[2] || catalogResearchPath(REPO_ROOT, "local", "outputs", "verified-tone-images"),
);

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers, ...body] = rows;
  return body.filter((cells) => cells.some(Boolean)).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])));
}

function csvValue(value) {
  const string = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")).join("\n")}\n`;
}

function slug(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "item";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function differenceHash(buffer) {
  const { data } = await sharp(buffer).resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      bits += data[row * 9 + col] > data[row * 9 + col + 1] ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

async function download(row) {
  const brandDir = path.join(outputRoot, slug(row.internal_brand));
  await fs.mkdir(brandDir, { recursive: true });
  const fileName = `${slug(row.internal_shade_code || row.internal_shade_name)}-${row.internal_shade_id.slice(0, 8)}.webp`;
  const localPath = path.join(brandDir, fileName);
  try {
    const response = await fetch(row.official_image_url, {
      headers: { "User-Agent": "BellarosheCatalogImagePipeline/1.0" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const mimeType = (response.headers.get("content-type") || "").split(";")[0];
    if (!mimeType.startsWith("image/")) throw new Error(`Unexpected content type: ${mimeType}`);
    const original = Buffer.from(await response.arrayBuffer());
    const originalMetadata = await sharp(original).metadata();
    const normalized = await sharp(original)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 })
      .toBuffer();
    const normalizedMetadata = await sharp(normalized).metadata();
    await fs.writeFile(localPath, normalized);
    return {
      internal_brand: row.internal_brand,
      internal_shade_id: row.internal_shade_id,
      internal_variant_id: row.internal_variant_id,
      internal_sku: row.internal_sku,
      internal_shade_code: row.internal_shade_code,
      internal_shade_name: row.internal_shade_name,
      official_tone: row.official_tone,
      official_product_url: row.official_product_url,
      original_image_url: row.official_image_url,
      captured_at: new Date().toISOString(),
      match_method: "EXACT_NORMALIZED_TONE_OR_OFFICIAL_CODE",
      confidence: "CONFIRMADO_OFICIAL",
      review_status: "DESCARGADA_PENDIENTE_APROBACION_HUMANA",
      publish_allowed: "NO",
      original_mime_type: mimeType,
      original_bytes: original.length,
      original_width: originalMetadata.width || "",
      original_height: originalMetadata.height || "",
      original_sha256: sha256(original),
      normalized_mime_type: "image/webp",
      normalized_bytes: normalized.length,
      normalized_width: normalizedMetadata.width || "",
      normalized_height: normalizedMetadata.height || "",
      normalized_sha256: sha256(normalized),
      perceptual_dhash_64: await differenceHash(normalized),
      controlled_local_path: localPath,
      error: "",
    };
  } catch (error) {
    return {
      internal_brand: row.internal_brand,
      internal_shade_id: row.internal_shade_id,
      internal_variant_id: row.internal_variant_id,
      internal_sku: row.internal_sku,
      internal_shade_code: row.internal_shade_code,
      internal_shade_name: row.internal_shade_name,
      official_tone: row.official_tone,
      official_product_url: row.official_product_url,
      original_image_url: row.official_image_url,
      captured_at: new Date().toISOString(),
      match_method: "EXACT_NORMALIZED_TONE_OR_OFFICIAL_CODE",
      confidence: "CONFIRMADO_OFICIAL",
      review_status: "DESCARGA_FALLIDA",
      publish_allowed: "NO",
      original_mime_type: "",
      original_bytes: "",
      original_width: "",
      original_height: "",
      original_sha256: "",
      normalized_mime_type: "",
      normalized_bytes: "",
      normalized_width: "",
      normalized_height: "",
      normalized_sha256: "",
      perceptual_dhash_64: "",
      controlled_local_path: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const rows = parseCsv(await fs.readFile(INPUT, "utf8")).filter(
  (row) => row.match_status === "CONFIRMADO_OFICIAL" && row.official_image_url,
);
await fs.mkdir(outputRoot, { recursive: true });

const results = [];
const concurrency = 8;
for (let offset = 0; offset < rows.length; offset += concurrency) {
  results.push(...await Promise.all(rows.slice(offset, offset + concurrency).map(download)));
  process.stdout.write(`Procesadas ${Math.min(offset + concurrency, rows.length)}/${rows.length}\n`);
}

const manifestPath = path.join(outputRoot, "verified-tone-image-manifest.csv");
await fs.writeFile(manifestPath, toCsv(results));
const duplicateHashGroups = Object.values(Object.groupBy(results.filter((row) => row.normalized_sha256), (row) => row.normalized_sha256))
  .filter((group) => group.length > 1)
  .map((group) => ({ hash: group[0].normalized_sha256, count: group.length, items: group.map((row) => `${row.internal_brand}:${row.internal_shade_name}`) }));
await fs.writeFile(
  path.join(outputRoot, "verified-tone-image-metrics.json"),
  JSON.stringify({
    requested: rows.length,
    downloaded: results.filter((row) => row.review_status === "DESCARGADA_PENDIENTE_APROBACION_HUMANA").length,
    failed: results.filter((row) => row.review_status === "DESCARGA_FALLIDA").length,
    exact_duplicate_hash_groups: duplicateHashGroups,
  }, null, 2),
);
console.log(JSON.stringify({ manifestPath, requested: rows.length, failed: results.filter((row) => row.error).length }, null, 2));
