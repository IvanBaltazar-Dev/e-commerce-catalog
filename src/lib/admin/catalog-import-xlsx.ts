import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { fromBufferPromise, type Entry } from "yauzl";
import { HttpError } from "@/lib/api/errors";
import type { CatalogImportSecurityReport } from "@/lib/admin/catalog-import-types";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 600;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 150;
const MAX_DATA_ROWS = 5_000;

const IMPORT_SHEET_HEADERS = {
  Productos: ["importar", "product_code", "slug", "template_code", "category_path", "brand_slug", "product_line_slug", "name", "short_description", "description", "editorial_status", "is_active", "is_featured", "wholesale_mixing_policy"],
  Tonos: ["importar", "brand_slug", "product_line_slug", "tone_code", "tone_name", "color_family_value", "reference_color", "is_active"],
  Variantes: ["importar", "product_code", "sku", "name", "variant_key", "tone_code", "availability", "is_default", "is_active", "sort_order", "retail_price_pen", "wholesale_price_pen", "wholesale_minimum", "media_path"],
  Atributos_producto: ["importar", "product_code", "attribute_code", "option_value", "value_text", "value_number", "value_boolean", "value_date", "value_json"],
  Atributos_variante: ["importar", "sku", "attribute_code", "option_value", "tone_code", "value_text", "value_number", "value_boolean", "value_date", "value_json"],
  Medios: ["importar", "product_code", "sku", "role", "path", "mime_type", "alt_text", "sort_order", "is_primary"],
  Relaciones: ["importar", "source_product_code", "target_product_code", "relation_type", "compatibility_status", "notes", "sort_order"]
} as const;

export type CatalogImportSheetName = keyof typeof IMPORT_SHEET_HEADERS;
export type CatalogImportCell = string | number | boolean | null;
export type CatalogImportRawRow = Record<string, CatalogImportCell> & { __row: number };
export type CatalogImportWorkbook = {
  fileName: string;
  fileSha256: string;
  security: CatalogImportSecurityReport;
  sheets: Record<CatalogImportSheetName, CatalogImportRawRow[]>;
};

type XmlArchive = {
  entries: Map<string, Buffer>;
  entryNames: Set<string>;
  archiveEntries: number;
  totalUncompressedBytes: number;
};

function unsafe(message: string, details?: unknown): never {
  throw new HttpError(422, "unsafe_xlsx", message, details);
}

function malformed(message: string, details?: unknown): never {
  throw new HttpError(422, "invalid_import_workbook", message, details);
}

function normalizeEntryName(fileName: string) {
  const normalized = fileName.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    unsafe("El XLSX contiene una ruta interna inválida.");
  }
  const safe = path.posix.normalize(normalized);
  if (safe === ".." || safe.startsWith("../") || safe.includes("/../")) {
    unsafe("El XLSX intenta salir de su contenedor interno.");
  }
  return safe;
}

function assertSafeEntry(entry: Entry, name: string) {
  const lower = name.toLowerCase();
  const dangerous =
    lower.endsWith(".bin") ||
    lower === "encryptioninfo" ||
    lower === "encryptedpackage" ||
    lower.startsWith("dataspaces/") ||
    lower.startsWith("customui/") ||
    lower.startsWith("xl/macrosheets/") ||
    lower.startsWith("xl/dialogsheets/") ||
    lower.startsWith("xl/activex/") ||
    lower.startsWith("xl/embeddings/") ||
    lower.startsWith("xl/externallinks/") ||
    lower.startsWith("xl/querytables/") ||
    lower.startsWith("xl/ctrlprops/") ||
    lower.startsWith("xl/model/") ||
    lower === "xl/connections.xml";

  if (dangerous) {
    unsafe(`El archivo contiene una parte no permitida: ${name}.`);
  }
  if (entry.isEncrypted()) {
    unsafe("No se aceptan archivos XLSX cifrados o protegidos con contraseña.");
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    unsafe(`La parte ${name} supera el tamaño descomprimido permitido.`);
  }
  if (entry.compressedSize > 0 && entry.uncompressedSize > 1_000_000 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
    unsafe(`La parte ${name} tiene una relación de compresión sospechosa.`);
  }
  if (![0, 8].includes(entry.compressionMethod)) {
    unsafe(`La parte ${name} usa un método de compresión no permitido.`);
  }
}

