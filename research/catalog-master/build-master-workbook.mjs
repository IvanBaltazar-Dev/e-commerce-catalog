import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogResearchPath } from "../../scripts/lib/catalog-research-paths.mjs";

const artifactToolEntry = process.env.ARTIFACT_TOOL_ENTRY;
if (!artifactToolEntry) throw new Error("Configura ARTIFACT_TOOL_ENTRY para generar el workbook.");
const { SpreadsheetFile, Workbook } = await import(artifactToolEntry);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = catalogResearchPath(REPO_ROOT, "data");
const OUTPUT_DIR = catalogResearchPath(REPO_ROOT, "local", "outputs", "master-workbook");
const PREVIEW_DIR = path.join(OUTPUT_DIR, "workbook-previews");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "Bellaroshe_Base_Maestra_Enriquecimiento.xlsx");
const VERIFIED_MANIFEST = path.join(OUTPUT_DIR, "verified-tone-images", "verified-tone-image-manifest.csv");
const CUTOFF = process.env.CATALOG_RESEARCH_CUTOFF || "no-especificado";

const palette = {
  ink: "#28171D",
  wine: "#7A293E",
  wineDark: "#542033",
  rose: "#C98B98",
  blush: "#F1DDE1",
  cream: "#FBF6F1",
  sand: "#E8D9CC",
  gold: "#B58B54",
  green: "#DDEFE4",
  greenInk: "#23623E",
  amber: "#FFF0C7",
  amberInk: "#7A4A00",
  red: "#F8D7DA",
  redInk: "#842029",
  white: "#FFFFFF",
};

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
  return body.filter((cells) => cells.some((cell) => cell !== "")).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])));
}

async function readCsv(name) {
  return parseCsv(await fs.readFile(path.join(DATA, name), "utf8"));
}

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(DATA, name), "utf8"));
}

function titleCase(value) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/Url\b/g, "URL")
    .replace(/Id\b/g, "ID")
    .replace(/Sku\b/g, "SKU")
    .replace(/Pct\b/g, "%");
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const modulo = (value - 1) % 26;
    result = String.fromCharCode(65 + modulo) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function normalizedRows(rows, columns) {
  return rows.map((row) => columns.map(({ key }) => {
    const value = row[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "number" || typeof value === "boolean") return value;
    const string = String(value);
    if (/^-?\d+(?:\.\d+)?$/.test(string) && !/(id|sku|code|barcode|row|path|url)/i.test(key)) return Number(string);
    return string;
  }));
}

function columnWidth(header) {
  if (/url|path|evidence|action|reason|rationale|checklist|attribute|description|example|notes/i.test(header)) return 34;
  if (/product|variant|family|line|collection|entity|title|name|shots|labels/i.test(header)) return 25;
  if (/id|sku|code|hash|barcode/i.test(header)) return 19;
  if (/status|classification|confidence|authority/i.test(header)) return 21;
  return 15;
}

