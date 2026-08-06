import assert from "node:assert/strict";

const { isSafeStripLashAdhesive } = await import("../src/lib/admin/relation-recommendations.ts");

function candidate(overrides = {}) {
  return {
    id: "adhesive-1",
    code: "PEG-001",
    name: "Pegamento",
    slug: "pegamento",
    brandId: "brand-a",
    brandName: "Marca A",
    brandIsGeneric: false,
    productLineId: null,
    templateId: "template-adhesive",
    templateCode: "ADHESIVO_PRO",
    categoryId: "category-adhesive",
    categorySlug: "adhesivos-profesionales",
    attributes: {
      adhesive_application: "strip-lashes",
      adhesive_brand_scope: "universal"
    },
    ...overrides
  };
}

assert.equal(isSafeStripLashAdhesive(candidate(), { id: "brand-b", isGeneric: false }), true, "un adhesivo universal para tira puede recomendarse entre marcas");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "both", adhesive_brand_scope: "universal" } }), null), true, "un adhesivo universal autorizado para ambos usos es válido");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "extensions", adhesive_brand_scope: "universal" } }), { id: "brand-a", isGeneric: false }), false, "un adhesivo de extensiones no debe recomendarse para pestañas en tira");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "same-brand" } }), { id: "brand-a", isGeneric: false }), true, "un adhesivo limitado a la misma marca puede recomendarse dentro de esa marca");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "same-brand" } }), { id: "brand-b", isGeneric: false }), false, "un adhesivo limitado a otra marca no debe recomendarse");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "same-brand" } }), { id: "brand-a", isGeneric: true }), false, "una marca genérica no debe recibir recomendaciones limitadas a marca");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "specific-brand" } }), { id: "brand-a", isGeneric: false }), false, "un adhesivo de sistema específico requiere asociación manual");
assert.equal(isSafeStripLashAdhesive(candidate({ attributes: { adhesive_application: "strip-lashes", adhesive_brand_scope: "unconfirmed" } }), { id: "brand-a", isGeneric: false }), false, "una compatibilidad sin confirmar nunca debe recomendarse");
assert.equal(isSafeStripLashAdhesive(candidate({ templateCode: "PESTANA_TIRA" }), { id: "brand-a", isGeneric: false }), false, "un producto de otra familia no puede entrar como pegamento");

console.log("Recomendaciones contextuales: casos seguros y exclusiones verificados.");
