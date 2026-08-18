/**
 * Gate del patrimonio multimedia.
 *
 * El checkpoint reproducía PostgreSQL y solo PostgreSQL. El 18 de agosto de
 * 2026 una reconstrucción desde base vacía lo dejó en evidencia: volvieron las
 * 158 filas de `media_assets`, volvieron los buckets… y `storage.objects` quedó
 * vacío. Metadatos intactos, cero bytes. El catálogo se quedó sin una sola
 * imagen y nada se puso en rojo.
 *
 * Este gate cierra ese hueco. El checkpoint pasa de «PostgreSQL reproducible» a
 * «estado Bellaroshé reproducible»: los binarios no entran al volcado ni a Git
 * —seguirían siendo payload pesado en el sitio equivocado— pero sí queda un
 * manifiesto verificable y una ruta recuperable hacia ellos.
 *
 *   export   copia los objetos de Storage al almacén local y escribe el
 *            manifiesto con hash, tamaño, tipo y dueño de cada uno.
 *   restore  devuelve esos bytes a Storage desde el almacén local.
 *   verify   comprueba las DOS direcciones y falla si alguna no cuadra.
 *
 * La verificación no se conforma con «hay archivos». Exige:
 *
 *   · cero medios fantasma        — metadato sin archivo;
 *   · cero archivos huérfanos     — objeto sin registro que lo reclame;
 *   · cero hashes divergentes     — mismo camino, contenido distinto;
 *   · cero dueños inválidos       — medio que no cuelga de producto ni variante.
 *
 * Si PostgreSQL queda verde y falta una sola imagen, esto queda rojo.
 *
 * Uso:
 *   node scripts/gate-media-rebuild.mjs export  --env .env.supabase.local
 *   node scripts/gate-media-rebuild.mjs restore --env .env.supabase.local
 *   node scripts/gate-media-rebuild.mjs verify  --env .env.supabase.local
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate-media-rebuild",
});
if (!isLocal) throw new Error("El gate de medios solo corre contra Supabase local.");

const MEDIA_ROOT = path.join(catalogResearchStorageRoot(ROOT), "media");
const MANIFEST_PATH = path.join(catalogResearchStorageRoot(ROOT), "media-storage.manifest.json");
const action = positionals[0] ?? "verify";

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const localPathFor = (entry) => path.join(MEDIA_ROOT, entry.bucket, ...entry.path.split("/"));

/**
 * Huella agregada del patrimonio multimedia, al mismo nivel que las que ya
 * existen para PostgreSQL y para el grafo.
 *
 * Contar archivos no basta: 172 objetos pueden ser otros 172 objetos, o los
 * mismos colgando de otros productos. La huella incorpora contenido Y dueño, y
 * en orden estable, así que solo coincide si son exactamente los mismos bytes
 * asociados exactamente a las mismas entidades.
 */
function mediaFingerprint(entries) {
  const lines = entries
    .flatMap((entry) => {
      const owners = entry.owners?.length
        ? entry.owners.map((owner) => `${owner.variantId ? "variant" : "product"}:${owner.variantId ?? owner.productId}`)
        : ["none:none"];
      return owners.sort().map((owner) => [
        entry.bucket, entry.path, entry.sha256, entry.bytes, entry.mime, owner,
      ].join("|"));
    })
    .sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Lo que la base declara que existe, con su dueño. Un medio sin producto ni
 * variante detrás no es patrimonio: es un archivo que nadie reclama, y el
 * manifiesto lo dice en vez de callarlo.
 */
async function declaredAssets() {
  const assets = must(
    await service.from("media_assets")
      .select("id, bucket, storage_path, file_name, mime_type, size_bytes, checksum")
      .order("bucket").order("storage_path"),
    "media_assets",
  );
  const links = must(
    await service.from("product_media").select("media_asset_id, product_id, variant_id, media_role"),
    "product_media",
  );
  const ownerByAsset = new Map();
  for (const link of links) {
    if (!ownerByAsset.has(link.media_asset_id)) ownerByAsset.set(link.media_asset_id, []);
    ownerByAsset.get(link.media_asset_id).push({
      productId: link.product_id, variantId: link.variant_id, role: link.media_role,
    });
  }
  return assets.map((asset) => ({
    mediaAssetId: asset.id,
    bucket: asset.bucket,
    path: asset.storage_path,
    fileName: asset.file_name,
    mime: asset.mime_type,
    bytes: asset.size_bytes,
    declaredChecksum: asset.checksum,
    owners: ownerByAsset.get(asset.id) ?? [],
  }));
}

/** Todos los objetos que Storage tiene de verdad, recorriendo cada carpeta. */
async function storageObjects(bucket) {
  const found = [];
  async function walk(prefix) {
    const { data, error } = await service.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(`listar ${bucket}/${prefix}: ${error.message}`);
    for (const item of data ?? []) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) await walk(full);
      else found.push(full);
    }
  }
  await walk("");
  return found;
}