async function readStream(stream: NodeJS.ReadableStream, expectedBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_ENTRY_BYTES || bytes > expectedBytes + 1) {
      unsafe("Una parte del XLSX excedió el tamaño declarado.");
    }
    chunks.push(buffer);
  }
  if (bytes !== expectedBytes) {
    unsafe("Una parte del XLSX no coincide con el tamaño declarado.");
  }
  return Buffer.concat(chunks);
}

async function inspectArchive(buffer: Buffer): Promise<XmlArchive> {
  let zip;
  try {
    zip = await fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true
    });
  } catch (error) {
    malformed("El archivo no es un contenedor XLSX válido.", error instanceof Error ? error.message : undefined);
  }

  const entries = new Map<string, Buffer>();
  const entryNames = new Set<string>();
  let archiveEntries = 0;
  let totalUncompressedBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      archiveEntries += 1;
      if (archiveEntries > MAX_ARCHIVE_ENTRIES) unsafe("El XLSX contiene demasiadas partes internas.");
      const name = normalizeEntryName(entry.fileName);
      if (entryNames.has(name)) unsafe(`El XLSX contiene una parte duplicada: ${name}.`);
      entryNames.add(name);
      assertSafeEntry(entry, name);
      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) unsafe("El XLSX supera el tamaño total descomprimido permitido.");

      if (!name.endsWith("/") && (name.toLowerCase().endsWith(".xml") || name.toLowerCase().endsWith(".rels"))) {
        const stream = await zip.openReadStreamPromise(entry);
        const xml = await readStream(stream, entry.uncompressedSize);
        const text = xml.toString("utf8");
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) unsafe(`La parte ${name} contiene una declaración XML no permitida.`);
        if (name.toLowerCase().endsWith(".rels") && /TargetMode\s*=\s*["']External["']/i.test(text)) {
          unsafe("El XLSX contiene vínculos externos.");
        }
        if (/^xl\/worksheets\/.*\.xml$/i.test(name) && /<(?:\w+:)?(?:f|hyperlink)(?:\s|>)/i.test(text)) {
          unsafe("No se permiten fórmulas ni hipervínculos en el archivo de importación.");
        }
        entries.set(name, xml);
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    malformed("No se pudo inspeccionar de forma segura el XLSX.", error instanceof Error ? error.message : undefined);
  } finally {
    zip.close();
  }

  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) {
    if (!entryNames.has(required)) malformed(`Falta la parte requerida ${required}.`);
  }
  const contentTypes = entries.get("[Content_Types].xml")!.toString("utf8");
  if (/macroEnabled|vbaProject|activeX|oleObject|externalLink|connections|queryTable|customUI/i.test(contentTypes)) {
    unsafe("El XLSX declara contenido activo, enlazado o embebido no permitido.");
  }

  return { entries, entryNames, archiveEntries, totalUncompressedBytes };
}

function parseXml(xml: Buffer, handlers: {
  open?: (tag: SaxesTagNS) => void;
  close?: (tag: SaxesTagNS) => void;
  text?: (value: string) => void;
}) {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const parserState: { error?: string } = {};
  parser.on("doctype", () => unsafe("No se permiten declaraciones DOCTYPE en XML."));
  parser.on("processinginstruction", ({ target }) => {
    if (target.toLowerCase() !== "xml") unsafe("No se permiten instrucciones de procesamiento en XML.");
  });
  parser.on("error", (error) => {
    parserState.error = error.message;
  });
  if (handlers.open) parser.on("opentag", handlers.open);
  if (handlers.close) parser.on("closetag", handlers.close);
  if (handlers.text) parser.on("text", handlers.text);
  parser.write(xml.toString("utf8")).close();
  if (parserState.error) malformed("El XLSX contiene XML mal formado.", parserState.error);
}

function attribute(tag: SaxesTagNS, localName: string) {
  return Object.values(tag.attributes).find((item) => item.local === localName)?.value;
}

