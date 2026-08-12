import path from "node:path";

export function catalogResearchStorageRoot(repoRoot = process.cwd()) {
  return path.resolve(
    process.env.CATALOG_RESEARCH_STORAGE_ROOT
      || path.join(repoRoot, "research", "catalog-master"),
  );
}

export function catalogResearchPath(repoRoot, ...segments) {
  return path.join(catalogResearchStorageRoot(repoRoot), ...segments);
}

export function configuredCatalogPath(envName, repoRoot, ...fallbackSegments) {
  return path.resolve(
    process.env[envName]
      || catalogResearchPath(repoRoot, ...fallbackSegments),
  );
}

export function requireConfiguredCatalogPath(envName, repoRoot, ...fallbackSegments) {
  const value = configuredCatalogPath(envName, repoRoot, ...fallbackSegments);
  if (!value) {
    throw new Error(`Configura ${envName}.`);
  }
  return value;
}