async function download(bucket, storagePath) {
  const { data, error } = await service.storage.from(bucket).download(storagePath);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function readManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------------------

if (action === "export") {
  const declared = await declaredAssets();
  const entries = [];
  const missing = [];

  for (const asset of declared) {
    const buffer = await download(asset.bucket, asset.path);
    if (!buffer) {
      missing.push(`${asset.bucket}/${asset.path}`);
      continue;
    }
    const target = localPathFor(asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    entries.push({
      bucket: asset.bucket,
      path: asset.path,
      sha256: sha256(buffer),
      bytes: buffer.byteLength,
      mime: asset.mime,
      mediaAssetId: asset.mediaAssetId,
      owners: asset.owners,
      state: asset.owners.length ? "owned" : "unclaimed",
    });
  }

  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify({
    schema_version: 1,
    storage_contract: "bellaroshe-media-storage-v1",
    fingerprint: mediaFingerprint(entries),
    exported_objects: entries.length,
    missing_objects: missing,
    files: entries,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    accion: "export",
    objetosCopiados: entries.length,
    huellaDelPatrimonio: mediaFingerprint(entries),
    sinArchivoEnStorage: missing.length,
    almacenLocal: MEDIA_ROOT,
    manifiesto: MANIFEST_PATH,
  }, null, 2));
  if (missing.length) process.exit(1);

} else if (action === "restore") {
  const manifest = await readManifest();
  if (!manifest) throw new Error(`No hay manifiesto en ${MANIFEST_PATH}. Corre export primero.`);

  let restored = 0;
  const failures = [];
  for (const entry of manifest.files) {
    const buffer = await fs.readFile(localPathFor(entry)).catch(() => null);
    if (!buffer) {
      failures.push(`falta el archivo local de ${entry.bucket}/${entry.path}`);
      continue;
    }
    if (sha256(buffer) !== entry.sha256) {
      failures.push(`el archivo local de ${entry.bucket}/${entry.path} no coincide con su hash`);
      continue;
    }
    const { error } = await service.storage.from(entry.bucket)
      .upload(entry.path, buffer, { contentType: entry.mime, upsert: true });
    if (error) failures.push(`subir ${entry.bucket}/${entry.path}: ${error.message}`);
    else restored += 1;
  }

  console.log(JSON.stringify({ accion: "restore", objetosDevueltos: restored, fallos: failures }, null, 2));
  if (failures.length) process.exit(1);

} else if (action === "verify") {
  const manifest = await readManifest();
  const declared = await declaredAssets();
  const manifestByKey = new Map((manifest?.files ?? []).map((entry) => [`${entry.bucket}/${entry.path}`, entry]));

  const phantom = [];      // el metadato existe, el archivo no
  const divergent = [];    // el archivo existe, con otro contenido
  const unowned = [];      // el medio no cuelga de ningún producto ni variante
  const undeclared = [];   // el metadato no está en el manifiesto

  const live = [];
  for (const asset of declared) {
    const key = `${asset.bucket}/${asset.path}`;
    const buffer = await download(asset.bucket, asset.path);
    if (!buffer) { phantom.push(key); continue; }

    const digest = sha256(buffer);
    const expected = manifestByKey.get(key)?.sha256 ?? asset.declaredChecksum;
    if (expected && expected !== digest) divergent.push(key);
    if (!manifestByKey.has(key)) undeclared.push(key);
    if (asset.owners.length === 0) unowned.push(key);

    live.push({
      bucket: asset.bucket, path: asset.path, sha256: digest,
      bytes: buffer.byteLength, mime: asset.mime, owners: asset.owners,
    });
  }

  const declaredKeys = new Set(declared.map((asset) => `${asset.bucket}/${asset.path}`));
  const buckets = [...new Set(declared.map((asset) => asset.bucket))];
  const orphan = [];       // el archivo existe, nadie lo declara
  for (const bucket of buckets.length ? buckets : ["catalog-assets"]) {
    for (const objectPath of await storageObjects(bucket)) {
      if (!declaredKeys.has(`${bucket}/${objectPath}`)) orphan.push(`${bucket}/${objectPath}`);
    }
  }

  const liveFingerprint = mediaFingerprint(live);
  const manifestFingerprint = manifest?.fingerprint ?? null;

  const sample = (list) => list.slice(0, 5);
  const report = {
    accion: "verify",
    mediosDeclarados: declared.length,
    objetosEnManifiesto: manifest?.files?.length ?? 0,
    huellaDelPatrimonio: liveFingerprint,
    huellaDelManifiesto: manifestFingerprint,
    huellaCoincide: manifestFingerprint === null ? null : manifestFingerprint === liveFingerprint,
    mediosFantasma: phantom.length,
    archivosHuerfanos: orphan.length,
    hashesDivergentes: divergent.length,
    mediosSinDueno: unowned.length,
    mediosSinDeclararEnManifiesto: undeclared.length,
    ejemplos: {
      fantasma: sample(phantom),
      huerfanos: sample(orphan),
      divergentes: sample(divergent),
      sinDueno: sample(unowned),
      sinDeclarar: sample(undeclared),
    },
  };
  // La huella es la última condición y no la más blanda: aunque cada objeto
  // esté y cada hash cuadre, si el conjunto no es idéntico al declarado —porque
  // un medio cambió de dueño, por ejemplo— el patrimonio dejó de ser el mismo.
  const green = phantom.length === 0 && orphan.length === 0 && divergent.length === 0
    && unowned.length === 0 && undeclared.length === 0
    && (manifestFingerprint === null || manifestFingerprint === liveFingerprint);
  report.resultado = green ? "VERDE" : "ROJO";

  console.log(JSON.stringify(report, null, 2));
  if (!green) process.exit(1);

} else {
  throw new Error(`Acción desconocida: ${action}. Usa export, restore o verify.`);
}
