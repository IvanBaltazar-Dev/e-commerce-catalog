import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const { parseCatalogMediaZip } = await import("../src/lib/admin/catalog-media-zip.ts");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [entryName, raw] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function webp(payload = Buffer.from([0x2f, 0, 0, 0, 0])) {
  const padding = payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const chunk = Buffer.alloc(8);
  chunk.write("VP8L", 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), chunk, payload, padding]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function webpWithDimensions(width, height) {
  const w = width - 1;
  const h = height - 1;
  return webp(Buffer.from([0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f]));
}

function pdf(extra = "") {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

function memoryFile(name, buffer) {
  return {
    name,
    size: buffer.length,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

const safeZip = zipEntries(new Map([
  ["MANIFIESTO_IMAGENES.csv", Buffer.from("ruta_storage\nproductos/PRUEBA/main.webp\n")],
  ["README_CARGA.txt", Buffer.from("Solo informativo")],
  ["productos/PRUEBA/main.webp", webp()],
  ["productos/PRUEBA/carta.pdf", pdf()]
]));
const parsed = await parseCatalogMediaZip(memoryFile("medios.zip", safeZip));
assert.equal(parsed.assets.length, 2);
assert.equal(parsed.ignored.length, 2);
assert.deepEqual(parsed.assets.map((asset) => asset.mimeType), ["image/webp", "application/pdf"]);
assert.equal(parsed.security.pathsRestrictedToProducts, true);
assert.equal(parsed.security.contentSignaturesVerified, true);
assert.equal(parsed.security.originalFileStored, false);

await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["../evil.webp", webp()]])))),
  (error) => ["unsafe_media_zip", "invalid_media_zip"].includes(error?.code)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["productos/PRUEBA/script.js", Buffer.from("alert(1)")]])))),
  (error) => error?.code === "unsafe_media_zip" && /tipo de archivo/i.test(error.message)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["productos/PRUEBA/falso.webp", Buffer.from("not-webp")]])))),
  (error) => error?.code === "unsafe_media_zip" && /firma WebP/i.test(error.message)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["productos/PRUEBA/activo.pdf", pdf("/OpenAction 2 0 R")]])))),
  (error) => error?.code === "unsafe_media_zip" && /OpenAction/i.test(error.message)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([
    ["productos/PRUEBA/main.webp", webp()],
    ["productos/prueba/MAIN.webp", webp()]
  ])))),
  (error) => error?.code === "unsafe_media_zip" && /duplicada/i.test(error.message)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["productos/PRUEBA/bomba.webp", webp(Buffer.alloc(2_000_000, 0x41))]])))),
  (error) => error?.code === "unsafe_media_zip" && /compresión sospechosa/i.test(error.message)
);
await assert.rejects(
  () => parseCatalogMediaZip(memoryFile("medios.zip", zipEntries(new Map([["productos/PRUEBA/gigante.webp", webpWithDimensions(12_001, 1)]])))),
  (error) => error?.code === "unsafe_media_zip" && /dimensiones de imagen excesivas/i.test(error.message)
);

const realPath = process.argv[2];
if (realPath) {
  const bytes = await fs.readFile(realPath);
  const real = await parseCatalogMediaZip(memoryFile(path.basename(realPath), bytes));
  assert.equal(real.assets.length, 160, "El paquete Masglo debe contener 160 medios.");
  assert.equal(real.ignored.length, 2, "El paquete Masglo debe ignorar manifiesto y README.");
}

console.log(`OK: ZIP seguro, ${parsed.assets.length} medios, metadatos ignorados y ataques bloqueados${realPath ? "; paquete Masglo verificado" : ""}.`);
