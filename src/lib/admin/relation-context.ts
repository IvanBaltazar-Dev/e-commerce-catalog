import type { AdminV2RelationCandidate } from "@/lib/admin/catalog-v2";

export type RelationSearchScope = "same_type" | "compatible" | "all";

export type RelationSourceContext = {
  templateCode: string;
  brandId?: string | null;
  brandIsGeneric?: boolean;
  accessoryDomain?: string | null;
  adhesiveApplication?: string | null;
  adhesiveBrandScope?: string | null;
};

const PRODUCT_TYPE_GROUPS = [
  { label: "Esmalte", codes: ["ESMALTE_TONOS"] },
  { label: "Pestaña en tira", codes: ["PESTANA_TIRA"] },
  { label: "Extensión profesional", codes: ["EXTENSIONES_PRO", "EXTENSIONES"] },
  { label: "Adhesivo", codes: ["ADHESIVO_PRO"] },
  { label: "Lámpara", codes: ["LAMPARA"] },
  { label: "Torno o pulidor", codes: ["TORNO_ELECTRICO"] },
  { label: "Máquina de corte", codes: ["MAQUINA_CORTE"] },
  { label: "Accesorio o repuesto", codes: ["ACCESORIO_REPUESTO"] }
] as const;

const AREA_BY_TEMPLATE: Record<string, "nails" | "lashes" | "barber" | "equipment"> = {
  ESMALTE_TONOS: "nails",
  LAMPARA: "nails",
  TORNO_ELECTRICO: "nails",
  PESTANA_TIRA: "lashes",
  EXTENSIONES_PRO: "lashes",
  EXTENSIONES: "lashes",
  ADHESIVO_PRO: "lashes",
  MAQUINA_CORTE: "barber",
  ACCESORIO_REPUESTO: "equipment"
};

function typeGroup(templateCode: string) {
  return PRODUCT_TYPE_GROUPS.find((group) => group.codes.some((code) => code === templateCode));
}

function isSameType(sourceTemplateCode: string, candidateTemplateCode: string) {
  const sourceGroup = typeGroup(sourceTemplateCode);
  return sourceGroup?.codes.some((code) => code === candidateTemplateCode) ?? sourceTemplateCode === candidateTemplateCode;
}

function brandScopeAllows(
  scope: unknown,
  adhesiveBrandId: string | null | undefined,
  targetBrandId: string | null | undefined,
  targetBrandIsGeneric: boolean
) {
  if (scope === "universal") return true;
  return scope === "same-brand"
    && Boolean(adhesiveBrandId && targetBrandId)
    && !targetBrandIsGeneric
    && adhesiveBrandId === targetBrandId;
}

function accessoryMatchesArea(candidate: AdminV2RelationCandidate, sourceArea: string | null) {
  const domain = candidate.attributes.accessory_domain;
  return domain === "universal" || Boolean(sourceArea && domain === sourceArea);
}

function sourceAdhesiveAllows(candidate: AdminV2RelationCandidate, source: RelationSourceContext) {
  if (!brandScopeAllows(source.adhesiveBrandScope, source.brandId, candidate.brandId, candidate.brandIsGeneric)) return false;
  if (candidate.templateCode === "PESTANA_TIRA") return source.adhesiveApplication === "strip-lashes" || source.adhesiveApplication === "both";
  if (candidate.templateCode === "EXTENSIONES_PRO" || candidate.templateCode === "EXTENSIONES") return source.adhesiveApplication === "extensions" || source.adhesiveApplication === "both";
  return false;
}

function candidateAdhesiveAllows(candidate: AdminV2RelationCandidate, source: RelationSourceContext) {
  if (source.templateCode === "PESTANA_TIRA") {
    const application = candidate.attributes.adhesive_application;
    if (application !== "strip-lashes" && application !== "both") return false;
    return brandScopeAllows(candidate.attributes.adhesive_brand_scope, candidate.brandId, source.brandId, Boolean(source.brandIsGeneric));
  }
  if (source.templateCode !== "EXTENSIONES_PRO" && source.templateCode !== "EXTENSIONES") return false;
  const application = candidate.attributes.adhesive_application;
  if (application !== "extensions" && application !== "both") return false;
  return brandScopeAllows(candidate.attributes.adhesive_brand_scope, candidate.brandId, source.brandId, Boolean(source.brandIsGeneric));
}