function styleDataSheet(sheet, title, subtitle, columns, rowCount, tableName) {
  const lastColumn = columnLetter(columns.length - 1);
  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastColumn}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A2:${lastColumn}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: palette.ink,
    font: { bold: true, color: palette.white, size: 18 },
    verticalAlignment: "center",
  };
  sheet.getRange(`A2:${lastColumn}2`).format = {
    fill: palette.cream,
    font: { italic: true, color: palette.wineDark, size: 10 },
    wrapText: true,
    verticalAlignment: "center",
  };
  sheet.getRange(`A4:${lastColumn}4`).format = {
    fill: palette.wine,
    font: { bold: true, color: palette.white },
    wrapText: true,
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: palette.sand },
  };
  if (rowCount > 0) {
    const body = sheet.getRange(`A5:${lastColumn}${rowCount + 4}`);
    body.format = {
      font: { color: palette.ink, size: 9 },
      wrapText: true,
      verticalAlignment: "top",
      borders: { preset: "all", style: "thin", color: "#E7DDD5" },
    };
    const table = sheet.tables.add(`A4:${lastColumn}${rowCount + 4}`, true, tableName);
    table.style = "TableStyleMedium2";
    table.showBandedColumns = false;
    table.showFilterButton = true;
  }
  sheet.getRange("1:1").format.rowHeight = 34;
  sheet.getRange("2:2").format.rowHeight = 34;
  sheet.getRange("4:4").format.rowHeight = 30;
  columns.forEach((column, index) => {
    sheet.getRange(`${columnLetter(index)}4:${columnLetter(index)}${Math.max(5, rowCount + 4)}`).format.columnWidth = column.width || columnWidth(column.label);
    if (/captured_at|published_at|updated_at|date/i.test(column.key)) {
      sheet.getRange(`${columnLetter(index)}5:${columnLetter(index)}${Math.max(5, rowCount + 4)}`).format.numberFormat = "yyyy-mm-dd hh:mm";
    }
  });
  sheet.freezePanes.freezeRows(4);

  const used = sheet.getRange(`A4:${lastColumn}${Math.max(5, rowCount + 4)}`);
  used.conditionalFormats.add("containsText", { text: "CONFIRMADO", format: { fill: palette.green, font: { color: palette.greenInk, bold: true } } });
  used.conditionalFormats.add("containsText", { text: "EXACTO", format: { fill: palette.green, font: { color: palette.greenInk, bold: true } } });
  used.conditionalFormats.add("containsText", { text: "CAPTURADA", format: { fill: palette.green, font: { color: palette.greenInk, bold: true } } });
  used.conditionalFormats.add("containsText", { text: "PENDIENTE", format: { fill: palette.amber, font: { color: palette.amberInk } } });
  used.conditionalFormats.add("containsText", { text: "CONFLICTO", format: { fill: palette.red, font: { color: palette.redInk, bold: true } } });
  used.conditionalFormats.add("containsText", { text: "INSUFICIENTE", format: { fill: palette.red, font: { color: palette.redInk, bold: true } } });
  used.conditionalFormats.add("containsText", { text: "REQUIERE", format: { fill: palette.amber, font: { color: palette.amberInk } } });
  used.conditionalFormats.add("containsText", { text: "OPEN", format: { fill: palette.red, font: { color: palette.redInk } } });
}

function addDataSheet(workbook, spec) {
  const sheet = workbook.worksheets.add(spec.name);
  const headers = spec.columns.map((column) => column.label);
  const values = normalizedRows(spec.rows, spec.columns);
  const lastColumn = columnLetter(spec.columns.length - 1);
  sheet.getRange(`A4:${lastColumn}4`).values = [headers];
  if (values.length) sheet.getRange(`A5:${lastColumn}${values.length + 4}`).values = values;
  styleDataSheet(sheet, spec.title, spec.subtitle, spec.columns, values.length, spec.tableName);
  return sheet;
}

const [
  sourceMetrics,
  reconciliationMetrics,
  enrichmentMetrics,
  mediaMetrics,
  masterMetrics,
  taxonomyTree,
  canonicalTaxonomy,
  sourceReconciliation,
  brandCoverage,
  collectionCoverage,
  physicalChecklist,
  officialImageInventory,
  relationCandidates,
  exceptionRegister,
  sourceSummary,
  // La posición manda: el nombre documenta qué CSV ocupa este hueco y no puede
  // borrarse sin desalinear brandRegistry del siguiente readCsv.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toneReconciliation,
  brandRegistry,
] = await Promise.all([
  readJson("internal_metrics.json"),
  readJson("reconciliation_metrics.json"),
  readJson("enrichment_metrics.json"),
  readJson("media_metrics.json"),
  readJson("master_tables_metrics.json"),
  readCsv("catalog_taxonomy_tree.csv"),
  readCsv("canonical_taxonomy.csv"),
  readCsv("source_row_reconciliation.csv"),
  readCsv("brand_coverage_master.csv"),
  readCsv("collection_tone_coverage.csv"),
  readCsv("physical_capture_checklist.csv"),
  readCsv("official_image_inventory.csv"),
  readCsv("product_relation_candidates.csv"),
  readCsv("master_exception_register.csv"),
  readCsv("external_official_sources_summary.csv"),
  readCsv("internal_official_tone_reconciliation.csv"),
  readCsv("brand_resolution_registry.csv"),
]);
const verifiedManifest = parseCsv(await fs.readFile(VERIFIED_MANIFEST, "utf8"));

