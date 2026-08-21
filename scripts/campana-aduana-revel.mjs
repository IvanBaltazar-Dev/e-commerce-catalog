/**
 * Campaña de comercio exterior · REVE'L.
 *
 * Aduana responde una pregunta que el catálogo vivo no puede: qué entró al país
 * y cuándo. Y ya sabemos que hacen falta las dos, porque de nuestros 57 códigos
 * REVEL/BELLESPA solo 3 siguen listados hoy — el catálogo rota, el registro
 * histórico no.
 *
 * LÍMITE IMPORTANTE, y por eso este script tiene dos modos.
 *
 * Veritrade vende estos registros por suscripción. Su página pública muestra una
 * vista previa de ~20 de los 499 de REVE'L; el resto está detrás del muro.
 * Raspar los 499 sería tomar el producto que ellos venden, que no es lo mismo
 * que rastrear el catálogo que una marca publica para ser visto.
 *
 * Y hay una segunda razón, más clara todavía: Veritrade devuelve 403 al acceso
 * programático. Con curl responde y con fetch no — están defendiendo el acceso
 * automático a propósito. Insistir sería rodear una puerta que alguien cerró.
 *
 * Así que este script NO captura de la web. Ingiere una exportación tuya: los
 * 499 registros salen de tu propia cuenta, y entran por el mismo camino que
 * cualquier otra fuente —source_records, referencia, reconciliación— con su
 * procedencia declarada.
 *
 * Uso:
  *   node scripts/campana-aduana-revel.mjs --importar registros.csv --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const APLICAR = args.includes("--aplicar");

const FICHERO = args[args.indexOf("--importar") + 1];
const IMPORTAR = args.includes("--importar") && FICHERO && !FICHERO.startsWith("--");

if (!IMPORTAR) {
  console.error("Uso: node scripts/campana-aduana-revel.mjs --importar <fichero.csv> [--aplicar]");
  console.error("La captura directa no está: Veritrade bloquea el acceso programático y vende estos registros.");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const RUC_REVEL = "20551491278";
const URL_VERITRADE = `https://www.veritradecorp.com/es/peru/importaciones-y-exportaciones-drogueria-revel-cosmetics-import-export-eirl/ruc-${RUC_REVEL}`;

/**
 * De la descripción aduanera salen seis observaciones, no una. El texto crudo se
 * conserva siempre: si mañana mejora esta regla hay que poder releer lo que la
 * declaración decía de verdad.
 *
 *   KIT BRILLO GLOSS, REVE`L, S/M
 *   KIT BRILLO GLOSS SH-577
 *   BOX X 24PCS
 *   NSOC50594-21PE
 *   LOTE:26240577
 *   13.5G
 */
