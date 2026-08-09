// Genera el expediente de decisiones para las excepciones pendientes de la
// certificación 1C, aplicando la política acordada por grupo (D1–D4) con la
// evidencia de cada fila y de su fila espejo. El archivo resultante es el
// registro humano-revisable ANTES de aplicarse con resolve-bulk-decisions.
//
//   node scripts/build-decisiones-67.mjs --env .env.supabase.local
//
// Política:
//   D1 same_supplier_different_codes → import_distinct (Ref. código propio).
//   D2 duplicate_supplier_code → descripción idéntica a la espejo: confirm_duplicate;
//      distinta: import_distinct sin supplier_sku (código compartido queda en la 1.ª).
//   D3 conflicting_internal_codes → import_distinct (el código interno ES la identidad).
//   D4 family_unmapped → PEGAMENTO GOLLE reclassify a adhesivos de uñas; fila sin
//      descripción y descripciones no clasificables → exclude explícito.

import path from "node:path";
import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "build-decisiones-67" });
if (!isLocal) throw new Error("Solo local.");
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

// Filas pendientes por MEJOR estado (ningún lote las tiene committed).
const { data: batches } = await service.from("import_batches").select("id, source_name").like("source_name", "bulk_catalog_v2:%");
const batchIds = batches.map((b) => b.id);
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await service
    .from("import_rows")
    .select("id, batch_id, row_number, status, raw_data, normalized_data, import_issues(issue_code, severity, status, message)")
    .in("batch_id", batchIds)
    .range(from, from + 999);
  if (error) throw error;
  rows.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const committedRows = new Set(rows.filter((r) => r.status === "committed").map((r) => r.row_number));
const pendingByRow = new Map();
for (const r of rows) {
  if (r.status !== "needs_review" || committedRows.has(r.row_number)) continue;
  const current = pendingByRow.get(r.row_number);
  if (!current || r.id > current.id) pendingByRow.set(r.row_number, r);
}
const rawByRow = new Map(rows.map((r) => [r.row_number, r.raw_data]));

