import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import { fromBufferPromise, type Entry } from "yauzl";
import { HttpError } from "@/lib/api/errors";
import type { CatalogMediaSecurityReport } from "@/lib/admin/catalog-import-types";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 800;
const MAX_MEDIA_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_ENTRY_BYTES = 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 150;
const MAX_STORAGE_PATH_BYTES = 512;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_IMAGE_PIXELS = 50_000_000;

const MEDIA_TYPES = new Map<string, "image/webp" | "application/pdf">([
  [".webp", "image/webp"],
  [".pdf", "application/pdf"]
] as const);

const IGNORED_METADATA = new Map([
  ["manifiesto_imagenes.csv", "Manifiesto informativo; no se almacena."],
  ["readme_carga.txt", "Instructivo informativo; no se almacena."]
]);

const PDF_FORBIDDEN_TOKENS = [
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "OpenAction",
  "AA",
  "RichMedia",
  "XFA",
  "AcroForm",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "ObjStm",
  "Encrypt"
];

export type CatalogMediaAsset = {
  path: string;
  mimeType: "image/webp" | "application/pdf";
  bytes: number;
  sha256: string;
  body: Buffer;
};

export type CatalogMediaPackage = {
  fileName: string;
  fileSha256: string;
  security: CatalogMediaSecurityReport;
  assets: CatalogMediaAsset[];
  ignored: Array<{ path: string; reason: string }>;
};

function unsafe(message: string, details?: unknown): never {
  throw new HttpError(422, "unsafe_media_zip", message, details);
}

function malformed(message: string, details?: unknown): never {
  throw new HttpError(422, "invalid_media_zip", message, details);
}

function normalizeEntryName(fileName: string) {
  if (!fileName || fileName.includes("\0") || fileName.includes("\\") || fileName.startsWith("/") || /^[A-Za-z]:/.test(fileName)) {
    unsafe("El ZIP contiene una ruta interna inválida.");
  }
  const normalized = fileName.normalize("NFC");
  if (normalized !== fileName || /[\u0000-\u001f\u007f]/.test(normalized)) {
    unsafe(`La ruta ${fileName} contiene caracteres no permitidos.`);
  }
  const safe = path.posix.normalize(normalized);
  if (safe !== normalized || safe === ".." || safe.startsWith("../") || safe.includes("/../")) {
    unsafe(`La ruta ${fileName} intenta salir del paquete.`);
  }
  const segments = safe.replace(/\/$/, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.trim() !== segment || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    unsafe(`La ruta ${fileName} no usa nombres seguros tipo slug.`);
  }
  if (Buffer.byteLength(safe, "utf8") > MAX_STORAGE_PATH_BYTES) unsafe(`La ruta ${fileName} es demasiado larga.`);
  return safe;
}

function isUnixSymlink(entry: Entry) {
  const platform = entry.versionMadeBy >>> 8;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return platform === 3 && (mode & 0o170000) === 0o120000;
}

function assertSafeEntry(entry: Entry, name: string, maxBytes: number) {
  if (entry.isEncrypted()) unsafe(`El archivo ${name} está cifrado.`);
  if (isUnixSymlink(entry)) unsafe(`No se permiten enlaces simbólicos: ${name}.`);
  if (![0, 8].includes(entry.compressionMethod)) unsafe(`El archivo ${name} usa un método de compresión no permitido.`);
  if (entry.uncompressedSize > maxBytes) unsafe(`El archivo ${name} supera el tamaño permitido.`);
  if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
    unsafe(`El archivo ${name} tiene una relación de compresión sospechosa.`);
  }
}

async function readEntry(zip: Awaited<ReturnType<typeof fromBufferPromise>>, entry: Entry, maxBytes: number) {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes || bytes > entry.uncompressedSize + 1) unsafe(`El archivo ${entry.fileName} excedió el tamaño declarado.`);
    chunks.push(buffer);
  }
  if (bytes !== entry.uncompressedSize) unsafe(`El tamaño real de ${entry.fileName} no coincide con el declarado.`);
  return Buffer.concat(chunks);
}

function validateWebp(buffer: Buffer, storagePath: string) {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    unsafe(`${storagePath} no tiene una firma WebP válida.`);
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) unsafe(`${storagePath} tiene un tamaño RIFF inconsistente.`);
  const allowedChunks = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP", "EXIF", "XMP "]);
  let offset = 12;
  let imageChunk = false;
  let width = 0;
  let height = 0;
  const read24 = (position: number) => buffer[position] | (buffer[position + 1] << 8) | (buffer[position + 2] << 16);
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) unsafe(`${storagePath} contiene un bloque WebP truncado.`);
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkBytes = buffer.readUInt32LE(offset + 4);
    if (!allowedChunks.has(chunkType)) unsafe(`${storagePath} contiene un bloque WebP no permitido: ${chunkType}.`);
    const next = offset + 8 + chunkBytes + (chunkBytes % 2);
    if (next > buffer.length) unsafe(`${storagePath} contiene un bloque WebP fuera de límites.`);
    const dataOffset = offset + 8;
    if (chunkType === "VP8X") {
      if (chunkBytes < 10) unsafe(`${storagePath} contiene un encabezado VP8X truncado.`);
      width = read24(dataOffset + 4) + 1;
      height = read24(dataOffset + 7) + 1;
    } else if (chunkType === "VP8L") {
      if (chunkBytes < 5 || buffer[dataOffset] !== 0x2f) unsafe(`${storagePath} contiene un encabezado VP8L inválido.`);
      width = 1 + buffer[dataOffset + 1] + ((buffer[dataOffset + 2] & 0x3f) << 8);
      height = 1 + (buffer[dataOffset + 2] >> 6) + (buffer[dataOffset + 3] << 2) + ((buffer[dataOffset + 4] & 0x0f) << 10);
      imageChunk = true;
    } else if (chunkType === "VP8 ") {
      if (chunkBytes < 10 || buffer[dataOffset + 3] !== 0x9d || buffer[dataOffset + 4] !== 0x01 || buffer[dataOffset + 5] !== 0x2a) {
        unsafe(`${storagePath} contiene un encabezado VP8 inválido.`);
      }
      width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
      height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
      imageChunk = true;
    } else if (chunkType === "ANMF") {
      imageChunk = true;
    }
    offset = next;
  }
  if (offset !== buffer.length || !imageChunk || width <= 0 || height <= 0) unsafe(`${storagePath} no contiene datos de imagen WebP completos.`);
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    unsafe(`${storagePath} declara dimensiones de imagen excesivas (${width}x${height}).`);
  }
}

