/**
 * Campaña Multimedia · carril B.
 *
 * Los 56 medios declarados sin bytes se auditan aquí. La regla que manda es que
 * ninguno puede desaparecer para poner verde el gate: si el medio corresponde,
 * se recupera; si no se puede sostener, deja de ser publicable pero se conserva
 * por qué.
 *
 * Y una segunda regla, igual de importante: una causa común genera UNA decisión
 * común, no cincuenta y seis. El trabajo humano se reserva para las excepciones
 * materiales.
 *
 * La clasificación es automática y sale de la evidencia, no del criterio de
 * quien ejecuta:
 *
 *   · el archivo existe en el almacén declarado y su nombre corresponde
 *     exactamente al medio          → RECOVERABLE_EXACT, se recupera
 *   · el archivo no aparece         → INSUFFICIENT_EVIDENCE, con su causa
 *
 * Lo que NO decide este guion es si un visual estandarizado puede publicarse
 * como imagen de un tono. Eso es un juicio sobre derechos y correspondencia, es
 * el mismo para los 55 casos que lo comparten, y se toma una sola vez.
 *
 * Uso:
 *   node scripts/media-campaign-run-b.mjs --key=campana-multimedia-1 \
 *     [--aplicar] --env .env.supabase.local
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "media-campaign-run-b",
  allowedFlags: ["--key", "--aplicar", "--origen"],
});
if (!isLocal) throw new Error("La campaña multimedia solo corre contra Supabase local.");

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const campaignKey = argument("key");
if (!campaignKey) throw new Error("Falta --key con la clave de la campaña.");
const apply = process.argv.includes("--aplicar");

// De dónde se recuperan los bytes. Por defecto, el almacén de activos que el
// manifiesto de Masglo declara como origen de esas imágenes.
const ASSET_ROOT = argument("origen")
  ?? "F:/Products_SIVAN/Bellaroshe/version-V2/products/01-masglo-tradicional/masglo_tradicional_media_envases_reales_catalog_assets/productos";
const MEDIA_ROOT = path.join(catalogResearchStorageRoot(ROOT), "media");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function walk(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { out.push(current); current = ""; }
    else current += char;
  }
  out.push(current);
  return out;
}

// El manifiesto auditado de Masglo dice, por archivo, qué clase de evidencia es
// y qué compuerta de publicación le corresponde. Es la fuente de la causa común.
function readAssetManifest() {
  const file = path.join(catalogResearchStorageRoot(ROOT), "data", "masglo_local_asset_manifest_audited.csv");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const index = (name) => header.indexOf(name);
  const byFile = new Map();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    byFile.set(path.basename(cells[index("ruta_storage")]).toLowerCase(), {
      evidence: cells[index("evidence_status")],
      gate: cells[index("publish_gate")],
      tone: cells[index("tono")],
      manufacturerSku: cells[index("sku_fabricante")],
    });
  }
  return byFile;
}

// ---------------------------------------------------------------------------

const campaign = must(
  await service.from("catalog_media_campaigns").select("id, campaign_key").eq("campaign_key", campaignKey).single(),
  "campaña"
);

const pending = must(
  await service.from("catalog_media_campaign_items")
    .select("id, variant_id, product_id, media_asset_id, provenance")
    .eq("campaign_id", campaign.id).eq("lane", "B").eq("state", "PENDING"),
  "expedientes del carril B"
);

const assets = must(
  await service.from("media_assets").select("id, bucket, storage_path, checksum"),
  "medios declarados"
);
const assetById = new Map(assets.map((asset) => [asset.id, asset]));

const manifest = readAssetManifest();
const available = new Map(
  walk(ASSET_ROOT).map((file) => [path.basename(file).toLowerCase(), file])
);

const run = apply
  ? must(
      await service.from("catalog_media_runs")
        .insert({ campaign_id: campaign.id, lane: "B", state: "STAGED" }).select("id").single(),
      "abrir la corrida"
    )
  : null;

const groups = new Map();
const decided = [];

for (const item of pending) {
  const asset = assetById.get(item.media_asset_id);
  const fileName = asset ? path.basename(asset.storage_path).toLowerCase() : null;
  const source = fileName ? available.get(fileName) : null;
  const evidence = fileName ? manifest.get(fileName) : null;

  const cause = source
    ? null
    : "El archivo declarado no aparece en el almacén de activos, así que no puede afirmarse cuál era.";
  const state = source ? "RECOVERABLE_EXACT" : "INSUFFICIENT_EVIDENCE";
  const groupKey = [
    state,
    evidence?.evidence ?? "SIN_FILA_EN_MANIFIESTO",
    evidence?.gate ?? "sin compuerta declarada",
  ].join(" · ");

  if (!groups.has(groupKey)) groups.set(groupKey, []);
  groups.get(groupKey).push({ item, asset, source, evidence, state, cause });
  decided.push({ item, asset, source, evidence, state, cause, groupKey });
}

console.log("Carril B · clasificación por evidencia\n");
for (const [key, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(members.length).padStart(3)}  ${key}`);
}

if (!apply) {
  console.log(`\n${JSON.stringify({
    modo: "propuesta",
    expedientes: pending.length,
    gruposDeCausaComun: groups.size,
    decisionesHumanasNecesarias: [...groups.keys()].length,
    nota: "Ejecuta con --aplicar para cerrar los expedientes y recuperar los bytes.",
  }, null, 2)}`);
  process.exit(0);
}

let recovered = 0;
let unresolved = 0;

for (const entry of decided) {
  const { item, asset, source, evidence, state, cause } = entry;

  if (state === "RECOVERABLE_EXACT") {
    const buffer = await fsp.readFile(source);
    const meta = await sharp(buffer).metadata();
    const { error } = await service.storage.from(asset.bucket)
      .upload(asset.storage_path, buffer, { contentType: "image/webp", upsert: true });
    if (error) throw new Error(`recuperar ${asset.storage_path}: ${error.message}`);

    const target = path.join(MEDIA_ROOT, asset.bucket, ...asset.storage_path.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buffer);

    must(
      await service.from("media_assets").update({
        checksum: sha256(buffer), size_bytes: buffer.byteLength,
        width: meta.width, height: meta.height, mime_type: "image/webp",
        metadata: {
          campaign: campaignKey,
          recovered: true,
          recoveredFrom: source,
          evidenceStatus: evidence?.evidence ?? null,
          publishGate: evidence?.gate ?? null,
          manufacturerSku: evidence?.manufacturerSku ?? null,
        },
      }).eq("id", asset.id),
      "recuperar el medio declarado"
    );
    recovered += 1;
  } else {
    unresolved += 1;
  }

  must(
    await service.from("catalog_media_campaign_items")
      .update({ state, cause, run_id: run.id, media_asset_id: asset?.id ?? item.media_asset_id,
        processed_at: new Date().toISOString(),
        provenance: { ...item.provenance, grupo: entry.groupKey } })
      .eq("id", item.id),
    "cerrar el expediente"
  );

  must(
    await service.from("catalog_media_campaign_item_actions").insert({
      campaign_item_id: item.id,
      media_asset_id: asset?.id ?? null,
      object_ref: asset?.storage_path ?? `expediente ${item.id}`,
      state, cause,
      origin_code: evidence?.evidence ?? null,
      evidence: {
        origen: source ?? null,
        compuertaDePublicacion: evidence?.gate ?? null,
        tono: evidence?.tone ?? null,
      },
      applied_at: state === "RECOVERABLE_EXACT" ? new Date().toISOString() : null,
    }),
    "registrar la acción terminal"
  );
}

await service.from("catalog_media_runs")
  .update({ state: "COMMITTED", settled_at: new Date().toISOString(), produced_assets: recovered,
    note: `carril B · ${decided.length} expedientes` })
  .eq("id", run.id);

console.log(`\n${JSON.stringify({
  modo: "aplicado",
  expedientes: decided.length,
  recuperados: recovered,
  sinEvidencia: unresolved,
  corrida: run.id,
}, null, 2)}`);
