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

const generated = await buildManifest();
if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`);
  process.exit(0);
}

const expected = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
const actualByPath = new Map(generated.files.map((file) => [file.path, file]));
const differences = [];

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
  status: "verified",
}, null, 2));
