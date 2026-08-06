import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { deflateRawSync } from "node:zlib";
import yauzl from "yauzl";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const target = path.join(root, "src", `${specifier.slice(2)}.ts`);
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const { parseCatalogImportXlsx } = await import("../src/lib/admin/catalog-import-xlsx.ts");
const templatePath = path.join(root, "assets", "import", "plantilla_importacion_productos.xlsx");
const bytes = await fs.readFile(templatePath);

async function unzip(buffer) {
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  const entries = new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      entries.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    zip.close();
  }
  return entries;
}

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

function memoryFile(name, buffer) {
  return {
    name,
    size: buffer.length,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

const file = {
  name: "plantilla_importacion_productos.xlsx",
  size: bytes.length,
  async arrayBuffer() {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
};

const workbook = await parseCatalogImportXlsx(file);
assert.equal(workbook.fileName, file.name);
assert.match(workbook.fileSha256, /^[0-9a-f]{64}$/);
assert.deepEqual(Object.keys(workbook.sheets), [
  "Productos",
  "Tonos",
  "Variantes",
  "Atributos_producto",
  "Atributos_variante",
  "Medios",
  "Relaciones"
]);
assert.equal(workbook.sheets.Productos.length, 3);
assert.equal(workbook.sheets.Tonos.length, 3);
assert.equal(workbook.sheets.Variantes.length, 5);
assert.equal(workbook.sheets.Relaciones.length, 1);
assert.equal(workbook.security.macrosDetected, false);
assert.equal(workbook.security.externalLinksDetected, false);
assert.equal(workbook.security.embeddedObjectsDetected, false);
assert.equal(workbook.security.formulasDetected, false);
assert.equal(workbook.security.originalFileStored, false);

await assert.rejects(
  () => parseCatalogImportXlsx({ ...file, name: "catalogo.xlsm" }),
  (error) => error?.code === "unsupported_import_file"
);
await assert.rejects(
  () => parseCatalogImportXlsx({ ...file, size: 9 * 1024 * 1024 }),
  (error) => error?.code === "import_file_too_large"
);

const safeEntries = await unzip(bytes);
const macroEntries = new Map(safeEntries);
macroEntries.set("xl/vbaProject.bin", Buffer.from("not executable; presence alone must be rejected"));
await assert.rejects(
  () => parseCatalogImportXlsx(memoryFile("macro.xlsx", zipEntries(macroEntries))),
  (error) => error?.code === "unsafe_xlsx" && /no permitida/i.test(error.message)
);

const formulaEntries = new Map(safeEntries);
const productSheet = formulaEntries.get("xl/worksheets/sheet2.xml").toString("utf8");
const formulaSheet = productSheet.replace(/(<\/(?:\w+:)?worksheet>)/i, '<f>WEBSERVICE("https://invalid.test")</f>$1');
assert.notEqual(formulaSheet, productSheet);
formulaEntries.set("xl/worksheets/sheet2.xml", Buffer.from(formulaSheet));
await assert.rejects(
  () => parseCatalogImportXlsx(memoryFile("formula.xlsx", zipEntries(formulaEntries))),
  (error) => error?.code === "unsafe_xlsx" && /fórmulas/i.test(error.message)
);

const externalEntries = new Map(safeEntries);
const rootRelationships = externalEntries.get("_rels/.rels").toString("utf8");
const evilRelationships = rootRelationships.replace(/(<\/(?:\w+:)?Relationships>)/i, '<Relationship Id="evil" Type="urn:test" Target="https://invalid.test" TargetMode="External"/>$1');
assert.notEqual(evilRelationships, rootRelationships);
externalEntries.set("_rels/.rels", Buffer.from(evilRelationships));
await assert.rejects(
  () => parseCatalogImportXlsx(memoryFile("external.xlsx", zipEntries(externalEntries))),
  (error) => error?.code === "unsafe_xlsx" && /vínculos externos/i.test(error.message)
);

const bombEntries = new Map(safeEntries);
bombEntries.set("xl/media/padding.txt", Buffer.alloc(2_000_000, 0x41));
await assert.rejects(
  () => parseCatalogImportXlsx(memoryFile("bomb.xlsx", zipEntries(bombEntries))),
  (error) => error?.code === "unsafe_xlsx" && /compresión sospechosa/i.test(error.message)
);

console.log("OK: plantilla, contrato, macros, fórmulas, enlaces externos y compresión maliciosa verificados.");