const decisiones = [];
for (const [rowNumber, row] of [...pendingByRow.entries()].sort(([a], [b]) => a - b)) {
  const raw = row.raw_data ?? {};
  const issues = (row.import_issues ?? []).filter((i) => i.severity === "error" || i.severity === "blocking");
  const codes = new Set(issues.map((i) => i.issue_code));
  const mirrorMatch = issues.map((i) => /fila (\d+)/.exec(i.message ?? "")).find(Boolean);
  const mirrorRow = mirrorMatch ? Number(mirrorMatch[1]) : null;
  const mirrorDesc = mirrorRow ? rawByRow.get(mirrorRow)?.descripcion ?? null : null;

  const base = {
    fila: rowNumber,
    descripcion: raw.descripcion ?? "",
    codigo_interno: raw.codigo ?? "",
    codigo_proveedor: raw.codigoProveedor ?? "",
    proveedor: raw.proveedor ?? "",
    marca: raw.marca ?? "",
    fila_espejo: mirrorRow,
    descripcion_espejo: mirrorDesc,
    issues: [...codes]
  };

  if (codes.has("conflicting_internal_codes")) {
    decisiones.push({ ...base, grupo: "D3", decision: { kind: "import_distinct", ref: raw.codigo, motivo: `Código interno propio ${raw.codigo}: unidad vendible distinta de la fila ${mirrorRow}; el Excel repitió la descripción.` } });
    continue;
  }
  if (codes.has("same_supplier_different_codes")) {
    // El código interno propio manda como referencia visible; si no hay, el
    // código de proveedor (que es lo que distingue al artículo).
    const ref = raw.codigo || raw.codigoProveedor;
    decisiones.push({ ...base, grupo: "D1", decision: { kind: "import_distinct", ref, motivo: `Código de proveedor propio ${raw.codigoProveedor} (≠ fila ${mirrorRow}): artículo distinto cuya diferencia descriptiva perdió el Excel; se representa por su referencia.` } });
    continue;
  }
  if (codes.has("duplicate_supplier_code")) {
    // Revisión individual: dos filas re-escriben el MISMO artículo con otras
    // palabras (formato «BLISTER X 240» vs «X240», grafía STILETO/STILETTO).
    const REWORDED_SAME = new Map([
      [1489, "«UÑAS SOFT GEL BLISTER X 240 ALMOND» = «UÑAS SOFT GEL ALMOND X240» (fila 1487): mismo artículo re-escrito; mismo código SS-532."],
      [1491, "«UÑAS SOFT GEL BLISTER X 240 STILETO» = «UÑAS SOFT GEL STILETTO X240» (fila 1492): mismo artículo re-escrito; mismo código SS-533."]
    ]);
    const same = mirrorDesc !== null && norm(mirrorDesc) === norm(raw.descripcion);
    if (same || REWORDED_SAME.has(rowNumber)) {
      decisiones.push({ ...base, grupo: "D2", decision: { kind: "confirm_duplicate", motivo: REWORDED_SAME.get(rowNumber) ?? `Descripción y código ${raw.codigoProveedor} idénticos a la fila ${mirrorRow}: re-registro del mismo artículo en el Excel.` } });
    } else {
      // Si los ejes ya distinguen la variante (talla, color, medida…), no se
      // inventa sufijo; si colisionaría con la espejo, la referencia manda:
      // código interno propio > código de proveedor + fila.
      const ownKey = row.normalized_data?.grouping?.variantKey ?? null;
      const mirrorBest = rows.filter((r) => r.row_number === mirrorRow).sort((a, b) => (a.status === "committed" ? -1 : 1))[0];
      const mirrorKey = mirrorBest?.normalized_data?.grouping?.variantKey ?? null;
      const collides = ownKey !== null && mirrorKey !== null && String(ownKey).toLowerCase() === String(mirrorKey).toLowerCase();
      const ref = collides ? (raw.codigo || `${raw.codigoProveedor}-${rowNumber}`) : null;
      decisiones.push({ ...base, grupo: "D2", decision: { kind: "import_distinct", ref, dropSupplierSku: true, motivo: `El proveedor reutilizó el código ${raw.codigoProveedor} para artículos distintos («${raw.descripcion}» vs «${mirrorDesc}»); se importa como artículo propio y el código queda registrado solo en la primera oferta.` } });
    }
    continue;
  }
  if (codes.has("family_unmapped") || codes.has("empty_description")) {
    const desc = norm(raw.descripcion ?? "");
    if (!desc) {
      decisiones.push({ ...base, grupo: "D4", decision: { kind: "exclude", motivo: "Fila sin descripción: no existe artículo describible que importar. Excluida explícitamente; reincorporable si aparece la fuente." } });
    } else if (desc.includes("PEGAMENTO")) {
      decisiones.push({ ...base, grupo: "D4", decision: { kind: "reclassify", familia: "Soft gel, press gel y adhesivos para uñas", motivo: "PEGAMENTO GOLLE es adhesivo para uñas; se clasifica en su familia real y se importa." } });
    } else {
      decisiones.push({ ...base, grupo: "D4", decision: { kind: "exclude", motivo: `Descripción «${raw.descripcion}» insuficiente para determinar familia/artículo sin conocimiento del negocio. Excluida explícitamente (no bajo «pendiente»); reincorporable con mejor fuente.` } });
    }
    continue;
  }
  if (codes.has("supplier_offer_exists")) {
    // Ruido de segundos pases previos al ancla de fila committed: se refresca
    // re-ejecutando el lote; no es una decisión comercial.
    decisiones.push({ ...base, grupo: "STALE", decision: { kind: "confirm_duplicate", motivo: "Fila de un segundo pase previo al ancla de idempotencia; su contenido ya está representado. Se cierra como duplicado de staging." } });
    continue;
  }
  decisiones.push({ ...base, grupo: "SIN_POLITICA", decision: null });
}

const resumen = {};
for (const d of decisiones) resumen[d.grupo] = (resumen[d.grupo] ?? 0) + 1;
const out = { generado: new Date().toISOString(), politica: "certificacion-1c", resumen, decisiones };
const target = path.join(root, "docs", "evidencia-certificacion-1c", "decisiones-67.json");
await fs.writeFile(target, JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify({ resumen, total: decisiones.length, sinPolitica: decisiones.filter((d) => !d.decision).length, archivo: target }, null, 2));
