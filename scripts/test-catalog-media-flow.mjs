import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { deflateRawSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "test-catalog-media-flow" });
if (!isLocal) throw new Error("La prueba de medios solo puede ejecutarse contra Supabase local.");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(root, "src", specifier.slice(2));
    const target = path.extname(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(target).href, context);
  }
});

const [{ parseCatalogMediaZip }, { analyzeCatalogMediaPackage, commitCatalogMediaPackage }] = await Promise.all([
  import("../src/lib/admin/catalog-media-zip.ts"),
  import("../src/lib/admin/catalog-media-service.ts")
]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [entryName, raw] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function webp() {
  const payload = Buffer.from([0x2f, 0, 0, 0, 0]);
  const chunk = Buffer.alloc(8);
  chunk.write("VP8L", 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), chunk, payload, Buffer.alloc(1)]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function pdf() {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
}

function memoryFile(name, buffer) {
  return {
    name,
    size: buffer.length,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const email = `catalog-media-${stamp}@local.invalid`;
const password = `Catalog-Media-${stamp}!`;
const base = `productos/ZIP-TEST-${stamp}`;
const paths = [`${base}/main.webp`, `${base}/carta.pdf`];
let userId;
let batchId;

try {
  const createdUser = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error) throw createdUser.error;
  userId = createdUser.data.user.id;
  const profile = await service.from("admin_profiles").insert({ id: userId, role: "developer", full_name: "Catalog media test" });
  if (profile.error) throw profile.error;

  const developer = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const login = await developer.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;

  const existingUpload = await service.storage.from("catalog-assets").upload(paths[0], webp(), { contentType: "image/webp", upsert: false });
  if (existingUpload.error) throw existingUpload.error;
  const zip = zipEntries(new Map([
    ["README_CARGA.txt", Buffer.from("Prueba")],
    [paths[0], webp()],
    [paths[1], pdf()]
  ]));
  const mediaPackage = await parseCatalogMediaZip(memoryFile("medios-prueba.zip", zip));
  const preview = await analyzeCatalogMediaPackage(developer, mediaPackage);
  assert.equal(preview.summary.mediaFiles, 2);
  assert.equal(preview.summary.existingFiles, 1);
  assert.equal(preview.summary.filesToUpload, 1);
  assert.equal(preview.summary.ignoredFiles, 1);
  await assert.rejects(
    () => commitCatalogMediaPackage(developer, userId, mediaPackage, "0".repeat(64)),
    (error) => error?.code === "catalog_media_file_changed"
  );

  const committed = await commitCatalogMediaPackage(developer, userId, mediaPackage, mediaPackage.fileSha256);
  batchId = committed.batchId;
  assert.equal(committed.uploadedFiles, 1);
  assert.equal(committed.existingFiles, 1);
  const [first, second, audit] = await Promise.all([
    service.storage.from("catalog-assets").exists(paths[0]),
    service.storage.from("catalog-assets").exists(paths[1]),
    service.from("import_batches").select("source_type,status,total_rows,processed_rows,error_rows,file_sha256,security_report").eq("id", batchId).single()
  ]);
  for (const result of [first, second, audit]) if (result.error) throw result.error;
  assert.equal(first.data, true);
  assert.equal(second.data, true);
  assert.equal(audit.data.source_type, "catalog_media_zip");
  assert.equal(audit.data.status, "committed");
  assert.equal(audit.data.total_rows, 2);
  assert.equal(audit.data.processed_rows, 2);
  assert.equal(audit.data.error_rows, 0);
  assert.equal(audit.data.file_sha256, mediaPackage.fileSha256);
  assert.equal(audit.data.security_report.originalFileStored, false);
  console.log(`OK: lote ${batchId}; 1 medio nuevo, 1 existente, auditoría y Storage verificados.`);
} finally {
  if (batchId) await service.from("import_batches").delete().eq("id", batchId);
  await service.storage.from("catalog-assets").remove(paths);
  if (userId) await service.auth.admin.deleteUser(userId);
}