export function relationProductTypeLabel(templateCode: string) {
  return typeGroup(templateCode)?.label ?? "Otro tipo";
}

export function relationCandidateTemplateCodes(source: RelationSourceContext, scope: RelationSearchScope) {
  if (scope === "all") return null;
  const sameTypeCodes = [...(typeGroup(source.templateCode)?.codes ?? [source.templateCode])];
  if (scope === "same_type") return sameTypeCodes;

  const compatibleBySource: Record<string, string[]> = {
    PESTANA_TIRA: ["ADHESIVO_PRO", "ACCESORIO_REPUESTO"],
    EXTENSIONES_PRO: ["ADHESIVO_PRO", "ACCESORIO_REPUESTO"],
    EXTENSIONES: ["ADHESIVO_PRO", "ACCESORIO_REPUESTO"],
    ADHESIVO_PRO: ["PESTANA_TIRA", "EXTENSIONES_PRO", "EXTENSIONES", "ACCESORIO_REPUESTO"],
    ESMALTE_TONOS: ["LAMPARA", "TORNO_ELECTRICO", "ACCESORIO_REPUESTO"],
    LAMPARA: ["ESMALTE_TONOS", "ACCESORIO_REPUESTO"],
    TORNO_ELECTRICO: ["ESMALTE_TONOS", "ACCESORIO_REPUESTO"],
    MAQUINA_CORTE: ["ACCESORIO_REPUESTO"]
  };

  let compatibleCodes = compatibleBySource[source.templateCode] ?? [];
  if (source.templateCode === "ACCESORIO_REPUESTO") {
    compatibleCodes = source.accessoryDomain === "nails"
      ? ["ESMALTE_TONOS", "LAMPARA", "TORNO_ELECTRICO"]
      : source.accessoryDomain === "lashes"
        ? ["PESTANA_TIRA", "EXTENSIONES_PRO", "EXTENSIONES", "ADHESIVO_PRO"]
        : source.accessoryDomain === "barber"
          ? ["MAQUINA_CORTE"]
          : source.accessoryDomain === "universal"
            ? PRODUCT_TYPE_GROUPS.flatMap((group) => [...group.codes])
            : [];
  }

  return [...new Set([...sameTypeCodes, ...compatibleCodes])];
}

export function isRelationCandidateAllowed(
  candidate: AdminV2RelationCandidate,
  source: RelationSourceContext,
  scope: RelationSearchScope
) {
  if (scope === "all") return true;
  if (isSameType(source.templateCode, candidate.templateCode)) return true;
  if (scope === "same_type") return false;

  const sourceArea = source.templateCode === "ACCESORIO_REPUESTO"
    ? source.accessoryDomain ?? null
    : AREA_BY_TEMPLATE[source.templateCode] ?? null;

  if (candidate.templateCode === "ACCESORIO_REPUESTO") return accessoryMatchesArea(candidate, sourceArea);

  if (source.templateCode === "ACCESORIO_REPUESTO") {
    if (!sourceArea) return false;
    if (sourceArea === "universal") return true;
    return AREA_BY_TEMPLATE[candidate.templateCode] === sourceArea;
  }

  if (candidate.templateCode === "ADHESIVO_PRO") return candidateAdhesiveAllows(candidate, source);
  if (source.templateCode === "ADHESIVO_PRO") return sourceAdhesiveAllows(candidate, source);

  if (source.templateCode === "ESMALTE_TONOS") return candidate.templateCode === "LAMPARA" || candidate.templateCode === "TORNO_ELECTRICO";
  if (source.templateCode === "LAMPARA") return candidate.templateCode === "ESMALTE_TONOS";
  if (source.templateCode === "TORNO_ELECTRICO") return candidate.templateCode === "ESMALTE_TONOS";

  return false;
}
