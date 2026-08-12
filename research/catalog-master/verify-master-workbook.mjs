import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogResearchPath } from "../../scripts/lib/catalog-research-paths.mjs";

const artifactToolEntry = process.env.ARTIFACT_TOOL_ENTRY;
if (!artifactToolEntry) throw new Error("Configura ARTIFACT_TOOL_ENTRY para verificar el workbook.");
const { FileBlob, SpreadsheetFile } = await import(artifactToolEntry);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = catalogResearchPath(repoRoot, "local", "outputs", "master-workbook");
const workbookPath = path.join(outputDir, "Bellaroshe_Base_Maestra_Enriquecimiento.xlsx");
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
const inspection = await workbook.inspect({
  kind: "workbook,sheet,table,formula",
  maxChars: 16000,
  tableMaxRows: 4,
  tableMaxCols: 8,
  tableMaxCellChars: 90,
});
await fs.writeFile(path.join(outputDir, "postexport-inspection.ndjson"), inspection.ndjson, "utf8");

const errors = [];
for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange(true);
  for (const [rowIndex, row] of used.values.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      if (typeof value === "string" && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(value)) {
        errors.push({ sheet: sheet.name, row: rowIndex + 1, column: columnIndex + 1, value });
      }
    }
  }
}

const preview = await workbook.render({ sheetName: "00_Resumen", range: "A1:L32", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "postexport-summary.png"), new Uint8Array(await preview.arrayBuffer()));
await fs.writeFile(path.join(outputDir, "postexport-formula-errors.json"), JSON.stringify(errors, null, 2));
if (errors.length) throw new Error(`Post-export verification found ${errors.length} formula errors.`);

console.log(JSON.stringify({ workbookPath, sheets: workbook.worksheets.items.length, formulaErrors: errors.length }, null, 2));