function parseRelationships(xml: Buffer, baseFile: string) {
  const relationships = new Map<string, string>();
  parseXml(xml, {
    open(tag) {
      if (tag.local !== "Relationship") return;
      const id = attribute(tag, "Id");
      const target = attribute(tag, "Target");
      const targetMode = attribute(tag, "TargetMode");
      if (targetMode?.toLowerCase() === "external") unsafe("El XLSX contiene una relación externa.");
      if (!id || !target) malformed("El XLSX contiene una relación incompleta.");
      const resolved = normalizeEntryName(
        target.startsWith("/")
          ? target.slice(1)
          : path.posix.join(path.posix.dirname(baseFile), target)
      );
      if (!resolved.startsWith("xl/")) unsafe("Una relación interna apunta fuera del libro.");
      relationships.set(id, resolved);
    }
  });
  return relationships;
}

function parseWorkbookSheets(xml: Buffer) {
  const sheets: Array<{ name: string; relationshipId: string }> = [];
  parseXml(xml, {
    open(tag) {
      if (tag.local !== "sheet") return;
      const name = attribute(tag, "name");
      const relationshipId = attribute(tag, "id");
      if (!name || !relationshipId) malformed("El libro contiene una hoja sin nombre o relación.");
      sheets.push({ name, relationshipId });
    }
  });
  return sheets;
}

function parseSharedStrings(xml?: Buffer) {
  if (!xml) return [];
  const strings: string[] = [];
  let insideItem = false;
  let insideText = false;
  let current = "";
  parseXml(xml, {
    open(tag) {
      if (tag.local === "si") {
        insideItem = true;
        current = "";
      } else if (insideItem && tag.local === "t") {
        insideText = true;
      }
    },
    text(value) {
      if (insideText) current += value;
    },
    close(tag) {
      if (tag.local === "t") insideText = false;
      if (tag.local === "si") {
        strings.push(current);
        insideItem = false;
      }
    }
  });
  return strings;
}

function columnNumber(reference: string) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(reference);
  if (!match) malformed(`Referencia de celda inválida: ${reference}.`);
  let result = 0;
  for (const char of match[1].toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return { column: result, row: Number(match[2]) };
}

function decodeCell(type: string | undefined, raw: string, inline: string, sharedStrings: string[]): CatalogImportCell {
  if (type === "inlineStr") return inline;
  if (type === "s") {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) malformed("El XLSX referencia un texto compartido inexistente.");
    return sharedStrings[index];
  }
  if (type === "b") return raw === "1";
  if (type === "str" || type === "d") return raw;
  if (type === "e") malformed("El XLSX contiene una celda con error.");
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) malformed(`Valor numérico inválido en una celda: ${raw}.`);
  return numeric;
}

function parseWorksheet(xml: Buffer, sharedStrings: string[]) {
  const rows = new Map<number, Map<number, CatalogImportCell>>();
  let current: { row: number; column: number; type?: string; raw: string; inline: string } | null = null;
  let captureValue = false;
  let captureInline = false;

  parseXml(xml, {
    open(tag) {
      if (tag.local === "c") {
        const reference = attribute(tag, "r");
        if (!reference) malformed("El XLSX contiene una celda sin referencia.");
        const position = columnNumber(reference);
        current = { ...position, type: attribute(tag, "t"), raw: "", inline: "" };
      } else if (current && tag.local === "f") {
        unsafe("No se permiten fórmulas en el archivo de importación.");
      } else if (current && tag.local === "v") {
        captureValue = true;
      } else if (current && tag.local === "t") {
        captureInline = true;
      } else if (tag.local === "hyperlink") {
        unsafe("No se permiten hipervínculos en el archivo de importación.");
      }
    },
    text(value) {
      if (!current) return;
      if (captureValue) current.raw += value;
      if (captureInline) current.inline += value;
    },
    close(tag) {
      if (tag.local === "v") captureValue = false;
      if (tag.local === "t") captureInline = false;
      if (tag.local === "c" && current) {
        const row = rows.get(current.row) ?? new Map<number, CatalogImportCell>();
        row.set(current.column, decodeCell(current.type, current.raw, current.inline, sharedStrings));
        rows.set(current.row, row);
        current = null;
      }
    }
  });
  return rows;
}

