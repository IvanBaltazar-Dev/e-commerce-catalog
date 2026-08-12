import crypto from "node:crypto";

export const OFFICIAL_SEMANTIC_NORMALIZER_VERSION = "official-semantic-normalizer-v1";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeSemanticText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function htmlToText(value) {
  return String(value ?? "")
    .replace(/<\s*br\s*\/?\s*>/gi, ". ")
    .replace(/<\/(?:li|p|div|ul|ol|h[1-6])\s*>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function evidenceUnits(product) {
  const description = htmlToText(product.body_html);
  const descriptionUnits = description
    .split(/(?<=[.!?])\s+|\s*[;]\s*/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [
    { field: "title", value: String(product.title ?? "") },
    { field: "product_type", value: String(product.product_type ?? "") },
    ...(Array.isArray(product.tags) ? product.tags : []).map((value) => ({ field: "tag", value: String(value) })),
    ...descriptionUnits.map((value) => ({ field: "description", value })),
  ].map((unit) => ({ ...unit, normalized: normalizeSemanticText(unit.value) }));
}

function claimFromUnit(rule, unit, extra = {}) {
  const evidenceFingerprint = sha256(JSON.stringify({
    dimension: rule.dimension,
    code: rule.code,
    field: unit.field,
    value: unit.value,
    extra,
  }));
  return {
    dimension: rule.dimension,
    code: rule.code,
    label: rule.label,
    claimKind: rule.claimKind ?? (unit.field === "description" ? "manufacturer_declared" : "source_taxonomy"),
    confidence: rule.confidence ?? (unit.field === "description" ? 0.95 : 1),
    ruleCode: rule.ruleCode,
    sourceField: unit.field,
    sourceValue: unit.value,
    sourceExcerpt: unit.value.slice(0, 500),
    evidenceFingerprint,
    metadata: { ...extra, ...(rule.metadata ?? {}) },
  };
}

function firstMatchingUnit(units, rule) {
  const allowed = new Set(rule.fields ?? ["title", "product_type", "tag", "description"]);
  return units.find((unit) => allowed.has(unit.field) && rule.patterns.some((pattern) => pattern.test(unit.normalized)));
}

function addRuleClaims(claims, units, rules) {
  for (const rule of rules) {
    const unit = firstMatchingUnit(units, rule);
    if (unit) claims.push(claimFromUnit(rule, unit));
  }
}

const TYPE_RULES = [
  { dimension: "type", code: "nail_polish", label: "Esmalte de uñas", fields: ["product_type"], patterns: [/^esmaltes?$/], ruleCode: "type:nail-polish" },
  { dimension: "type", code: "nail_base", label: "Base para uñas", fields: ["product_type"], patterns: [/^bases?$/], ruleCode: "type:nail-base" },
  { dimension: "type", code: "nail_top_coat", label: "Brillo / capa final", fields: ["product_type"], patterns: [/^brillos?$/], ruleCode: "type:nail-top-coat" },
  { dimension: "type", code: "nail_liquid", label: "Líquido para manicure", fields: ["product_type"], patterns: [/^liquidos?$/], ruleCode: "type:nail-liquid" },
  { dimension: "type", code: "nail_file", label: "Lima para uñas", fields: ["product_type"], patterns: [/^limas?$/], ruleCode: "type:nail-file" },
  { dimension: "type", code: "kit", label: "Kit", fields: ["product_type"], patterns: [/^kits?$/], ruleCode: "type:kit" },
];

const SUBTYPE_RULES = [
  { dimension: "subtype", code: "nail_art_polish", label: "Esmalte de decoración", fields: ["title", "tag"], patterns: [/esmalte decoracion|\bdecoracion\b/], ruleCode: "subtype:nail-art" },
  { dimension: "subtype", code: "traditional_nail_polish", label: "Esmalte tradicional", fields: ["title", "tag"], patterns: [/esmalte tradicional/], ruleCode: "subtype:traditional-polish" },
  { dimension: "subtype", code: "traditional_nail_base", label: "Base tradicional", fields: ["title", "tag"], patterns: [/base tradicional/], ruleCode: "subtype:traditional-base" },
  { dimension: "subtype", code: "traditional_top_coat", label: "Brillo tradicional", fields: ["title", "tag"], patterns: [/brillo tradicional/], ruleCode: "subtype:traditional-top" },
  { dimension: "subtype", code: "nail_polish_remover", label: "Removedor de esmalte", fields: ["title", "tag", "description"], patterns: [/removedor (?:tradicional )?de esmalte|removedor tradicional/], ruleCode: "subtype:polish-remover" },
  { dimension: "subtype", code: "cuticle_remover", label: "Removedor de cutícula", fields: ["title", "description"], patterns: [/removedor de cuticula/], ruleCode: "subtype:cuticle-remover" },
  { dimension: "subtype", code: "nail_file", label: "Lima para uñas", fields: ["title", "product_type"], patterns: [/\blima\b|^limas$/], ruleCode: "subtype:nail-file" },
  { dimension: "subtype", code: "multi_product_kit", label: "Kit multiproducto", fields: ["title", "tag"], patterns: [/\bkit\b/], ruleCode: "subtype:kit" },
];

const CONCERN_RULES = [
  { dimension: "concern", code: "fragile_nails", label: "Uñas frágiles", fields: ["description"], patterns: [/unas fragiles|unas delgadas que se parten|unas? (?:fragiles y )?escamadas/], ruleCode: "concern:fragile-nails" },
  { dimension: "concern", code: "weak_damaged_nails", label: "Uñas débiles o maltratadas", fields: ["description"], patterns: [/unas debiles|unas? maltratadas/], ruleCode: "concern:weak-damaged-nails" },
  { dimension: "concern", code: "dry_cuticle_skin", label: "Cutícula o piel con falta de humectación", fields: ["description"], patterns: [/humectacion de la piel|cuticula.*humect/], ruleCode: "concern:dry-cuticle" },
];

const BENEFIT_RULES = [
  { dimension: "benefit", code: "strengthening", label: "Fortalecimiento declarado", fields: ["description"], patterns: [/fortalec|aumenta la resistencia|mas cuerpo y resistencia/], ruleCode: "benefit:strengthening" },
  { dimension: "benefit", code: "nourishing", label: "Acción nutritiva declarada", fields: ["description"], patterns: [/accion nutritiva|nutritiv/], ruleCode: "benefit:nourishing" },
  { dimension: "benefit", code: "moisturizing", label: "Humectación declarada", fields: ["description"], patterns: [/humect|hidrat/], ruleCode: "benefit:moisturizing" },
  { dimension: "benefit", code: "protection", label: "Protección declarada", fields: ["description"], patterns: [/\bprotege\b|proteccion/], ruleCode: "benefit:protection" },
  { dimension: "benefit", code: "high_coverage", label: "Alta cobertura declarada", fields: ["description"], patterns: [/alta cobertura/], ruleCode: "benefit:high-coverage" },
  { dimension: "benefit", code: "long_wear", label: "Duración declarada", fields: ["description"], patterns: [/duracion|duradero|por mas tiempo/], ruleCode: "benefit:long-wear" },
  { dimension: "benefit", code: "fast_drying", label: "Secado rápido declarado", fields: ["description"], patterns: [/secado (?:mas )?rapido/], ruleCode: "benefit:fast-drying" },
  { dimension: "benefit", code: "softens_cuticle", label: "Ablandamiento de cutícula declarado", fields: ["description"], patterns: [/ablanda la cuticula/], ruleCode: "benefit:softens-cuticle" },
  { dimension: "benefit", code: "facilitates_removal", label: "Facilita remoción", fields: ["description"], patterns: [/facilitando su remocion|facilita.*remocion/], ruleCode: "benefit:facilitates-removal" },
  { dimension: "benefit", code: "easy_application", label: "Aplicación fácil declarada", fields: ["description"], patterns: [/facil aplicacion/], ruleCode: "benefit:easy-application" },
  { dimension: "benefit", code: "shine", label: "Brillo declarado", fields: ["description"], patterns: [/efecto brillante|extra brillante|realza.*color/], ruleCode: "benefit:shine" },
];

const INGREDIENT_RULES = [
  { dimension: "ingredient", code: "biotin", label: "Biotina", fields: ["description"], patterns: [/\bbiotina\b/], ruleCode: "ingredient:biotin" },
  { dimension: "ingredient", code: "urea", label: "Urea", fields: ["description"], patterns: [/\burea\b/], ruleCode: "ingredient:urea" },
  { dimension: "ingredient", code: "garlic_extract", label: "Extracto de ajo", fields: ["description"], patterns: [/extracto de ajo/], ruleCode: "ingredient:garlic-extract" },
  { dimension: "ingredient", code: "lemon_extract", label: "Extracto de limón", fields: ["description"], patterns: [/extracto de limon/], ruleCode: "ingredient:lemon-extract" },
  { dimension: "ingredient", code: "glycerin", label: "Glicerina", fields: ["description"], patterns: [/\bglicerina\b/], ruleCode: "ingredient:glycerin" },
  { dimension: "ingredient", code: "calcium", label: "Calcio", fields: ["description"], patterns: [/contiene calcio|con calcio/], ruleCode: "ingredient:calcium" },
];

const USE_RULES = [
  { dimension: "use", code: "fragile_nails_care", label: "Cuidado de uñas frágiles", fields: ["description"], patterns: [/unas fragiles|unas delgadas que se parten|unas? escamadas/], ruleCode: "use:fragile-nails" },
  { dimension: "use", code: "weak_damaged_nails_care", label: "Cuidado de uñas débiles o maltratadas", fields: ["description"], patterns: [/unas debiles|unas? maltratadas/], ruleCode: "use:weak-damaged-nails" },
  { dimension: "use", code: "nail_decoration", label: "Decoración de uñas", fields: ["title", "description"], patterns: [/decoracion|realizar decoraciones/], ruleCode: "use:nail-decoration" },
  { dimension: "use", code: "remove_nail_polish", label: "Retirar esmalte", fields: ["title", "description"], patterns: [/removedor.*esmalte|limpieza perfecta/], ruleCode: "use:remove-polish" },
  { dimension: "use", code: "cuticle_preparation", label: "Preparación de cutícula", fields: ["title", "description"], patterns: [/removedor de cuticula|ablanda la cuticula/], ruleCode: "use:cuticle-preparation" },
  { dimension: "use", code: "protect_manicure", label: "Proteger manicure o color", fields: ["description"], patterns: [/protege.*(?:manicure|color)|realza y protege/], ruleCode: "use:protect-manicure" },
];

const FORMULATION_RULES = [
  { dimension: "formulation", code: "10_free", label: "Formulación 10 Free", fields: ["description", "title", "tag"], patterns: [/\b10 free\b/], ruleCode: "formulation:10-free" },
  { dimension: "formulation", code: "5_free", label: "Formulación 5 Free", fields: ["description", "title", "tag"], patterns: [/\b5 free\b/], ruleCode: "formulation:5-free" },
  { dimension: "formulation", code: "acetone_free", label: "Libre de acetona", fields: ["description"], patterns: [/libre de acetona/], ruleCode: "formulation:acetone-free" },
  { dimension: "formulation", code: "gel", label: "Gel", fields: ["description", "title", "tag"], patterns: [/formula en gel|\bjelly\b/], ruleCode: "formulation:gel" },
];

const FINISH_RULES = [
  { dimension: "finish", code: "creamy", label: "Cremoso", fields: ["title", "tag"], patterns: [/\bcremosos?\b/], ruleCode: "finish:creamy" },
  { dimension: "finish", code: "pearlescent", label: "Perlado", fields: ["title", "tag"], patterns: [/\bperlados?\b/], ruleCode: "finish:pearlescent" },
  { dimension: "finish", code: "metallic", label: "Metalizado", fields: ["title", "tag"], patterns: [/\bmetalizados?\b/], ruleCode: "finish:metallic" },
  { dimension: "finish", code: "translucent", label: "Traslúcido", fields: ["title", "tag"], patterns: [/\btraslucidos?\b/], ruleCode: "finish:translucent" },
  { dimension: "finish", code: "glitter", label: "Escarchado", fields: ["title", "tag"], patterns: [/\bescarchados?\b/], ruleCode: "finish:glitter" },
  { dimension: "finish", code: "jelly", label: "Jelly", fields: ["title", "tag"], patterns: [/\bjelly\b/], ruleCode: "finish:jelly" },
  { dimension: "finish", code: "with_particles", label: "Con partículas", fields: ["title", "tag", "description"], patterns: [/con particulas|particulas plateadas/], ruleCode: "finish:with-particles" },
  { dimension: "finish", code: "without_particles", label: "Sin partículas", fields: ["title", "tag"], patterns: [/sin particulas/], ruleCode: "finish:without-particles" },
  { dimension: "finish", code: "glossy", label: "Brillante", fields: ["description"], patterns: [/acabado.*brillante|efecto brillante|extra brillante/], ruleCode: "finish:glossy" },
];

const ROLE_BY_SUBTYPE = {
  nail_art_polish: ["nail_art_color", "Color para decoración"],
  traditional_nail_polish: ["color_coat", "Capa de color"],
  traditional_nail_base: ["base_coat", "Capa base"],
  traditional_top_coat: ["top_coat", "Capa final / top coat"],
  nail_polish_remover: ["polish_remover", "Removedor de esmalte"],
  cuticle_remover: ["cuticle_preparation", "Preparación de cutícula"],
  nail_file: ["nail_shaping", "Modelado de uñas"],
  multi_product_kit: ["multi_product_kit", "Kit multiproducto"],
};

const STAGE_BY_ROLE = {
  nail_art_color: ["color", "Color / decoración"],
  color_coat: ["color", "Color"],
  base_coat: ["base", "Base"],
  top_coat: ["finish", "Finalización"],
  polish_remover: ["removal", "Retiro"],
  cuticle_preparation: ["preparation", "Preparación"],
  nail_shaping: ["preparation", "Preparación"],
  multi_product_kit: ["multi_stage", "Múltiples etapas"],
};

const SYSTEM_BY_SUBTYPE = {
  nail_art_polish: ["traditional_nail_system", "Sistema tradicional de manicure"],
  traditional_nail_polish: ["traditional_nail_system", "Sistema tradicional de manicure"],
  traditional_nail_base: ["traditional_nail_system", "Sistema tradicional de manicure"],
  traditional_top_coat: ["traditional_nail_system", "Sistema tradicional de manicure"],
  nail_polish_remover: ["traditional_nail_system", "Sistema tradicional de manicure"],
  cuticle_remover: ["manicure_care_system", "Sistema de cuidado de manicure"],
  nail_file: ["manicure_care_system", "Sistema de cuidado de manicure"],
  multi_product_kit: ["mixed_manicure_system", "Sistema mixto de manicure"],
};

function primarySubtypeClaim(claims) {
  const subtypeClaims = claims.filter((claim) => claim.dimension === "subtype");
  const type = claims.find((claim) => claim.dimension === "type")?.code;
  const codes = new Map(subtypeClaims.map((claim) => [claim.code, claim]));
  if (codes.has("multi_product_kit")) return codes.get("multi_product_kit");
  if (type === "nail_base") return codes.get("traditional_nail_base") ?? subtypeClaims[0];
  if (type === "nail_top_coat") return codes.get("traditional_top_coat") ?? subtypeClaims[0];
  if (type === "nail_liquid") {
    return codes.get("cuticle_remover") ?? codes.get("nail_polish_remover") ?? subtypeClaims[0];
  }
  if (type === "nail_file") return codes.get("nail_file") ?? subtypeClaims[0];
  if (type === "nail_polish") {
    return codes.get("nail_art_polish") ?? codes.get("traditional_nail_polish") ?? subtypeClaims[0];
  }
  return subtypeClaims[0];
}

function addDerivedClaim(claims, dimension, code, label, sourceClaim, ruleCode) {
  const rule = {
    dimension,
    code,
    label,
    claimKind: "normalized_from_source",
    confidence: 0.9,
    ruleCode,
  };
  claims.push(claimFromUnit(rule, {
    field: sourceClaim.sourceField,
    value: sourceClaim.sourceValue,
  }, { derivedFromDimension: sourceClaim.dimension, derivedFromCode: sourceClaim.code }));
}

function expectedTypeForCollection(title) {
  const normalized = normalizeSemanticText(title);
  if (/\bbases?\b/.test(normalized)) return "nail_base";
  if (/\bbrillos?\b/.test(normalized)) return "nail_top_coat";
  if (/\besmaltes?\b/.test(normalized)) return "nail_polish";
  if (/\bremovedores?\b/.test(normalized)) return "nail_liquid";
  if (/\bherramientas?\b/.test(normalized)) return "nail_file";
  if (/\bkits?\b/.test(normalized)) return "kit";
  return null;
}

export function extractOfficialProductSemantics({ product, sourceKey, brandName, collectionMemberships = [] }) {
  const units = evidenceUnits(product);
  const claims = [];
  addRuleClaims(claims, units, TYPE_RULES);
  addRuleClaims(claims, units, SUBTYPE_RULES);
  addRuleClaims(claims, units, CONCERN_RULES);
  addRuleClaims(claims, units, BENEFIT_RULES);
  addRuleClaims(claims, units, INGREDIENT_RULES);
  addRuleClaims(claims, units, USE_RULES);
  addRuleClaims(claims, units, FORMULATION_RULES);
  addRuleClaims(claims, units, FINISH_RULES);

  const subtype = primarySubtypeClaim(claims);
  if (subtype) {
    const role = ROLE_BY_SUBTYPE[subtype.code];
    if (role) addDerivedClaim(claims, "role", role[0], role[1], subtype, `role:${role[0]}`);
    const stage = role ? STAGE_BY_ROLE[role[0]] : null;
    if (stage) addDerivedClaim(claims, "stage", stage[0], stage[1], subtype, `stage:${stage[0]}`);
    const system = SYSTEM_BY_SUBTYPE[subtype.code];
    if (system) {
      addDerivedClaim(claims, "system", system[0], system[1], subtype, `system:${system[0]}`);
      if (brandName) {
        addDerivedClaim(
          claims,
          "system",
          `official_brand_system:${sourceKey}`,
          `Sistema ${brandName}: ${system[1]}`,
          subtype,
          "system:official-brand-system",
        );
      }
    }
  }

  const type = claims.find((claim) => claim.dimension === "type");
  for (const collection of collectionMemberships) {
    const collectionCode = `commercial_collection:${sourceKey}:${collection.id}`;
    const collectionRule = {
      dimension: "relation",
      code: collectionCode,
      label: `Colección comercial: ${collection.title}`,
      claimKind: "official_collection_membership",
      confidence: 1,
      ruleCode: "relation:commercial-collection",
    };
    claims.push(claimFromUnit(collectionRule, {
      field: "collection_membership",
      value: collection.title,
    }, {
      relationType: "member_of_commercial_collection",
      collectionId: String(collection.id),
      collectionHandle: collection.handle,
    }));

    const expectedType = expectedTypeForCollection(collection.title);
    if (expectedType && type && expectedType !== type.code) {
      const mismatchRule = {
        dimension: "relation",
        code: `commercial_collection_type_mismatch:${sourceKey}:${collection.id}`,
        label: `Colección ${collection.title} no coincide con tipo ${type.label}`,
        claimKind: "normalized_source_contradiction",
        confidence: 1,
        ruleCode: "relation:collection-type-mismatch",
      };
      claims.push(claimFromUnit(mismatchRule, {
        field: "collection_membership",
        value: collection.title,
      }, {
        relationType: "commercial_collection_type_mismatch",
        collectionId: String(collection.id),
        collectionHandle: collection.handle,
        expectedType,
        observedType: type.code,
      }));
    }
  }

  const deduped = new Map();
  for (const claim of claims) {
    const key = `${claim.dimension}:${claim.code}:${claim.evidenceFingerprint}`;
    if (!deduped.has(key)) deduped.set(key, claim);
  }
  return [...deduped.values()];
}
