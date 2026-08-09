// Auditor permanente del catálogo real: compara fuente original → staging →
// catálogo definitivo y emite evidencia re-ejecutable. No corrige nada: audita.
//
//   npm run audit:catalog-real
//
// Salidas (versionables) en docs/evidencia-certificacion-1c/:
//   conciliacion-1500.csv   una fila por fila original del Excel (sección C)
//   auditoria.json          checks E, tonos K, familias L, esmaltes F, ecuación
//   auditoria.md            resumen humano del mismo contenido
//
// Estados finales admitidos al cierre: IMPORTED · MERGED_CONFIRMED ·
// DUPLICATE_CONFIRMED · EXCLUDED_CONFIRMED. Todo lo demás cuenta como PENDING
// y el auditor lo dice sin suavizarlo.

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "audit-catalog-real", allowedFlags: ["--listado"] });
if (!isLocal) throw new Error("El auditor certifica el catálogo LOCAL.");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const { parseCatalogXlsxRaw } = await import("../src/lib/admin/catalog-import-xlsx.ts");
const { mapListingRows } = await import("../src/lib/admin/catalog-bulk-import/normalize.ts");
const { bulkFamilyConfig } = await import("../src/lib/admin/catalog-bulk-import/family-map.ts");

const args = process.argv.slice(2);
const listadoIndex = args.indexOf("--listado");
const LISTADO = listadoIndex >= 0 ? args[listadoIndex + 1] : "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\Listado_organizado_productos_Bellaroshe.xlsx";
const CURATED_MASGLO = "F:\\Products_SIVAN\\Bellaroshe\\version-V2\\products\\01-masglo-tradicional\\plantilla_importacion_masglo_tradicional_sku_oficial_precios.xlsx";
const OUT_DIR = path.join(root, "docs", "evidencia-certificacion-1c");
await fs.mkdir(OUT_DIR, { recursive: true });

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all(table, select, filter) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = service.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// ---------------------------------------------------------------------------
// Cargar fuente, staging y catálogo
// ---------------------------------------------------------------------------
const bytes = await fs.readFile(LISTADO);
const workbook = await parseCatalogXlsxRaw({ name: path.basename(LISTADO), size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const { rows: sourceRows } = mapListingRows(workbook.sheets);

const batches = await all("import_batches", "id, source_name, status, created_at, summary", (q) => q.like("source_name", "bulk_catalog_v2:%"));
const batchById = new Map(batches.map((b) => [String(b.id), b]));
const stagingRows = await all("import_rows", "id, batch_id, row_number, status, proposed_action, target_product_id, target_variant_id, normalized_data, import_issues(id, issue_code, severity, status, message, resolution)", (q) => q.in("batch_id", batches.map((b) => b.id)));

const products = await all("products", "id, code, slug, name, presentation, brand_id, category_id, template_id, editorial_status, is_active, media_backfill, created_at");
const variants = await all("product_variants", "id, product_id, sku, name, variant_key, is_default, is_active, color_shade_id, media_backfill");
const offers = await all("product_suppliers", "id, supplier_id, variant_id, supplier_sku, is_active, is_preferred");
const suppliers = await all("suppliers", "id, code, trade_name");
const brands = await all("brands", "id, name, slug, is_generic, is_active");
const categories = await all("categories", "id, name, slug, parent_id, template_id");
const templates = await all("attribute_templates", "id, code, name");
const shades = await all("color_shades", "id, brand_id, product_line_id, name, code, reference_color, color_family_option_id, tone_option_id");
const productMedia = await all("product_media", "id, product_id, variant_id, media_role, is_primary");
const familyOptions = await all("attribute_options", "id, value, label, attribute_definitions!inner(code)", (q) => q.eq("attribute_definitions.code", "color_family"));

const brandById = new Map(brands.map((b) => [String(b.id), b]));
const productById = new Map(products.map((p) => [String(p.id), p]));
const variantById = new Map(variants.map((v) => [String(v.id), v]));
const supplierById = new Map(suppliers.map((s) => [String(s.id), s]));
const categoryById = new Map(categories.map((c) => [String(c.id), c]));
const templateById = new Map(templates.map((t) => [String(t.id), t]));
const familyOptionById = new Map(familyOptions.map((o) => [String(o.id), o]));
const variantsByProduct = new Map();
for (const v of variants) variantsByProduct.set(String(v.product_id), [...(variantsByProduct.get(String(v.product_id)) ?? []), v]);
const offersByVariant = new Map();
for (const o of offers) offersByVariant.set(String(o.variant_id), [...(offersByVariant.get(String(o.variant_id)) ?? []), o]);
const mediaByVariant = new Map();
const mediaByProduct = new Map();
for (const m of productMedia) {
  if (m.variant_id) mediaByVariant.set(String(m.variant_id), [...(mediaByVariant.get(String(m.variant_id)) ?? []), m]);
  if (m.product_id) mediaByProduct.set(String(m.product_id), [...(mediaByProduct.get(String(m.product_id)) ?? []), m]);
}

// ---------------------------------------------------------------------------
// C · Conciliación: exactamente una fila por fila original
// ---------------------------------------------------------------------------
const RANK = { committed: 4, needs_review: 3, skipped: 2, approved: 1, normalized: 1, failed: 0 };
const bestByRow = new Map();
// La decisión humana pertenece a la FILA del Excel, no a una copia concreta:
// se hereda desde cualquier copia que la tenga registrada.
const decisionByRow = new Map();
for (const r of stagingRows) {
  const current = bestByRow.get(r.row_number);
  if (!current || (RANK[r.status] ?? 0) > (RANK[current.status] ?? 0)) bestByRow.set(r.row_number, r);
  for (const issue of r.import_issues ?? []) {
    const resolution = issue.resolution;
    if (resolution && typeof resolution === "object" && resolution.decision && ["confirm_duplicate", "exclude", "merge_into_existing"].includes(resolution.decision)) {
      decisionByRow.set(r.row_number, { decision: resolution.decision, motivo: resolution.motivo ?? "" });
    }
  }
}

function finalState(st) {
  if (!st) return { estado: "SIN_STAGING", decision: "", motivo: "" };
  const issues = st.import_issues ?? [];
  const resolved = issues.find((i) => i.resolution && typeof i.resolution === "object" && i.resolution.decision);
  const inherited = decisionByRow.get(st.row_number);
  const decision = resolved?.resolution?.decision ?? inherited?.decision ?? "";
  const motivo = resolved?.resolution?.motivo ?? inherited?.motivo ?? "";
  if (st.status === "committed") {
    if (decision === "merge_into_existing") return { estado: "MERGED_CONFIRMED", decision, motivo };
    return { estado: "IMPORTED", decision, motivo };
  }
  // La decisión heredada manda sobre el estado de la copia que se esté mirando:
  // una copia rezagada en needs_review no revive una fila ya decidida.
  if (decision === "exclude") return { estado: "EXCLUDED_CONFIRMED", decision, motivo };
  if (decision === "confirm_duplicate") return { estado: "DUPLICATE_CONFIRMED", decision, motivo };
  if (st.status === "skipped") {
    const auto = (st.normalized_data?.review ?? []).join(" · ");
    // Skips del pipeline: duplicado exacto o fila cubierta por otro lote.
    if (/ya importada|ya está importad|Duplicado exacto|Decisión previa/i.test(auto)) return { estado: "DUPLICATE_CONFIRMED", decision: "regla_identidad", motivo: auto };
    return { estado: "PENDING", decision: "", motivo: auto || "skip sin decisión registrada" };
  }
  return { estado: "PENDING", decision: "", motivo: (st.normalized_data?.review ?? []).join(" · ") };
}

const conciliacion = [];
for (const src of sourceRows) {
  const st = bestByRow.get(src.row);
  const { estado, decision, motivo } = finalState(st);
  const variant = st?.target_variant_id ? variantById.get(String(st.target_variant_id)) : null;
  const product = st?.target_product_id ? productById.get(String(st.target_product_id)) : null;
  const offer = variant ? (offersByVariant.get(String(variant.id)) ?? []).find((o) => {
    const s = supplierById.get(String(o.supplier_id));
    return s && src.proveedor && s.trade_name.toLowerCase() === src.proveedor.trim().toLowerCase();
  }) : null;
  const issue = (st?.import_issues ?? []).filter((i) => i.severity === "error" || i.severity === "blocking").map((i) => i.issue_code).join(";");
  conciliacion.push({
    hoja: "Catálogo organizado",
    fila: src.row,
    codigo_interno: src.codigo ?? "",
    codigo_proveedor: src.codigoProveedor ?? "",
    proveedor: src.proveedor ?? "",
    marca: src.marca ?? "",
    descripcion: src.descripcion ?? "",
    familia: src.familia ?? "",
    estado_final: estado,
    product_id: product?.id ?? "",
    codigo_producto: product?.code ?? "",
    variant_id: variant?.id ?? "",
    sku: variant?.sku ?? "",
    supplier_offer_id: offer?.id ?? "",
    decision,
    issue,
    motivo: motivo.slice(0, 300)
  });
}
const porEstado = {};
for (const c of conciliacion) porEstado[c.estado_final] = (porEstado[c.estado_final] ?? 0) + 1;
const ecuacion = {
  filas: conciliacion.length,
  IMPORTED: porEstado.IMPORTED ?? 0,
  MERGED_CONFIRMED: porEstado.MERGED_CONFIRMED ?? 0,
  DUPLICATE_CONFIRMED: porEstado.DUPLICATE_CONFIRMED ?? 0,
  EXCLUDED_CONFIRMED: porEstado.EXCLUDED_CONFIRMED ?? 0,
  PENDING: (porEstado.PENDING ?? 0) + (porEstado.SIN_STAGING ?? 0),
  cierra: null
};
ecuacion.cierra = ecuacion.filas === ecuacion.IMPORTED + ecuacion.MERGED_CONFIRMED + ecuacion.DUPLICATE_CONFIRMED + ecuacion.EXCLUDED_CONFIRMED && ecuacion.PENDING === 0;

// ---------------------------------------------------------------------------
// E · Auditoría global de productos
// ---------------------------------------------------------------------------
const normalizeKey = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const importTrail = new Set(stagingRows.filter((r) => r.status === "committed").flatMap((r) => [String(r.target_product_id ?? ""), String(r.target_variant_id ?? "")]));
const firstImportAt = batches.length ? Math.min(...batches.map((b) => Date.parse(b.created_at))) : Date.now();

const checks = {};
checks.producto_activo_sin_variante_activa = products.filter((p) => p.is_active && !(variantsByProduct.get(String(p.id)) ?? []).some((v) => v.is_active)).map((p) => p.code);
checks.default_distinto_de_uno = products.filter((p) => {
  const activas = (variantsByProduct.get(String(p.id)) ?? []).filter((v) => v.is_active);
  return activas.length > 0 && activas.filter((v) => v.is_default).length !== 1;
}).map((p) => p.code);
{
  const bySku = new Map();
  for (const v of variants) if (v.sku) bySku.set(v.sku.toLowerCase(), [...(bySku.get(v.sku.toLowerCase()) ?? []), v]);
  checks.sku_duplicado = [...bySku.entries()].filter(([, l]) => l.length > 1).map(([k]) => k);
}
{
  const byInternal = new Map();
  for (const r of stagingRows) {
    if (r.status !== "committed") continue;
    const code = r.normalized_data?.identity?.internalCode;
    if (!code || !r.target_variant_id) continue;
    byInternal.set(code, new Set([...(byInternal.get(code) ?? []), String(r.target_variant_id)]));
  }
  checks.codigo_interno_en_dos_variantes = [...byInternal.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}→${s.size}`);
}
{
  const byOffer = new Map();
  const bySupplierSku = new Map();
  for (const o of offers) {
    const k1 = `${o.supplier_id}|${o.variant_id}`;
    byOffer.set(k1, (byOffer.get(k1) ?? 0) + 1);
    if (o.supplier_sku) {
      const k2 = `${o.supplier_id}|${o.supplier_sku.toLowerCase()}`;
      bySupplierSku.set(k2, (bySupplierSku.get(k2) ?? 0) + 1);
    }
  }
  checks.oferta_identica_duplicada = [...byOffer.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  checks.supplier_sku_duplicado = [...bySupplierSku.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}
checks.variante_huerfana = variants.filter((v) => !productById.has(String(v.product_id))).map((v) => v.sku ?? v.id);
// Un producto desactivado tras una fusión documentada puede quedar vacío: el
// huérfano que bloquea es el ACTIVO sin ninguna variante.
checks.producto_sin_ninguna_variante = products.filter((p) => p.is_active && !(variantsByProduct.get(String(p.id)) ?? []).length).map((p) => p.code);
// Los productos demo previos a la importación no forman parte del objeto
// certificado: se reportan aparte, no como fallo de la carga.
const esPreImportacion = (p) => Date.parse(p.created_at) < firstImportAt && !importTrail.has(String(p.id));
checks.producto_template_categoria_incompatible = products.filter((p) => {
  if (esPreImportacion(p)) return false;
  const cat = categoryById.get(String(p.category_id));
  return cat?.template_id && String(cat.template_id) !== String(p.template_id);
}).map((p) => p.code);
checks._preexistentes_fuera_de_alcance = [];
for (const p of products.filter(esPreImportacion)) {
  const cat = categoryById.get(String(p.category_id));
  if (cat?.template_id && String(cat.template_id) !== String(p.template_id)) checks._preexistentes_fuera_de_alcance.push(p.code);
}
checks.marca_inexistente = products.filter((p) => !brandById.has(String(p.brand_id))).map((p) => p.code);
checks.categoria_inexistente = products.filter((p) => !categoryById.has(String(p.category_id))).map((p) => p.code);
{
  const dupTrivial = [];
  for (const [pid, list] of variantsByProduct) {
    const byNorm = new Map();
    for (const v of list.filter((v) => v.is_active)) {
      const k = normalizeKey(v.variant_key);
      byNorm.set(k, [...(byNorm.get(k) ?? []), v]);
    }
    for (const [k, l] of byNorm) if (l.length > 1) dupTrivial.push(`${productById.get(pid)?.code}·${k}×${l.length}`);
  }
  checks.variante_duplicada_trivial = dupTrivial;
}
checks.fila_committed_sin_destino = stagingRows.filter((r) => r.status === "committed" && (!r.target_product_id || !r.target_variant_id)).map((r) => r.row_number);
checks.destino_import_sin_trazabilidad = products.filter((p) => p.is_active && Date.parse(p.created_at) >= firstImportAt && !importTrail.has(String(p.id))).map((p) => p.code);
// Las claves con «_» son informativas (fuera del alcance certificado), no gates.
const checksFallidos = Object.entries(checks).filter(([k, v]) => !k.startsWith("_") && v.length > 0);

// ---------------------------------------------------------------------------
// K · Auditoría de tonos
// ---------------------------------------------------------------------------
const shadeById = new Map(shades.map((s) => [String(s.id), s]));
const toneAudit = { total: variants.filter((v) => v.color_shade_id).length, porMarca: {}, incoherencias: [], hexSinFuente: [], shadesDuplicados: [], medios: { foto_variante: 0, swatch_archivo: 0, fallback_color: 0, pendiente: 0 } };
{
  const scope = new Map();
  for (const s of shades) {
    const k = `${s.brand_id}|${s.product_line_id ?? ""}|${s.code.toLowerCase()}`;
    scope.set(k, (scope.get(k) ?? 0) + 1);
  }
  toneAudit.shadesDuplicados = [...scope.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}
for (const v of variants) {
  if (!v.color_shade_id) continue;
  const shade = shadeById.get(String(v.color_shade_id));
  const product = productById.get(String(v.product_id));
  const brand = product ? brandById.get(String(product.brand_id)) : null;
  const marca = brand?.name ?? "?";
  toneAudit.porMarca[marca] = (toneAudit.porMarca[marca] ?? 0) + 1;
  if (shade && product && String(shade.brand_id) !== String(product.brand_id)) {
    toneAudit.incoherencias.push(`${v.sku ?? v.id}: shade de otra marca`);
  }
  const media = mediaByVariant.get(String(v.id)) ?? [];
  if (media.some((m) => m.media_role === "main")) toneAudit.medios.foto_variante += 1;
  else if (media.some((m) => m.media_role === "swatch")) toneAudit.medios.swatch_archivo += 1;
  else if (v.media_backfill === "color") toneAudit.medios.fallback_color += 1;
  else toneAudit.medios.pendiente += 1;
}
// Deuda de medios global (todas las variantes y productos, catálogo ≠ stock).
toneAudit.deudaGlobal = {
  variantes_con_foto_o_swatch: variants.filter((v) => (mediaByVariant.get(String(v.id)) ?? []).length > 0).length,
  variantes_fallback_color: variants.filter((v) => v.media_backfill === "color").length,
  variantes_pendientes: variants.filter((v) => v.media_backfill === "pending").length,
  productos_con_media: products.filter((p) => (mediaByProduct.get(String(p.id)) ?? []).length > 0).length,
  productos_pendientes: products.filter((p) => p.media_backfill === "pending").length
};
const porClasificar = familyOptions.find((o) => o.value === "por-clasificar");
toneAudit.familia_por_clasificar = shades.filter((s) => porClasificar && String(s.color_family_option_id) === String(porClasificar.id)).length;
toneAudit.hexSinFuente = shades.filter((s) => s.reference_color && porClasificar && String(s.color_family_option_id) === String(porClasificar.id)).map((s) => s.code);

// ---------------------------------------------------------------------------
// F · Inventario de líneas de esmalte (expected desde fuentes declaradas)
// ---------------------------------------------------------------------------
let curatedMasglo = null;
try {
  const curatedBytes = await fs.readFile(CURATED_MASGLO);
  const curatedWb = await parseCatalogXlsxRaw({ name: path.basename(CURATED_MASGLO), size: curatedBytes.length, arrayBuffer: async () => curatedBytes.buffer.slice(curatedBytes.byteOffset, curatedBytes.byteOffset + curatedBytes.byteLength) });
  const tonos = (curatedWb.sheets["Tonos"] ?? []).slice(1).filter((r) => r.cells.some((c) => c !== null && String(c).trim() !== ""));
  const variantes = (curatedWb.sheets["Variantes"] ?? []).slice(1).filter((r) => r.cells.some((c) => c !== null && String(c).trim() !== ""));
  curatedMasglo = { archivo: CURATED_MASGLO, tonos: tonos.length, variantes: variantes.length };
} catch {
  curatedMasglo = null;
}

const ESMALTE_TEMPLATES = new Set(templates.filter((t) => ["ESMALTE_TONOS"].includes(t.code)).map((t) => String(t.id)));
const esmalteLines = [];
{
  const byLine = new Map();
  for (const p of products.filter((p) => ESMALTE_TEMPLATES.has(String(p.template_id)))) {
    const brand = brandById.get(String(p.brand_id));
    const key = `${brand?.name ?? "?"}|${p.name}|${p.presentation ?? "?"}`;
    const vs = (variantsByProduct.get(String(p.id)) ?? []).filter((v) => v.is_active);
    const tonos = vs.filter((v) => v.color_shade_id);
    byLine.set(key, {
      marca: brand?.name ?? "?",
      producto: p.name,
      codigo: p.code,
      presentacion: p.presentation ?? "?",
      variantes: vs.length,
      tonos: tonos.length,
      conFoto: vs.filter((v) => (mediaByVariant.get(String(v.id)) ?? []).length > 0).length,
      fallback: vs.filter((v) => v.media_backfill === "color").length,
      pendientes: vs.filter((v) => v.media_backfill === "pending").length
    });
  }
  esmalteLines.push(...[...byLine.values()].sort((a, b) => b.tonos - a.tonos));
}

// ---------------------------------------------------------------------------
// L · Matriz de familias + cola de anomalías
// ---------------------------------------------------------------------------
const familias = new Map();
for (const src of sourceRows) {
  const fam = src.familia ?? "(sin familia)";
  const entry = familias.get(fam) ?? { filas: 0, importadas: 0, revision: 0, productos: new Set(), variantes: new Set(), issues: 0 };
  entry.filas += 1;
  const st = bestByRow.get(src.row);
  if (st?.status === "committed") {
    entry.importadas += 1;
    if (st.target_product_id) entry.productos.add(String(st.target_product_id));
    if (st.target_variant_id) entry.variantes.add(String(st.target_variant_id));
  }
  if (st?.status === "needs_review") entry.revision += 1;
  entry.issues += (st?.import_issues ?? []).filter((i) => i.status === "open" && (i.severity === "error" || i.severity === "blocking")).length;
  familias.set(fam, entry);
}
const familiaMatrix = [...familias.entries()].map(([familia, e]) => ({
  familia,
  filas: e.filas,
  importadas: e.importadas,
  productos: e.productos.size,
  variantes: e.variantes.size,
  revision: e.revision,
  issues: e.issues,
  mapeada: Boolean(bulkFamilyConfig(familia))
})).sort((a, b) => b.filas - a.filas);

const anomalias = [];
for (const f of familiaMatrix) {
  if (!f.mapeada && f.familia !== "Revisión manual") anomalias.push({ tipo: "familia_sin_mapa", familia: f.familia });
  if (f.importadas > 0 && f.productos === 0) anomalias.push({ tipo: "importadas_sin_productos", familia: f.familia });
  const ratio = f.productos ? f.variantes / f.productos : 0;
  if (f.productos >= 5 && ratio > 12) anomalias.push({ tipo: "ratio_variante_producto_alto", familia: f.familia, ratio: Number(ratio.toFixed(1)) });
  if (f.filas >= 10 && f.productos > 0 && f.productos === f.variantes && f.filas > f.productos * 1.5) {
    anomalias.push({ tipo: "posible_agrupacion_perdida", familia: f.familia, filas: f.filas, productos: f.productos });
  }
}
{
  // Marcas fragmentadas por ortografía (solo activas: una fusión resuelta deja
  // la marca perdedora desactivada, documentada en anomalias-resueltas.json).
  const byNorm = new Map();
  for (const b of brands.filter((b) => b.is_active !== false)) {
    const k = normalizeKey(b.name).replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
    byNorm.set(k, [...(byNorm.get(k) ?? []), b.name]);
  }
  for (const [k, list] of byNorm) if (list.length > 1) anomalias.push({ tipo: "marca_fragmentada", variantes: list });
  // Productos con nombre casi idéntico dentro de la misma marca (solo activos)
  const byProductNorm = new Map();
  for (const p of products.filter((p) => p.is_active)) {
    const k = `${p.brand_id}|${normalizeKey(p.name)}`;
    byProductNorm.set(k, [...(byProductNorm.get(k) ?? []), p.code]);
  }
  for (const [, list] of byProductNorm) if (list.length > 1) anomalias.push({ tipo: "producto_nombre_casi_identico", codigos: list });
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------
const csvEscape = (value) => {
  const s = String(value ?? "");
  return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const headers = Object.keys(conciliacion[0]);
const csv = [headers.join(","), ...conciliacion.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n");
await fs.writeFile(path.join(OUT_DIR, "conciliacion-1500.csv"), "\ufeff" + csv, "utf8");

const reporte = {
  generado: new Date().toISOString(),
  fuente: { listado: LISTADO, filas: sourceRows.length, curatedMasglo },
  ecuacion,
  catalogo: {
    productos: products.length,
    variantes: variants.length,
    ofertas: offers.length,
    marcas: brands.length,
    proveedores: suppliers.length,
    tonos: shades.length
  },
  checksE: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { fallos: v.length, ejemplos: v.slice(0, 10) }])),
  checksE_ok: checksFallidos.length === 0,
  tonosK: toneAudit,
  esmaltesF: esmalteLines,
  familiasL: familiaMatrix,
  anomaliasL: anomalias,
  pendientes: conciliacion.filter((c) => c.estado_final === "PENDING" || c.estado_final === "SIN_STAGING").map((c) => ({ fila: c.fila, motivo: c.motivo, issue: c.issue }))
};
await fs.writeFile(path.join(OUT_DIR, "auditoria.json"), JSON.stringify(reporte, null, 2), "utf8");

const md = [];
md.push(`# Auditoría del catálogo real — ${reporte.generado}`);
md.push(`\nFuente: ${sourceRows.length} filas de ${path.basename(LISTADO)}.`);
md.push(`\n## Ecuación de conciliación (C)\n`);
md.push(`| Filas | IMPORTED | MERGED | DUPLICATE | EXCLUDED | PENDING | ¿Cierra? |`);
md.push(`|---:|---:|---:|---:|---:|---:|:--|`);
md.push(`| ${ecuacion.filas} | ${ecuacion.IMPORTED} | ${ecuacion.MERGED_CONFIRMED} | ${ecuacion.DUPLICATE_CONFIRMED} | ${ecuacion.EXCLUDED_CONFIRMED} | ${ecuacion.PENDING} | ${ecuacion.cierra ? "✅ SÍ" : "❌ NO"} |`);
md.push(`\n## Checks globales (E): ${checksFallidos.length === 0 ? "✅ todos en cero" : `❌ ${checksFallidos.length} con fallos`}\n`);
for (const [k, v] of Object.entries(checks)) md.push(`- ${v.length === 0 ? "✅" : "❌"} ${k}: ${v.length}${v.length ? ` — ${v.slice(0, 5).join(", ")}` : ""}`);
md.push(`\n## Tonos (K)\n`);
md.push(`- Variantes con tono: ${toneAudit.total} · shades: ${shades.length} · familia «Por clasificar»: ${toneAudit.familia_por_clasificar}`);
md.push(`- Medios de tonos: foto ${toneAudit.medios.foto_variante} · swatch ${toneAudit.medios.swatch_archivo} · fallback color ${toneAudit.medios.fallback_color} · pendientes ${toneAudit.medios.pendiente}`);
md.push(`- Incoherencias marca/shade: ${toneAudit.incoherencias.length} · shades duplicados: ${toneAudit.shadesDuplicados.length} · hex sin fuente: ${toneAudit.hexSinFuente.length}`);
md.push(`\n## Líneas de esmalte (F)\n`);
md.push(`| Marca | Producto | Presentación | Variantes | Tonos | Foto | Fallback | Pendientes |`);
md.push(`|---|---|---|---:|---:|---:|---:|---:|`);
for (const l of esmalteLines) md.push(`| ${l.marca} | ${l.producto} | ${l.presentacion} | ${l.variantes} | ${l.tonos} | ${l.conFoto} | ${l.fallback} | ${l.pendientes} |`);
md.push(`\n## Familias (L)\n`);
md.push(`| Familia | Filas | Importadas | Productos | Variantes | Revisión | Issues |`);
md.push(`|---|---:|---:|---:|---:|---:|---:|`);
for (const f of familiaMatrix) md.push(`| ${f.familia} | ${f.filas} | ${f.importadas} | ${f.productos} | ${f.variantes} | ${f.revision} | ${f.issues} |`);
md.push(`\n## Cola de anomalías (L): ${anomalias.length}\n`);
for (const a of anomalias.slice(0, 60)) md.push(`- ${JSON.stringify(a)}`);
if (reporte.pendientes.length) {
  md.push(`\n## PENDIENTES (${reporte.pendientes.length}) — bloquean el cierre\n`);
  for (const p of reporte.pendientes) md.push(`- Fila ${p.fila} [${p.issue}]: ${p.motivo}`);
}
await fs.writeFile(path.join(OUT_DIR, "auditoria.md"), md.join("\n"), "utf8");

console.log(JSON.stringify({ ecuacion, checksE_ok: checksFallidos.length === 0, checksFallidos: checksFallidos.map(([k, v]) => `${k}:${v.length}`), anomalias: anomalias.length, pendientes: reporte.pendientes.length, salidas: ["conciliacion-1500.csv", "auditoria.json", "auditoria.md"] }, null, 2));