function cellText(value: CatalogImportCell) {
  return value === null ? "" : String(value).trim();
}

function mapSheetRows(sheetName: CatalogImportSheetName, rows: Map<number, Map<number, CatalogImportCell>>) {
  const expected = IMPORT_SHEET_HEADERS[sheetName];
  const headerRow = rows.get(1);
  if (!headerRow) malformed(`La hoja ${sheetName} no tiene encabezados en la fila 1.`);
  const actual = [...headerRow.entries()].sort(([a], [b]) => a - b).map(([, value]) => cellText(value));
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    malformed(`Los encabezados de ${sheetName} no coinciden con la plantilla.`, { expected, actual });
  }
  const result: CatalogImportRawRow[] = [];
  for (const [rowNumber, cells] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    if (rowNumber === 1) continue;
    if (result.length >= MAX_DATA_ROWS) malformed(`La hoja ${sheetName} supera ${MAX_DATA_ROWS} filas.`);
    const values = expected.map((header, index) => [header, cells.get(index + 1) ?? null] as const);
    if (values.every(([, value]) => value === null || cellText(value) === "")) continue;
    result.push(Object.assign(Object.fromEntries(values), { __row: rowNumber }) as CatalogImportRawRow);
  }
  return result;
}

export async function parseCatalogImportXlsx(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<CatalogImportWorkbook> {
  if (!/\.xlsx$/i.test(file.name) || /\.(?:xlsm|xlsb|xls)$/i.test(file.name)) {
    throw new HttpError(415, "unsupported_import_file", "Solo se acepta .xlsx; .xls, .xlsm y .xlsb están bloqueados.");
  }
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new HttpError(413, "import_file_too_large", `El archivo debe pesar entre 1 byte y ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length !== file.size || buffer.length > MAX_FILE_BYTES) malformed("El tamaño recibido no coincide con el archivo declarado.");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) malformed("El archivo no tiene la firma de un XLSX.");

  const fileSha256 = createHash("sha256").update(buffer).digest("hex");
  const archive = await inspectArchive(buffer);
  const workbookSheets = parseWorkbookSheets(archive.entries.get("xl/workbook.xml")!);
  const relationships = parseRelationships(archive.entries.get("xl/_rels/workbook.xml.rels")!, "xl/workbook.xml");
  const sharedStrings = parseSharedStrings(archive.entries.get("xl/sharedStrings.xml"));
  const sheets = {} as Record<CatalogImportSheetName, CatalogImportRawRow[]>;

  for (const sheetName of Object.keys(IMPORT_SHEET_HEADERS) as CatalogImportSheetName[]) {
    const sheet = workbookSheets.find((item) => item.name === sheetName);
    if (!sheet) malformed(`Falta la hoja obligatoria ${sheetName}.`);
    const target = relationships.get(sheet.relationshipId);
    if (!target || !/^xl\/worksheets\/[^/]+\.xml$/i.test(target)) malformed(`La hoja ${sheetName} apunta a una parte inválida.`);
    const xml = archive.entries.get(target);
    if (!xml) malformed(`No se pudo leer la hoja ${sheetName}.`);
    sheets[sheetName] = mapSheetRows(sheetName, parseWorksheet(xml, sharedStrings));
  }

  const totalRows = Object.values(sheets).reduce((sum, rows) => sum + rows.length, 0);
  if (totalRows > MAX_DATA_ROWS) malformed(`El archivo supera el máximo total de ${MAX_DATA_ROWS} filas de datos.`);

  return {
    fileName: file.name,
    fileSha256,
    security: {
      fileSha256,
      fileBytes: buffer.length,
      archiveEntries: archive.archiveEntries,
      totalUncompressedBytes: archive.totalUncompressedBytes,
      macrosDetected: false,
      externalLinksDetected: false,
      embeddedObjectsDetected: false,
      formulasDetected: false,
      originalFileStored: false
    },
    sheets
  };
}
