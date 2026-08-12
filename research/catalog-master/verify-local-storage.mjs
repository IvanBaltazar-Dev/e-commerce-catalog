import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogResearchStorageRoot,
} from "../../scripts/lib/catalog-research-paths.mjs";

const RESEARCH_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RESEARCH_ROOT, "..", "..");
const STORAGE_ROOT = catalogResearchStorageRoot(REPO_ROOT);
const MANIFEST_PATH = path.join(RESEARCH_ROOT, "local-storage.manifest.json");

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function listFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
  }
  return files;
}

async function buildManifest() {
  const files = [];
  for (const group of ["data", "sources", "local"]) {
    const groupRoot = path.join(STORAGE_ROOT, group);
    for (const file of await listFiles(groupRoot, group)) {
      if (file.relative.startsWith("local/research-runs/")) continue;
      const stat = await fs.stat(file.absolute);
      files.push({
        path: file.relative,
        class: group === "sources" ? "raw" : group === "data" ? "derived" : "local_input_or_output",
        bytes: stat.size,
        sha256: await sha256(file.absolute),
      });
    }
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"))
    .digest("hex");
  return {
    schema_version: 1,
    storage_contract: "catalog-research-local-v1",
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      fingerprint,
    },
  };
}

async function verifyManagedResearchRuns() {
  const root = path.join(STORAGE_ROOT, "local", "research-runs");
  const manifests = (await listFiles(root)).filter((file) => file.relative.endsWith("manifest.json"));
  const differences = [];
  for (const entry of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(entry.absolute, "utf8"));
    } catch (error) {
      differences.push({ path: entry.absolute, issue: "invalid_managed_manifest", detail: error.message });
      continue;
    }
    if (manifest.storageContract !== "catalog-research-managed-run-v1" || !Array.isArray(manifest.files)) {
      differences.push({ path: entry.absolute, issue: "invalid_managed_contract" });
      continue;
    }
    const runRoot = path.dirname(entry.absolute);
    for (const file of manifest.files) {
      const absolute = path.resolve(runRoot, file.path);
      if (!absolute.startsWith(`${runRoot}${path.sep}`)) {
        differences.push({ path: file.path, issue: "managed_path_escape" });
        continue;
      }
      const stat = await fs.stat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (!stat) differences.push({ path: absolute, issue: "missing_managed_file" });
      else if (stat.size !== file.bytes || await sha256(absolute) !== file.sha256) {
        differences.push({ path: absolute, issue: "managed_hash_or_size_changed" });
      }
    }
  }
  return { manifests: manifests.length, differences };
}

const generated = await buildManifest();
const managedRuns = await verifyManagedResearchRuns();
if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  process.exit(0);
}

const expected = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
const actualByPath = new Map(generated.files.map((file) => [file.path, file]));
const differences = [];
differences.push(...managedRuns.differences);

for (const [filePath, file] of expectedByPath) {
  const actual = actualByPath.get(filePath);
  if (!actual) differences.push({ path: filePath, issue: "missing" });
  else if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
    differences.push({ path: filePath, issue: "hash_or_size_changed" });
  }
}
for (const filePath of actualByPath.keys()) {
  if (!expectedByPath.has(filePath)) differences.push({ path: filePath, issue: "unmanifested" });
}

for (const file of expected.checkpoint_files ?? []) {
  const absolute = path.resolve(REPO_ROOT, file.path);
  const stat = await fs.stat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) differences.push({ path: file.path, issue: "missing_checkpoint_file" });
  else if (stat.size !== file.bytes || await sha256(absolute) !== file.sha256) {
    differences.push({ path: file.path, issue: "checkpoint_hash_or_size_changed" });
  }
}

if (differences.length) {
  console.error(JSON.stringify({ storageRoot: STORAGE_ROOT, differences }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  storageRoot: STORAGE_ROOT,
  files: generated.totals.files,
  bytes: generated.totals.bytes,
  fingerprint: generated.totals.fingerprint,
  checkpointFiles: (expected.checkpoint_files ?? []).length,
  managedResearchRuns: managedRuns.manifests,
  status: "verified",
}, null, 2));