const notIdentifiedRows = [
  ...sourceReconciliation.filter((row) => row.reconciliation_status !== "EXACTO").map((row) => ({
    scope: "FILA_EXCEL",
    key: row.source_excel_row,
    brand: row.source_brand_normalized,
    entity: row.source_description,
    status: row.reconciliation_status,
    score: row.matching_score,
    candidate: `${row.internal_brand} / ${row.internal_product_name} / ${row.internal_variant_name}`,
    reason: row.decision_reason,
    required_action: "REVISAR_Y_APROBAR_MANUALMENTE",
    publish_allowed: "NO",
  })),
  ...brandRegistry.filter((row) => row.research_status !== "FUENTE_OFICIAL_CAPTURADA").map((row) => ({
    scope: "MARCA",
    key: row.brand_id,
    brand: row.brand,
    entity: `${row.products} productos / ${row.variants} variantes`,
    status: row.research_status,
    score: "",
    candidate: row.initial_identity_status,
    reason: row.source_authority,
    required_action: row.next_action,
    publish_allowed: "NO",
  })),
];

const imageRows = [
  ...verifiedManifest.map((row) => ({
    inventory_scope: "DESCARGADA_A_ALMACEN_CONTROLADO",
    brand: row.internal_brand,
    product_or_tone: row.internal_shade_name,
    image_id: row.internal_shade_id,
    role: "swatch/variant",
    source_product_url: row.official_product_url,
    original_image_url: row.original_image_url,
    captured_at: row.captured_at,
    confidence: row.confidence,
    review_status: row.review_status,
    controlled_local_path: row.controlled_local_path,
    sha256: row.normalized_sha256,
    perceptual_hash: row.perceptual_dhash_64,
    dimensions: `${row.normalized_width}×${row.normalized_height}`,
    required_action: "APROBACION_HUMANA_ANTES_DE_PUBLICAR",
    publish_allowed: row.publish_allowed,
  })),
  ...officialImageInventory.map((row) => ({
    inventory_scope: "DESCUBIERTA_OFICIAL_REMOTA",
    brand: row.brand,
    product_or_tone: `product:${row.external_product_id}`,
    image_id: `image:${row.external_image_id}`,
    role: row.role,
    source_product_url: row.source_product_url,
    original_image_url: row.image_url,
    captured_at: row.captured_at,
    confidence: row.confidence,
    review_status: row.inventory_status,
    controlled_local_path: "",
    sha256: "",
    perceptual_hash: "",
    dimensions: [row.width, row.height].filter(Boolean).join("×"),
    required_action: row.required_action,
    publish_allowed: row.publish_allowed_now,
  })),
];

const sourceRows = [
  ...sourceSummary.map((row) => ({
    source_name: `${row.brand} — catálogo oficial`,
    authority: "PRIMARIA_OFICIAL",
    adapter: row.source_type,
    url_or_path: row.source_root_url,
    captured_at: row.captured_at,
    products: row.products,
    variants: row.variants,
    images: row.images,
    notes: "Snapshot RAW conservado en almacenamiento local administrado.",
  })),
  {
    source_name: "Excel Bellaroshé V2",
    authority: "DOCUMENTO_INTERNO",
    adapter: "xlsx",
    url_or_path: process.env.CATALOG_SOURCE_WORKBOOK || "local-storage://local/inputs/listado.xlsx",
    captured_at: CUTOFF,
    products: "",
    variants: 1500,
    images: "",
    notes: "Punto de partida; no se considera universo completo.",
  },
  {
    source_name: "Manifesto local Masglo tradicional",
    authority: "ACTIVO_INTERNO_CON_ADVERTENCIA",
    adapter: "csv + webp",
    url_or_path: process.env.CATALOG_MASGLO_MANIFEST || "local-storage://local/inputs/masglo/MANIFIESTO_IMAGENES.csv",
    captured_at: CUTOFF,
    products: 1,
    variants: 157,
    images: 157,
    notes: "156 son visuales estandarizados, no fotografías individuales; validar derechos.",
  },
];

