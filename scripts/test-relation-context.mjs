import assert from "node:assert/strict";

const { isRelationCandidateAllowed, relationCandidateTemplateCodes } = await import("../src/lib/admin/relation-context.ts");

function candidate(overrides = {}) {
  return {
    id: "product-a",
    code: "PROD-A",
    name: "Producto A",
    slug: "producto-a",
    brandId: "brand-a",
    brandName: "Marca A",
    brandIsGeneric: false,
    productLineId: null,
    templateId: "template-a",
    templateCode: "PESTANA_TIRA",
    categoryId: "category-a",
    categorySlug: "pestanas-en-tira",
    attributes: {},
    ...overrides
  };
}

const stripLash = { templateCode: "PESTANA_TIRA", brandId: "brand-a", brandIsGeneric: false };
const safeGlue = candidate({
  templateCode: "ADHESIVO_PRO",
  attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "universal" }
});

assert.equal(isRelationCandidateAllowed(candidate(), stripLash, "same_type"), true, "pestañas en tira deben verse entre sí");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ESMALTE_TONOS" }), stripLash, "same_type"), false, "un esmalte no debe aparecer en el filtro del mismo tipo");
assert.equal(isRelationCandidateAllowed(safeGlue, stripLash, "compatible"), true, "un pegamento seguro para tira puede mostrarse como familia compatible");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ADHESIVO_PRO", attributes: { adhesive_application: "extensions", adhesive_brand_scope: "universal" } }), stripLash, "compatible"), false, "un pegamento de extensiones no corresponde a pestañas en tira");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ACCESORIO_REPUESTO", attributes: { accessory_domain: "lashes" } }), stripLash, "compatible"), true, "un accesorio de pestañas puede mostrarse en pestañas");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ACCESORIO_REPUESTO", attributes: { accessory_domain: "nails" } }), stripLash, "compatible"), false, "un accesorio de uñas no puede mezclarse con pestañas");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ACCESORIO_REPUESTO", attributes: { accessory_domain: "universal" } }), stripLash, "compatible"), true, "un accesorio universal puede aparecer en cualquier área");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "ESMALTE_TONOS" }), stripLash, "all"), true, "el modo avanzado permite todo el catálogo de forma explícita");

const nailPolish = { templateCode: "ESMALTE_TONOS", brandId: "brand-a", brandIsGeneric: false };
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "TORNO_ELECTRICO" }), nailPolish, "compatible"), true, "un esmalte puede relacionarse manualmente con un torno");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "LAMPARA" }), nailPolish, "compatible"), true, "un esmalte puede relacionarse manualmente con una lámpara");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "MAQUINA_CORTE" }), nailPolish, "compatible"), false, "barbería no corresponde al área de uñas");

const nailAccessory = { templateCode: "ACCESORIO_REPUESTO", accessoryDomain: "nails" };
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "TORNO_ELECTRICO" }), nailAccessory, "compatible"), true, "un accesorio de uñas puede relacionarse con un torno");
assert.equal(isRelationCandidateAllowed(candidate({ templateCode: "PESTANA_TIRA" }), nailAccessory, "compatible"), false, "un accesorio de uñas no debe sugerir pestañas");
assert.deepEqual(relationCandidateTemplateCodes(stripLash, "same_type"), ["PESTANA_TIRA"], "la consulta predeterminada debe limitarse desde la base al mismo tipo");
assert.deepEqual(relationCandidateTemplateCodes(stripLash, "compatible"), ["PESTANA_TIRA", "ADHESIVO_PRO", "ACCESORIO_REPUESTO"], "la consulta compatible solo debe traer familias cercanas antes del filtrado fino");
assert.equal(relationCandidateTemplateCodes(stripLash, "all"), null, "el modo avanzado es el único que consulta todas las plantillas");

console.log("Relaciones contextuales: tipos, áreas y modo avanzado verificados.");