export function desmontarDeclaracion(texto) {
  const bruto = (texto ?? "").replace(/\s+/g, " ").trim();
  const nso = (bruto.match(/\b(NSO[A-Z]?\d{4,6}-\d{2}[A-Z]{2})\b/i) ?? [])[1] ?? null;

  // El código se busca en el texto SIN la notificación. Sin quitarla primero,
  // «NSOC45974-20PE» encaja en el patrón de código y se guardaba «NSOC45974»
  // como si fuera la referencia del producto — justo el error que 0143 existe
  // para impedir, colado por la puerta de atrás.
  //
  // Y el código puede venir con almohadilla: «#506634» es una referencia
  // numérica del catálogo, no un número suelto de la descripción.
  const sinNso = nso ? bruto.replace(new RegExp(nso, "gi"), " ") : bruto;
  const codigo =
    (sinNso.match(/#\s?(\d{4,8})\b/) ?? [])[1] ??
    (sinNso.match(/\b([A-Z]{2,4}-?\d{2,5})\b(?!\s*(?:PCS|PZAS|UNID|G|GR|ML))/i) ?? [])[1] ??
    null;
  const lote = (bruto.match(/LOTE\s*:?\s*([A-Z0-9-]{4,20})/i) ?? [])[1] ?? null;
  const pack = (bruto.match(/BOX\s*X?\s*(\d+)\s*(?:PCS|PZAS|UNID)?/i) ?? [])[1] ?? null;
  const contenido = bruto.match(/\b(\d+(?:[.,]\d+)?)\s*(ML|GR?|G|KG|OZ)\b/i) ?? [];
  const marca = (bruto.match(/\b(REVE[`´']?L|BELLESPA|CHARM LIMIT|CANDY SECRET|KONSUNG)\b/i) ?? [])[1] ?? null;
  return {
    codigoDeclarado: codigo,
    notificacion: nso ? nso.toUpperCase() : null,
    lote,
    unidadesPorBox: pack ? Number(pack) : null,
    contenido: contenido[1] ? Number(String(contenido[1]).replace(",", ".")) : null,
    unidadContenido: contenido[2] ? contenido[2].toUpperCase() : null,
    marcaDeclarada: marca ? marca.replace(/[`´']/g, "'").toUpperCase() : null
  };
}

function parseCsv(texto) {
  const filas = [];
  let campo = "", fila = [], comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i += 1; } else comillas = false; }
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === "," || c === ";") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas;
  const H = cab.map((x) => x.replace(/^﻿/, "").trim());
  return resto.filter((f) => f.length === H.length).map((f) => Object.fromEntries(H.map((k, i) => [k, f[i]])));
}

// ── Obtención ───────────────────────────────────────────────────────────────
let declaraciones = [];
let procedencia = null;

{
  console.log(`Importando ${FICHERO}…`);
  const filas = parseCsv(readFileSync(path.resolve(FICHERO), "utf8"));
  const campoDesc = Object.keys(filas[0] ?? {}).find((k) => /descrip/i.test(k));
  const campoFecha = Object.keys(filas[0] ?? {}).find((k) => /fecha|date/i.test(k));
  if (!campoDesc) throw new Error("no encuentro una columna de descripción en el fichero");
  declaraciones = filas.map((f) => ({
    fecha: campoFecha ? f[campoFecha] : null,
    descripcionRaw: f[campoDesc],
    importador: Object.entries(f).find(([k]) => /importad/i.test(k))?.[1] ?? null,
    exportador: Object.entries(f).find(([k]) => /exportad|proveedor/i.test(k))?.[1] ?? null,
    origen: Object.entries(f).find(([k]) => /origen|country/i.test(k))?.[1] ?? null,
    ...desmontarDeclaracion(f[campoDesc])
  }));
  procedencia = { modo: "exportacion_suscriptor", fichero: path.basename(FICHERO), contentHash: sha(readFileSync(path.resolve(FICHERO))) };
  console.log(`   ${declaraciones.length} filas leídas`);
}

// ── Informe ─────────────────────────────────────────────────────────────────
const conCodigo = declaraciones.filter((d) => d.codigoDeclarado);
const conNso = declaraciones.filter((d) => d.notificacion);
const nsos = new Map();
for (const d of conNso) {
  if (!nsos.has(d.notificacion)) nsos.set(d.notificacion, new Set());
  if (d.codigoDeclarado) nsos.get(d.notificacion).add(d.codigoDeclarado.toUpperCase());
}

console.log(`\nDeclaraciones: ${declaraciones.length}`);
console.log(`  con código:        ${conCodigo.length}`);
console.log(`  con notificación:  ${conNso.length}`);
console.log(`  con lote:          ${declaraciones.filter((d) => d.lote).length}`);
console.log(`  con pack:          ${declaraciones.filter((d) => d.unidadesPorBox).length}`);
console.log(`  con contenido:     ${declaraciones.filter((d) => d.contenido).length}`);

if (nsos.size) {
  console.log(`\nNotificaciones observadas: ${nsos.size}`);
  for (const [n, codigos] of nsos) {
    console.log(`   ${n}  →  ${codigos.size} código(s): ${[...codigos].join(", ") || "(sin código legible)"}`);
    if (codigos.size > 1) console.log(`      ⚠ ampara más de un código: NO puede usarse como identidad`);
  }
}

console.log(`\nMuestra:`);
for (const d of declaraciones.slice(0, 5)) {
  console.log(`   ${String(d.fecha ?? "?").padEnd(12)} ${String(d.codigoDeclarado ?? "—").padEnd(10)} ${String(d.notificacion ?? "—").padEnd(16)} ${String(d.descripcionRaw).slice(0, 70)}`);
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "campana-aduana-revel.json"),
  JSON.stringify({ procedencia, declaraciones }, null, 2), "utf8");
console.log(`\n→ outputs/campana-aduana-revel.json`);

if (!APLICAR) {
  console.log(`\nSin persistir. Añade --aplicar.`);
  process.exit(0);
}

// ── Persistencia ────────────────────────────────────────────────────────────
const { data: fuente, error: errFuente } = await db.from("catalog_sources").upsert({
  source_key: "veritrade-pe-revel",
  name: "Comercio exterior · importaciones de Droguería REVE'L (Perú)",
  // Manda sobre importador, exportador, país, fecha, código y presentación
  // declarada. No sobre precio de venta, disponibilidad ni beneficios.
  authority: "trade_record",
  adapter: "html",
  base_url: "https://www.veritradecorp.com",
  is_active: true,
  metadata: {
    rucImportador: RUC_REVEL,
    modo: procedencia.modo,
    limite: procedencia.modo === "vista_previa_publica"
      ? "vista pública: el proveedor vende el conjunto completo por suscripción"
      : null
  }
}, { onConflict: "source_key" }).select("id").single();
if (errFuente) throw new Error(`catalog_sources: ${errFuente.message}`);

const { data: snap, error: errSnap } = await db.from("catalog_source_snapshots").insert({
  source_id: fuente.id, status: "succeeded",
  started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  http_status: 200, content_hash: procedencia.contentHash,
  product_count: declaraciones.length, variant_count: 0, image_count: 0,
  metadata: procedencia
}).select("id").single();
// Mismo contenido, mismo snapshot: el índice único por hash lo impone y hace
// bien. Reimportar el mismo fichero debe reconocer la captura anterior, no
// crear una segunda que diga lo mismo con otra fecha.
let snapshotId = snap?.id ?? null;
if (errSnap) {
  if (!/duplicate|unique/i.test(errSnap.message)) {
    throw new Error(`catalog_source_snapshots: ${errSnap.message}`);
  }
  const { data: previo } = await db
    .from("catalog_source_snapshots")
    .select("id")
    .eq("source_id", fuente.id)
    .eq("content_hash", procedencia.contentHash)
    .maybeSingle();
  if (!previo) throw new Error("choque de hash sin snapshot previo localizable");
  snapshotId = previo.id;
  console.log("   captura idéntica a una anterior: se reutiliza su snapshot");
}

const capturadoEn = new Date().toISOString();
const registros = declaraciones.map((d, i) => ({
  snapshot_id: snapshotId, source_id: fuente.id,
  entity_type: "document",
  external_id: `${RUC_REVEL}:${sha(d.descripcionRaw).slice(0, 16)}`,
  title: d.codigoDeclarado ?? `declaración ${i + 1}`,
  source_url: URL_VERITRADE,
  captured_at: capturadoEn,
  payload: {
    tipo: "declaracion_importacion",
    // El texto entero, sin tocar. Todo lo demás es derivación de esto.
    descripcion_raw: d.descripcionRaw,
    fecha_declarada: d.fecha ?? null,
    codigo_declarado: d.codigoDeclarado,
    notificacion_declarada: d.notificacion,
    lote: d.lote,
    unidades_por_box: d.unidadesPorBox,
    contenido: d.contenido,
    unidad_contenido: d.unidadContenido,
    marca_declarada: d.marcaDeclarada,
    importador: d.importador ?? "DROGUERIA REVE'L COSMETICS IMPORT EXPORT E.I.R.L.",
    exportador: d.exportador ?? null,
    origen: d.origen ?? null,
    ruc_importador: RUC_REVEL
  }
}));

let escritos = 0;
for (let i = 0; i < registros.length; i += 200) {
  const { error } = await db.from("catalog_source_records").insert(registros.slice(i, i + 200));
  // Reimportar el mismo fichero no debe duplicar declaraciones: el external_id
  // es el hash de la descripción, así que la base ya sabe reconocerlas.
  if (error && !/duplicate|unique/i.test(error.message)) {
    throw new Error(`catalog_source_records: ${error.message}`);
  }
  if (error) { console.log("   declaraciones ya presentes: se conservan las anteriores"); break; }
  escritos += Math.min(200, registros.length - i);
}
console.log(`\nsource_records escritos: ${escritos}`);

// ── Notificaciones sanitarias ───────────────────────────────────────────────
let notifs = 0, sujetos = 0;
for (const [valor, codigos] of nsos) {
  const { data: n, error } = await db.from("regulatory_notifications").upsert({
    value: valor,
    jurisdiction: "PE",
    authority: "DIGEMID",
    notification_kind: "sanitary_notification",
    // Se observa, no se afirma vigente: para eso hay que consultar al registro.
    current_status: "observed",
    // Ampare cuántos productos es justo lo que no se sabe.
    scope: "unknown",
    source_id: fuente.id,
    source_url: URL_VERITRADE,
    raw_excerpt: declaraciones.find((d) => d.notificacion === valor)?.descripcionRaw?.slice(0, 500) ?? null,
    metadata: { codigosObservados: [...codigos] }
  }, { onConflict: "value,jurisdiction,authority" }).select("id").single();
  if (error) { console.error(`   ✗ ${valor}: ${error.message}`); continue; }
  notifs += 1;
  for (const codigo of codigos) {
    const { error: errS } = await db.from("regulatory_notification_subjects").insert({
      notification_id: n.id,
      // Todavía no apunta a ningún producto nuestro: eso lo decidirá la
      // reconciliación. Aquí solo consta con qué código la nombró el documento.
      reference_product_id: null, reference_variant_id: null, product_id: null,
      variant_id: null,
      declared_code: codigo,
      declared_name: declaraciones.find((d) => d.codigoDeclarado?.toUpperCase() === codigo)?.descripcionRaw?.slice(0, 200) ?? null,
      observed_at: capturadoEn
    });
    if (!errS) sujetos += 1;
  }
}

console.log(`Notificaciones registradas: ${notifs} · sujetos declarados: ${sujetos}`);
console.log(`\nNinguna NSO se guardó como identificador de producto.`);
