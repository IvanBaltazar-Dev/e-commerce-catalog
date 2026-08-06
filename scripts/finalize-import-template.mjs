import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.ARTIFACT_TOOL_MODULE;
if (!modulePath) throw new Error("Define ARTIFACT_TOOL_MODULE con la ruta a artifact_tool.mjs.");

const [{ SpreadsheetFile }] = await Promise.all([import(pathToFileURL(modulePath).href)]);
const source = path.resolve(process.argv[2] ?? "");
const target = path.resolve(process.argv[3] ?? process.argv[2] ?? "");
if (!source.toLowerCase().endsWith(".xlsx") || !target.toLowerCase().endsWith(".xlsx")) throw new Error("Indica la ruta de origen y, opcionalmente, la salida .xlsx.");

const bytes = await fs.readFile(source);
const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const workbook = await SpreadsheetFile.importXlsx(input);
const control = workbook.worksheets.getItem("Control");
const readme = workbook.worksheets.getItem("LEEME");

// Valores informativos estáticos: la plantilla de importación no debe contener
// fórmulas que un archivo no confiable pueda reutilizar como vector de inyección.
control.getRange("B5:B11").values = [[3], [5], [3], [0], [0], [0], [0]];
control.getRange("A13").values = [["Validaciones del cargador: unicidad de product_code/SKU/slug; referencias entre hojas; exactamente una variante activa predeterminada; tipos y opciones de atributos; reglas condicionales; rangos numéricos; existencia de marca/categoría/línea; y validación integral antes del commit."]];
readme.getRange("A4").values = [["El cargador interno ya está disponible para el rol developer. Usa esta plantilla para importar productos completos sin perder variantes, tonos, atributos, precios, medios ni relaciones. Todas las filas de ejemplo permanecen con importar=FALSE para evitar cargas accidentales."]];

const rendered = await workbook.render({ sheetName: "Control", autoCrop: "all", scale: 1, format: "png" });
const previewPath = path.join(path.dirname(target), "plantilla_importacion_productos_control.png");
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(previewPath, new Uint8Array(await rendered.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(target);
await fs.rm(`${target}.inspect.ndjson`, { force: true });
console.log(JSON.stringify({ source, target, previewPath }));