function validatePdf(buffer: Buffer, storagePath: string) {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 5) !== "%PDF-") unsafe(`${storagePath} no tiene una firma PDF válida.`);
  const latin = buffer.toString("latin1");
  const eof = latin.lastIndexOf("%%EOF");
  if (eof < 0 || /[^\s\0]/.test(latin.slice(eof + 5))) unsafe(`${storagePath} no termina como un PDF válido.`);
  const syntaxOnly = latin.replace(/stream\r?\n[\s\S]*?endstream/g, "stream\nendstream");
  for (const token of PDF_FORBIDDEN_TOKENS) {
    const pattern = new RegExp(`/${token}(?![A-Za-z0-9])`, "i");
    if (pattern.test(syntaxOnly)) unsafe(`${storagePath} contiene una función PDF activa o no permitida: /${token}.`);
  }
}

function validateAsset(buffer: Buffer, storagePath: string, mimeType: CatalogMediaAsset["mimeType"]) {
  if (buffer.length === 0) unsafe(`${storagePath} está vacío.`);
  if (mimeType === "image/webp") validateWebp(buffer, storagePath);
  else validatePdf(buffer, storagePath);
}

export async function parseCatalogMediaZip(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<CatalogMediaPackage> {
  if (!/\.zip$/i.test(file.name)) throw new HttpError(415, "unsupported_media_file", "Selecciona un paquete .zip.");
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new HttpError(413, "media_zip_too_large", `El ZIP debe pesar entre 1 byte y ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length !== file.size || buffer.length > MAX_FILE_BYTES) malformed("El tamaño recibido no coincide con el ZIP declarado.");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) malformed("El archivo no tiene la firma de un ZIP.");

  let zip: Awaited<ReturnType<typeof fromBufferPromise>>;
  try {
    zip = await fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  } catch (error) {
    malformed("No se pudo abrir el contenedor ZIP.", error instanceof Error ? error.message : undefined);
  }

  const assets: CatalogMediaAsset[] = [];
  const ignored: Array<{ path: string; reason: string }> = [];
  const names = new Set<string>();
  let archiveEntries = 0;
  let totalUncompressedBytes = 0;
  let mediaBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      archiveEntries += 1;
      if (archiveEntries > MAX_ARCHIVE_ENTRIES) unsafe("El ZIP contiene demasiadas entradas.");
      const name = normalizeEntryName(entry.fileName);
      const duplicateKey = name.replace(/\/$/, "").toLowerCase();
      if (names.has(duplicateKey)) unsafe(`El ZIP contiene una ruta duplicada: ${name}.`);
      names.add(duplicateKey);
      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) unsafe("El ZIP supera el tamaño total descomprimido permitido.");

      if (name.endsWith("/")) {
        if (name !== "productos/" && !name.startsWith("productos/")) unsafe(`La carpeta ${name} está fuera de productos/.`);
        assertSafeEntry(entry, name, 0);
        continue;
      }

      const metadataReason = IGNORED_METADATA.get(name.toLowerCase());
      if (metadataReason) {
        assertSafeEntry(entry, name, MAX_METADATA_ENTRY_BYTES);
        await readEntry(zip, entry, MAX_METADATA_ENTRY_BYTES);
        ignored.push({ path: name, reason: metadataReason });
        continue;
      }

      if (!name.startsWith("productos/")) unsafe(`Solo se permiten medios dentro de productos/: ${name}.`);
      const extension = path.posix.extname(name).toLowerCase();
      const mimeType = MEDIA_TYPES.get(extension);
      if (!mimeType) unsafe(`El ZIP contiene un tipo de archivo no permitido: ${name}.`);
      assertSafeEntry(entry, name, MAX_MEDIA_ENTRY_BYTES);
      const body = await readEntry(zip, entry, MAX_MEDIA_ENTRY_BYTES);
      validateAsset(body, name, mimeType);
      mediaBytes += body.length;
      assets.push({ path: name, mimeType, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), body });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    malformed("No se pudo inspeccionar el ZIP de forma segura.", error instanceof Error ? error.message : undefined);
  } finally {
    zip.close();
  }

  if (!assets.length) malformed("El ZIP no contiene archivos WebP o PDF importables dentro de productos/.");
  const fileSha256 = createHash("sha256").update(buffer).digest("hex");
  return {
    fileName: file.name,
    fileSha256,
    assets,
    ignored,
    security: {
      fileSha256,
      fileBytes: buffer.length,
      archiveEntries,
      totalUncompressedBytes,
      mediaBytes,
      pathsRestrictedToProducts: true,
      contentSignaturesVerified: true,
      existingFilesOverwritten: false,
      originalFileStored: false
    }
  };
}
