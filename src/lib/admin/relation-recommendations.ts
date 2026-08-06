import type { AdminV2RelationCandidate } from "@/lib/admin/catalog-v2";

export type RelationTargetBrand = {
  id: string;
  isGeneric: boolean;
};

export function isSafeStripLashAdhesive(candidate: AdminV2RelationCandidate, targetBrand?: RelationTargetBrand | null) {
  if (candidate.templateCode !== "ADHESIVO_PRO") return false;

  const application = candidate.attributes.adhesive_application;
  if (application !== "strip-lashes" && application !== "both") return false;

  const scope = candidate.attributes.adhesive_brand_scope;
  if (scope === "universal") return true;

  return scope === "same-brand"
    && Boolean(targetBrand)
    && targetBrand?.isGeneric === false
    && candidate.brandId === targetBrand?.id;
}

export function stripLashAdhesiveRecommendationReason(candidate: AdminV2RelationCandidate) {
  return candidate.attributes.adhesive_brand_scope === "universal"
    ? "Compatible con cualquier marca"
    : "Compatible por ser de la misma marca";
}
