import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractOfficialProductSemantics } from "../src/lib/catalog-intelligence/official-semantic-normalizer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const moduleSource = fs.readFileSync(
  path.join(ROOT, "src", "lib", "catalog-intelligence", "official-semantic-normalizer.mjs"),
  "utf8",
);
assert(!/admiss|ajo y limon|vitamin plus|zac\b/i.test(moduleSource),
  "El normalizador contiene una regla o producto especifico de ADMISS.");

const fixture = {
  id: "generic-base-1",
  title: "BASE TRADICIONAL FORTALECEDORA 10 ML",
  product_type: "BASES",
  tags: ["ESMALTE TRADICIONAL", "10 FREE"],
  body_html: "<p>La fuente declara que es ideal para uñas débiles y maltratadas. Contiene Biotina, Urea, extracto de ajo y extracto de limón. Ayuda a fortalecer e hidratar.</p>",
};
const collections = [
  { id: "base", handle: "bases", title: "Bases", productIds: [fixture.id] },
  { id: "polish", handle: "esmaltes", title: "Esmaltes", productIds: [fixture.id] },
];
const first = extractOfficialProductSemantics({
  product: fixture,
  sourceKey: "generic-official-source",
  brandName: "Marca Ejemplo",
  collectionMemberships: collections,
});
const second = extractOfficialProductSemantics({
  product: fixture,
  sourceKey: "generic-official-source",
  brandName: "Marca Ejemplo",
  collectionMemberships: collections,
});

const has = (dimension, code) => first.some((claim) => claim.dimension === dimension && claim.code === code);
assert(has("type", "nail_base"), "No normalizo el tipo de base.");
assert(has("subtype", "traditional_nail_base"), "No normalizo el subtipo de base.");
assert(has("concern", "weak_damaged_nails"), "No normalizo concern declarado.");
assert(has("benefit", "strengthening"), "No normalizo fortalecimiento declarado.");
assert(has("ingredient", "biotin") && has("ingredient", "urea"), "No normalizo Biotina/Urea.");
assert(has("ingredient", "garlic_extract") && has("ingredient", "lemon_extract"), "No normalizo extractos.");
assert(has("role", "base_coat") && has("stage", "base"), "La etiqueta contradictoria altero rol/etapa primarios.");
assert(has("system", "official_brand_system:generic-official-source"), "No genero el sistema de marca desde contexto.");
assert(has("formulation", "10_free"), "No normalizo formulacion.");
assert(first.some((claim) => claim.dimension === "relation"
  && claim.code === "commercial_collection_type_mismatch:generic-official-source:polish"),
"No conservo la contradiccion coleccion/tipo.");
assert(first.filter((claim) => claim.sourceField === "description")
  .every((claim) => claim.claimKind === "manufacturer_declared"),
"Un claim descriptivo dejo de distinguirse como declaracion del fabricante.");
assert(first.every((claim) => claim.sourceExcerpt.length <= 500 && claim.evidenceFingerprint.length === 64),
  "La evidencia no conserva excerpt acotado y fingerprint.");
assert(JSON.stringify(first) === JSON.stringify(second), "El normalizador no es determinista/idempotente.");

process.stdout.write(`${JSON.stringify({
  status: "passed",
  rulesAreBrandAgnostic: true,
  deterministic: true,
  claims: first.length,
  dimensions: [...new Set(first.map((claim) => claim.dimension))].sort(),
}, null, 2)}\n`);