const workbook = Workbook.create();
const summary = workbook.worksheets.add("00_Resumen");

const specs = [
  {
    name: "A_Arbol_maestro",
    title: "A · Árbol maestro del negocio",
    subtitle: "Dominios y familias actuales organizados por proceso real de uso. Las seis filas pendientes permanecen visibles.",
    rows: taxonomyTree,
    tableName: "MasterTreeTable",
    columns: [
      { key: "Categoría principal", label: "Dominio" },
      { key: "Familia", label: "Familia funcional" },
      { key: "process_flow", label: "Flujo natural de uso" },
      { key: "Registros", label: "Filas fuente" },
      { key: "taxonomy_status", label: "Estado taxonómico" },
      { key: "Ejemplos exactos del Excel", label: "Ejemplos exactos" },
    ],
  },
  {
    name: "B_Taxonomia",
    title: "B · Taxonomía canónica",
    subtitle: "Separación explícita entre dominio, familia, sistema, función, etapa, atributos y frontera producto/variante.",
    rows: canonicalTaxonomy,
    tableName: "CanonicalTaxonomyTable",
    columns: [
      { key: "domain", label: "Dominio" },
      { key: "canonical_family", label: "Familia canónica" },
      { key: "user_intent", label: "Intención de usuario" },
      { key: "system_or_technology", label: "Sistema o tecnología" },
      { key: "function", label: "Función" },
      { key: "usage_stage", label: "Etapa de uso" },
      { key: "canonical_attribute_bundle", label: "Atributos canónicos" },
      { key: "entity_boundary", label: "Frontera producto / variante" },
      { key: "source_rows", label: "Filas fuente" },
      { key: "taxonomy_status", label: "Estado" },
    ],
  },
  {
    name: "C_Reconciliacion",
    title: "C · Catálogo reconciliado — 1.500 filas",
    subtitle: "Cada fila original tiene resultado explícito. Solo EXACTO permite automatización; probable, conflicto e insuficiente quedan bloqueados.",
    rows: sourceReconciliation,
    tableName: "SourceReconciliationTable",
    columns: [
      { key: "source_excel_row", label: "Fila Excel" },
      { key: "source_category", label: "Dominio fuente" },
      { key: "source_family", label: "Familia fuente" },
      { key: "source_brand_normalized", label: "Marca fuente" },
      { key: "source_description", label: "Descripción fuente" },
      { key: "source_code", label: "Código fuente" },
      { key: "source_supplier_code", label: "Código proveedor" },
      { key: "source_supplier", label: "Proveedor" },
      { key: "reconciliation_status", label: "Resultado" },
      { key: "matching_method", label: "Método" },
      { key: "matching_score", label: "Score" },
      { key: "ambiguous_candidate_count", label: "Candidatos ambiguos" },
      { key: "internal_product_id", label: "Producto interno ID" },
      { key: "internal_product_code", label: "Código interno" },
      { key: "internal_brand", label: "Marca interna" },
      { key: "internal_product_name", label: "Producto interno" },
      { key: "internal_variant_id", label: "Variante interna ID" },
      { key: "internal_sku", label: "SKU interno" },
      { key: "internal_variant_name", label: "Variante interna" },
      { key: "decision_reason", label: "Razón" },
      { key: "canonical_write_allowed", label: "Escritura canónica permitida" },
    ],
  },
  {
    name: "D_Cobertura_marcas",
    title: "D · Cobertura por marca",
    subtitle: "Las 185 etiquetas de marca están cuantificadas: fuente oficial capturada, identidad pendiente o levantamiento físico.",
    rows: brandCoverage,
    tableName: "BrandCoverageTable",
    columns: Object.keys(brandCoverage[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "E_Lineas_tonos",
    title: "E · Cobertura de líneas y tonos",
    subtitle: "Inventario externo por línea/colección. Diferencia explícita entre conocido oficialmente, cargado y reconciliado.",
    rows: collectionCoverage,
    tableName: "CollectionCoverageTable",
    columns: Object.keys(collectionCoverage[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "F_No_identificados",
    title: "F · Checklist de no identificados",
    subtitle: "Nada dudoso fue absorbido. Filas y marcas pendientes conservan candidato, motivo, acción y bloqueo de publicación.",
    rows: notIdentifiedRows,
    tableName: "UnidentifiedChecklistTable",
    columns: Object.keys(notIdentifiedRows[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "G_Checklist_foto",
    title: "G · Checklist y plan de sesión fotográfica",
    subtitle: "423 productos agrupables por familia y marca; lista exacta de tomas y etiquetas necesarias por producto.",
    rows: physicalChecklist,
    tableName: "PhotoChecklistTable",
    columns: Object.keys(physicalChecklist[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "H_Inventario_imagenes",
    title: "H · Inventario de imágenes",
    subtitle: "5.787 imágenes oficiales descubiertas y 172 tonos descargados a almacenamiento controlado con SHA-256 y dHash. Publicación aún bloqueada.",
    rows: imageRows,
    tableName: "ImageInventoryTable",
    columns: Object.keys(imageRows[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "I_Relaciones",
    title: "I · Relaciones y compatibilidades candidatas",
    subtitle: "371 relaciones derivadas por reglas de proceso. Ninguna se escribió como compatibilidad canónica sin envase, manual o ficha técnica.",
    rows: relationCandidates,
    tableName: "RelationCandidatesTable",
    columns: Object.keys(relationCandidates[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "J_Excepciones",
    title: "J · Registro maestro de excepciones",
    subtitle: "Fila, tono, marca, imagen y derecho de uso permanecen visibles con severidad, evidencia, acción y gate de publicación.",
    rows: exceptionRegister,
    tableName: "MasterExceptionsTable",
    columns: Object.keys(exceptionRegister[0]).map((key) => ({ key, label: titleCase(key) })),
  },
  {
    name: "Fuentes",
    title: "Fuentes y procedencia",
    subtitle: "URLs oficiales y rutas internas utilizadas. Cada snapshot conserva fecha, adaptador y conteos.",
    rows: sourceRows,
    tableName: "SourcesTable",
    columns: Object.keys(sourceRows[0]).map((key) => ({ key, label: titleCase(key) })),
  },
];

for (const spec of specs) addDataSheet(workbook, spec);

summary.showGridLines = false;
summary.getRange("A1:L1").merge();
summary.getRange("A1").values = [["BELLAROSHÉ · BASE MAESTRA DE ENRIQUECIMIENTO Y RECONCILIACIÓN"]];
summary.getRange("A2:L2").merge();
summary.getRange("A2").values = [[`Corte ${CUTOFF} · evidencia primero · 0 asociaciones inciertas publicadas`]];
summary.getRange("A1:L1").format = { fill: palette.ink, font: { bold: true, color: palette.white, size: 19 }, verticalAlignment: "center" };
summary.getRange("A2:L2").format = { fill: palette.wine, font: { color: palette.white, italic: true, size: 10 }, verticalAlignment: "center" };
summary.getRange("A4:D4").values = [["Métrica", "Resultado", "Gate", "Lectura"]];
summary.getRange("A4:D4").format = { fill: palette.wineDark, font: { bold: true, color: palette.white }, borders: { preset: "all", style: "thin", color: palette.sand } };

const metricRows = [
  ["Filas fuente con resultado", `=COUNTA('C_Reconciliacion'!$A$5:$A$${sourceReconciliation.length + 4})`, "100%", "Cada una de las 1.500 filas tiene salida explícita."],
  ["Conciliaciones EXACTO", `=COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"EXACTO")`, "Automatizable", "La única clase habilitada para escritura automática."],
  ["Filas bloqueadas", `=COUNTA('C_Reconciliacion'!$A$5:$A$${sourceReconciliation.length + 4})-COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"EXACTO")`, "No publicar", "Probables, conflictos e insuficientes."],
  ["Marcas internas", `=COUNTA('D_Cobertura_marcas'!$A$5:$A$${brandCoverage.length + 4})`, "100% con estado", "No equivale a 100% investigado oficialmente."],
  ["Marcas con captura oficial masiva", `=COUNTIF('D_Cobertura_marcas'!$C$5:$C$${brandCoverage.length + 4},"FUENTE_OFICIAL_CAPTURADA")`, "6 / 185", "Masglo, Admiss, AcryLove, MC Nails, Cherimoya y Bigen."],
  ["Productos oficiales inventariados", reconciliationMetrics.official_products, "RAW auditable", "No se importan directamente al catálogo canónico."],
  ["Variantes oficiales inventariadas", reconciliationMetrics.official_variants, "RAW auditable", "Códigos, títulos y URLs conservados."],
  ["Imágenes oficiales inventariadas", reconciliationMetrics.official_images, "Descubiertas", "La mayoría aún no está persistida en almacenamiento controlado."],
  ["Tonos internos", reconciliationMetrics.internal_tones, "253", "Masglo, Admiss y Bigen."],
  ["Tonos exactos en fuente oficial actual", reconciliationMetrics.tone_matches_confirmed, "172", "Coincidencia exacta por nombre normalizado o código oficial."],
  ["Imágenes de tono descargadas", mediaMetrics.official_tone_images_ready_for_download, "172 / 172", "Descargadas, normalizadas, hasheadas; aprobación humana pendiente."],
  ["Productos en checklist físico", mediaMetrics.physical_products_in_checklist, "423", "Tomas y etiquetas exactas agrupadas para tienda."],
  ["Relaciones candidatas", enrichmentMetrics.relation_candidates, "0 promovidas", "Reglas útiles, compatibilidad técnica aún no confirmada."],
  ["Excepciones abiertas", masterMetrics.open_exception_rows, "0 silenciosas", "Incluye filas, marcas, tonos, imágenes y derechos."],
];
summary.getRange(`A5:D${metricRows.length + 4}`).values = metricRows;
summary.getRange(`A5:D${metricRows.length + 4}`).format = {
  fill: palette.cream,
  font: { color: palette.ink, size: 10 },
  wrapText: true,
  verticalAlignment: "top",
  borders: { preset: "all", style: "thin", color: palette.sand },
};
summary.getRange(`B5:B${metricRows.length + 4}`).format = { font: { bold: true, color: palette.wineDark, size: 12 }, horizontalAlignment: "center" };
summary.getRange("A20:D20").merge();
summary.getRange("A20").values = [["Lectura correcta: este bloque construye evidencia, colas y gates. No declara investigadas oficialmente las 185 marcas ni publica imágenes o relaciones pendientes."]];
summary.getRange("A20:D20").format = { fill: palette.amber, font: { bold: true, color: palette.amberInk }, wrapText: true };

summary.getRange("F4:G4").values = [["Reconciliación", "Filas"]];
summary.getRange("F5:G8").values = [
  ["EXACTO", sourceMetrics.source_rows ? 0 : 0],
  ["PROBABLE", 0],
  ["CONFLICTO", 0],
  ["INSUFICIENTE", 0],
];
summary.getRange("G5:G8").formulas = [
  [`=COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"EXACTO")`],
  [`=COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"PROBABLE_EXISTENTE")`],
  [`=COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"CONFLICTO")`],
  [`=COUNTIF('C_Reconciliacion'!$I$5:$I$${sourceReconciliation.length + 4},"INSUFICIENTE")`],
];
summary.getRange("F11:G11").values = [["Imágenes", "Variantes"]];
summary.getRange("F12:G16").values = [
  ["Oficial exacta", mediaMetrics.official_tone_images_ready_for_download],
  ["Producto oficial por validar", mediaMetrics.official_product_images_need_variant_validation],
  ["Activo interno por auditar", mediaMetrics.internal_assets_need_audit],
  ["Fotografía propia", mediaMetrics.requires_own_photography],
  ["Identidad pendiente", mediaMetrics.identity_must_be_resolved_first],
];
summary.getRange("F4:G8").format = { fill: palette.cream, borders: { preset: "all", style: "thin", color: palette.sand } };
summary.getRange("F11:G16").format = { fill: palette.cream, borders: { preset: "all", style: "thin", color: palette.sand } };
summary.getRange("F4:G4").format = { fill: palette.wine, font: { bold: true, color: palette.white } };
summary.getRange("F11:G11").format = { fill: palette.wine, font: { bold: true, color: palette.white } };

const reconcileChart = summary.charts.add("doughnut", summary.getRange("F4:G8"));
reconcileChart.title = "1.500 filas: resultado de reconciliación";
reconcileChart.hasLegend = true;
reconcileChart.setPosition("I4", "L16");
const imageChart = summary.charts.add("bar", summary.getRange("F11:G16"));
imageChart.title = "Clasificación de imagen por variante";
imageChart.hasLegend = false;
imageChart.setPosition("F18", "L32");

summary.getRange("A1:L32").format.font = { name: "Aptos", color: palette.ink };
summary.getRange("A1:L1").format.font = { name: "Georgia", bold: true, color: palette.white, size: 19 };
summary.getRange("A2:L2").format.font = { name: "Aptos", italic: true, color: palette.white, size: 10 };
summary.getRange("A:A").format.columnWidth = 29;
summary.getRange("B:B").format.columnWidth = 15;
summary.getRange("C:C").format.columnWidth = 17;
summary.getRange("D:D").format.columnWidth = 38;
summary.getRange("E:E").format.columnWidth = 3;
summary.getRange("F:F").format.columnWidth = 25;
summary.getRange("G:G").format.columnWidth = 13;
summary.getRange("H:H").format.columnWidth = 3;
summary.getRange("I:L").format.columnWidth = 14;
summary.getRange("1:1").format.rowHeight = 38;
summary.getRange("2:2").format.rowHeight = 26;
summary.getRange("20:20").format.rowHeight = 42;
summary.freezePanes.freezeRows(2);

await fs.mkdir(PREVIEW_DIR, { recursive: true });
const renderRanges = {
  "00_Resumen": "A1:L32",
  "A_Arbol_maestro": "A1:F28",
  "B_Taxonomia": "A1:J24",
  "C_Reconciliacion": "A1:U18",
  "D_Cobertura_marcas": "A1:T22",
  "E_Lineas_tonos": "A1:L24",
  "F_No_identificados": "A1:J22",
  "G_Checklist_foto": "A1:L20",
  "H_Inventario_imagenes": "A1:P18",
  "I_Relaciones": "A1:P20",
  "J_Excepciones": "A1:J20",
  "Fuentes": "A1:I16",
};

const inspection = await workbook.inspect({ kind: "workbook,sheet,table,formula", maxChars: 20000, tableMaxRows: 5, tableMaxCols: 8, tableMaxCellChars: 100 });
await fs.writeFile(path.join(OUTPUT_DIR, "workbook-inspection.ndjson"), inspection.ndjson, "utf8");

const formulaErrors = [];
for (const sheetName of Object.keys(renderRanges)) {
  const sheet = workbook.worksheets.getItem(sheetName);
  const used = sheet.getUsedRange(true);
  for (const [rowIndex, row] of used.values.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      if (typeof value === "string" && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(value)) {
        formulaErrors.push({ sheetName, row: rowIndex + 1, column: columnIndex + 1, value });
      }
    }
  }
  const preview = await workbook.render({ sheetName, range: renderRanges[sheetName], scale: sheetName === "00_Resumen" ? 1 : 0.8, format: "png" });
  await fs.writeFile(path.join(PREVIEW_DIR, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

await fs.writeFile(path.join(OUTPUT_DIR, "workbook-formula-errors.json"), JSON.stringify(formulaErrors, null, 2));
if (formulaErrors.length) throw new Error(`Workbook contains ${formulaErrors.length} formula errors.`);

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(OUTPUT_PATH);
console.log(JSON.stringify({
  outputPath: OUTPUT_PATH,
  sheets: Object.keys(renderRanges).length,
  formulaErrors: formulaErrors.length,
  metrics: {
    sourceRows: sourceReconciliation.length,
    brands: brandCoverage.length,
    officialImages: officialImageInventory.length,
    verifiedDownloads: verifiedManifest.length,
    relations: relationCandidates.length,
    exceptions: exceptionRegister.length,
  },
}, null, 2));
