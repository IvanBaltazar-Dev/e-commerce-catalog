import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/api/errors";
import type {
  CatalogReviewActivity,
  CatalogReviewBootstrap,
  CatalogReviewCase,
  CatalogReviewCommandResult,
  CatalogReviewDecisionScope,
  CatalogReviewEntity,
  CatalogReviewEvidence,
  CatalogReviewHistoryEvent,
  CatalogReviewListResult,
  CatalogReviewOption,
  CatalogReviewResolveInput,
  CatalogReviewSummary,
  CatalogReviewTarget,
  CatalogReviewTransitionInput,
} from "@/lib/admin/catalog-review";

type Supabase = SupabaseClient;
type JsonObject = Record<string, unknown>;

type QueueRow = {
  id: string;
  work_key: string;
  row_version: number | string;
  source_type: string;
  source_id: string | null;
  work_kind: string;
  purpose: string;
  subject_type: string;
  subject_id: string | null;
  group_key: string | null;
  risk_level: "critical" | "high" | "normal" | "low";
  has_contradiction: boolean;
  unlock_count: number | string;
  blocked_by_count: number | string;
  invalidated_by_count: number | string;
  question: string;
  recommendation: string | null;
  context: JsonObject;
  created_at: string;
  deferred_until: string | null;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nestedName(value: unknown): string | null {
  if (Array.isArray(value)) return text(object(value[0]).name);
  return text(object(value).name);
}

function nestedLabel(value: unknown): string | null {
  if (Array.isArray(value)) return text(object(value[0]).label);
  return text(object(value).label);
}

function rpcFailure(error: { code?: string; message: string }, fallbackCode: string): never {
  if (error.code === "40001") {
    throw new HttpError(
      409,
      "catalog_review_stale",
      "Otra sesión actualizó este caso. Ya cargamos la información vigente para que puedas continuar.",
      { supabaseCode: error.code },
    );
  }
  if (error.code === "23514" || error.code === "23505") {
    throw new HttpError(409, "catalog_review_conflict", error.message, { supabaseCode: error.code });
  }
  if (error.code === "22023") {
    throw new HttpError(422, "catalog_review_invalid_decision", error.message, { supabaseCode: error.code });
  }
  if (error.code === "42501") {
    throw new HttpError(403, "catalog_review_forbidden", error.message, { supabaseCode: error.code });
  }
  throw new HttpError(400, fallbackCode, error.message, { supabaseCode: error.code });
}

function assetUrl(supabase: Supabase, path: string | null, bucket = "catalog-assets"): string | null {
  if (!path) return null;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function relatedObject(value: unknown): JsonObject {
  return Array.isArray(value) ? object(value[0]) : object(value);
}

function sourceSnapshotFor(row: QueueRow): CatalogReviewEntity["sourceSnapshot"] {
  const evidence = object(object(row.context).evidence);
  const snapshot = object(evidence.internal_source);
  const fields = object(snapshot.fields);
  const labels: Array<[string, string]> = [
    ["proposed_category", "Categoría propuesta"],
    ["proposed_family", "Familia propuesta"],
    ["review_status", "Estado de revisión"],
    ["original_code", "Código"],
    ["brand_or_line", "Marca o línea"],
    ["original_description", "Descripción original"],
    ["original_category", "Categoría original"],
    ["supplier_code", "Código proveedor"],
    ["supplier", "Proveedor"],
  ];
  const visible = labels.flatMap(([key, label]) => {
    const value = text(fields[key]);
    return value ? [{ label, value }] : [];
  });
  if (!visible.length) return null;
  const rowNumber = Number(snapshot.row_number);
  return {
    fileName: text(snapshot.file_name) ?? "Archivo de carga",
    sheet: text(snapshot.sheet) ?? "Hoja no registrada",
    rowNumber: Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : null,
    fields: visible,
  };
}

function purposeLabel(purpose: string) {
  return ({
    identity: "Identidad",
    variant_structure: "Variantes",
    tone: "Tono",
    image: "Imagen",
    attribute: "Atributo",
    classification: "Clasificación",
    relation: "Relación",
    source_verification: "Fuente",
    other: "Revisión",
  } as Record<string, string>)[purpose] ?? "Revisión";
}

function caseKind(row: QueueRow): CatalogReviewCase["caseKind"] {
  if (row.source_type === "reconciliation_case") return "identity_match";
  if (row.purpose === "identity") return "identity_conflict";
  if (row.purpose === "image") return "image_review";
  if (row.purpose === "classification") return "classification";
  if (row.purpose === "relation") return "relation_evidence";
  if (row.purpose === "source_verification") return "source_verification";
  return "general_decision";
}

function isFamilyMembershipCase(row: QueueRow) {
  return row.source_type === "reconciliation_case"
    && row.subject_type === "product"
    && row.purpose === "identity";
}

function titleFor(row: QueueRow) {
  if (row.context.semanticOrigin === "problem_group") {
    return "Resuelve una ambigüedad compartida de la regla";
  }
  switch (caseKind(row)) {
    case "identity_match": return isFamilyMembershipCase(row)
      ? "Confirma la familia de esta ficha oficial"
      : "Confirma la identidad de este producto";
    case "identity_conflict": return "Aclara qué producto representa este registro";
    case "image_review": return "Comprueba si esta imagen corresponde";
    case "classification": return "Confirma dónde pertenece este producto";
    case "relation_evidence": return "Evalúa qué demuestra esta relación";
    case "source_verification": return "Verifica la información de la fuente";
    default: return "Toma una decisión sobre este registro";
  }
}

function questionFor(row: QueueRow) {
  const evidence = object(row.context.evidence);
  const official = text(evidence.official_title) ?? row.recommendation ?? "Esta ficha oficial";
  const internal = text(evidence.internal_name) ?? "esta familia del catálogo";
  switch (caseKind(row)) {
    case "identity_match": return isFamilyMembershipCase(row)
      ? `¿«${official}» pertenece a la familia ${internal}?`
      : "¿El registro oficial y el registro interno representan la misma variante comercial?";
    case "identity_conflict": return "¿La evidencia disponible permite confirmar la identidad sin adivinar?";
    case "image_review": return "¿La imagen muestra exactamente esta presentación o variante?";
    case "classification": return "¿La evidencia confirma esta clasificación?";
    case "relation_evidence": return "¿La evidencia demuestra la relación propuesta y no solo una coincidencia de marca o sistema?";
    default: return row.question;
  }
}

function optionsFor(row: QueueRow): CatalogReviewOption[] {
  if (row.context.semanticOrigin === "problem_group") {
    return [{
      id: "complete-rule-decision",
      actionCode: "complete",
      label: "Registrar criterio de regla",
      description: "Resuelve una sola vez el problema compartido; el motor reprocesará el conjunto afectado.",
      tone: "confirm",
      requiresReason: true,
    }];
  }

  if (row.source_type === "reconciliation_case") {
    const productFamily = isFamilyMembershipCase(row);
    return [
      {
        id: "approve",
        actionCode: "approve",
        label: productFamily ? "Sí, pertenece a esta familia" : "Sí, es la misma variante",
        description: productFamily
          ? "Confirma solo la familia; no la identifica como uno de los tonos que ya existen."
          : "Confirma que ambos registros representan exactamente la misma variante.",
        tone: "confirm",
        requiresReason: true,
      },
      {
        id: "reject",
        actionCode: "reject",
        label: productFamily ? "No, es otra clase de producto" : "No, es otra variante",
        description: productFamily
          ? "Rechaza esta familia como destino y permite indicar dónde debería clasificarse."
          : "Cierra solo esta comparación; puedes señalar el destino correcto o dejar fotos, enlaces y datos para investigarlo.",
        tone: "reject",
        requiresReason: true,
      },
    ];
  }

  if (row.source_type === "enrichment_exception") {
    return [
      {
        id: "resolve",
        actionCode: "resolve",
        label: "Problema corregido",
        description: "La evidencia o el dato faltante ya fue incorporado.",
        tone: "confirm",
        requiresReason: true,
      },
      {
        id: "waive",
        actionCode: "waive",
        label: "No aplica",
        description: "Descarta la excepción únicamente con una justificación verificable.",
        tone: "neutral",
        requiresReason: true,
      },
    ];
  }

  if (row.source_type === "relation_candidate") {
    return [
      {
        id: "relation-incorrect",
        actionCode: "reject",
        label: "La relación es incorrecta",
        description: "La evidencia contradice la pareja propuesta.",
        tone: "reject",
        requiresReason: true,
        payload: { resolutionKind: "incorrect" },
      },
      {
        id: "relation-insufficient",
        actionCode: "reject",
        label: "La evidencia no alcanza",
        description: "Cierra esta candidata sin afirmar incompatibilidad.",
        tone: "neutral",
        requiresReason: true,
        payload: { resolutionKind: "insufficient_evidence" },
      },
    ];
  }

  if (row.source_type === "knowledge_gap") {
    return [{
      id: "dismiss",
      actionCode: "dismiss",
      label: "La brecha no aplica",
      description: "Retírala únicamente si existe una razón verificable.",
      tone: "neutral",
      requiresReason: true,
    }];
  }

  return [{
    id: "complete",
    actionCode: "complete",
    label: "Confirmar decisión",
    description: "Registra la decisión manual y conserva su historia.",
    tone: "confirm",
    requiresReason: false,
  }];
}

async function entityFor(supabase: Supabase, row: QueueRow): Promise<CatalogReviewEntity> {
  const sourceSnapshot = sourceSnapshotFor(row);
  if (row.context.semanticOrigin === "problem_group") {
    return {
      id: row.source_id,
      type: "Problema semántico de regla",
      name: text(row.context.ruleCode) ?? text(row.context.title) ?? "Regla sin código",
      code: text(row.context.ruleCode),
      brand: null,
      description: "Un único expediente representa todos los productos y claims afectados por la misma causa.",
      imageUrl: null,
      parent: null,
      facts: [
        { label: "Problemas detectados", value: String(number(row.context.problemCount)), group: "record" },
        { label: "Productos afectados", value: String(number(row.context.affectedProductCount)), group: "record" },
        { label: "Claims afectados", value: String(number(row.context.affectedClaimCount)), group: "record" },
        { label: "Base de agrupación", value: text(row.context.aggregationBasis) ?? "No registrada", group: "source" },
        { label: "Huella del conjunto", value: text(row.context.affectedSetFingerprint) ?? "No registrada", group: "source" },
      ],
      sourceSnapshot: null,
    };
  }
  const fallback: CatalogReviewEntity = {
    id: row.subject_id,
    type: purposeLabel(row.purpose),
    name: text(object(row.context).title) ?? "Registro pendiente",
    code: null,
    brand: null,
    description: null,
    imageUrl: null,
    parent: null,
    facts: [],
    sourceSnapshot,
  };

  if (!row.subject_id) return fallback;

  if (row.subject_type === "product") {
    const [result, variants, media] = await Promise.all([
      supabase
        .from("products")
        .select("id,name,code,description,presentation,product_type,main_image_path,editorial_status,is_active,brands(name),categories(name),attribute_templates(name,code)")
        .eq("id", row.subject_id)
        .maybeSingle(),
      supabase.from("product_variants").select("id", { count: "exact", head: true }).eq("product_id", row.subject_id).eq("is_active", true),
      supabase
        .from("product_media")
        .select("media_role,is_primary,media_assets(bucket,storage_path)")
        .eq("product_id", row.subject_id)
        .order("is_primary", { ascending: false })
        .order("sort_order", { ascending: true })
        .limit(1),
    ]);
    if (result.error || variants.error || media.error) {
      throw new HttpError(400, "catalog_review_entity_failed", result.error?.message ?? variants.error?.message ?? media.error?.message ?? "No se pudo leer el producto.");
    }
    if (!result.data) return fallback;
    const data = result.data as unknown as JsonObject;
    const mediaAsset = relatedObject(object(media.data?.[0]).media_assets);
    const mediaPath = text(mediaAsset.storage_path) ?? text(data.main_image_path);
    return {
      id: text(data.id),
      type: isFamilyMembershipCase(row) ? "Familia interna" : "Producto base interno",
      name: text(data.name) ?? fallback.name,
      code: text(data.code),
      brand: nestedName(data.brands),
      description: isFamilyMembershipCase(row)
        ? `Agrupa ${variants.count ?? 0} variantes del catálogo; no representa un tono específico.`
        : text(data.description),
      imageUrl: assetUrl(supabase, mediaPath, text(mediaAsset.bucket) ?? "catalog-assets"),
      parent: null,
      facts: [
        { label: "Código del producto base", value: text(data.code) ?? "No registrado", group: "record", status: text(data.code) ? "known" : "missing" },
        { label: "Marca", value: nestedName(data.brands) ?? "No registrada", group: "record", status: nestedName(data.brands) ? "known" : "missing" },
        { label: "Presentación", value: text(data.presentation) ?? "No registrada", group: "catalog", status: text(data.presentation) ? "known" : "missing" },
        { label: "Categoría actual", value: nestedName(data.categories) ?? "No registrada", group: "catalog", status: nestedName(data.categories) ? "known" : "missing" },
        { label: "Plantilla", value: nestedName(data.attribute_templates) ?? "No registrada", group: "catalog", status: nestedName(data.attribute_templates) ? "known" : "missing" },
        { label: "Variantes activas", value: String(variants.count ?? 0), group: "catalog" },
        { label: "Estado editorial", value: text(data.editorial_status) ?? "No registrado", group: "catalog" },
        { label: "Imagen interna", value: mediaPath ? "Registrada" : "Sin imagen verificada", group: "catalog", status: mediaPath ? "known" : "missing" },
      ],
      sourceSnapshot,
    };
  }

  if (row.subject_type === "variant") {
    const variantResult = await supabase
      .from("product_variants")
      .select("id,product_id,name,sku,barcode,variant_key,availability_status,is_default,is_active,color_shade_id")
      .eq("id", row.subject_id)
      .maybeSingle();
    if (variantResult.error) throw new HttpError(400, "catalog_review_entity_failed", variantResult.error.message);
    if (!variantResult.data) return fallback;
    const data = variantResult.data as unknown as JsonObject;
    const productId = text(data.product_id);
    const shadeId = text(data.color_shade_id);
    if (!productId) return fallback;

    const [productResult, shadeResult, supplierResult, mediaResult, variantsResult] = await Promise.all([
      supabase
        .from("products")
        .select("id,name,code,description,presentation,product_type,main_image_path,editorial_status,is_active,brands(name),categories(name),attribute_templates(name,code)")
        .eq("id", productId)
        .maybeSingle(),
      shadeId
        ? supabase
          .from("color_shades")
          .select("id,name,code,reference_color,attribute_options!color_shades_color_family_option_id_fkey(label)")
          .eq("id", shadeId)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("product_suppliers").select("supplier_sku,suppliers(trade_name)").eq("variant_id", row.subject_id),
      supabase
        .from("product_media")
        .select("product_id,variant_id,media_role,is_primary,sort_order,media_assets(bucket,storage_path)")
        .or(`variant_id.eq.${row.subject_id},product_id.eq.${productId}`)
        .order("is_primary", { ascending: false })
        .order("sort_order", { ascending: true }),
      supabase.from("product_variants").select("id", { count: "exact", head: true }).eq("product_id", productId).eq("is_active", true),
    ]);
    if (productResult.error || shadeResult.error || supplierResult.error || mediaResult.error || variantsResult.error) {
      throw new HttpError(
        400,
        "catalog_review_entity_failed",
        productResult.error?.message ?? shadeResult.error?.message ?? supplierResult.error?.message ?? mediaResult.error?.message ?? variantsResult.error?.message ?? "No se pudo reconstruir la variante.",
      );
    }
    const product = object(productResult.data);
    const shade = object(shadeResult.data);
    const supplierNames = (supplierResult.data ?? [])
      .map((entry) => nestedName((entry as unknown as JsonObject).suppliers))
      .filter((value): value is string => Boolean(value));
    const mediaRows = (mediaResult.data ?? []) as unknown as JsonObject[];
    const selectedMedia = mediaRows.find((entry) => text(entry.variant_id) === row.subject_id && text(entry.media_role) === "main")
      ?? mediaRows.find((entry) => text(entry.variant_id) === row.subject_id)
      ?? mediaRows.find((entry) => text(entry.product_id) === productId && text(entry.media_role) === "main")
      ?? mediaRows[0];
    const mediaAsset = relatedObject(object(selectedMedia).media_assets);
    const mediaPath = text(mediaAsset.storage_path) ?? text(product.main_image_path);
    const colorFamily = nestedLabel(shade.attribute_options);
    return {
      id: text(data.id),
      type: "Variante interna",
      name: text(data.name) ?? text(product.name) ?? fallback.name,
      code: text(data.sku) ?? text(product.code),
      brand: nestedName(product.brands),
      description: `Variante de ${text(product.name) ?? "producto sin nombre"}`,
      imageUrl: assetUrl(supabase, mediaPath, text(mediaAsset.bucket) ?? "catalog-assets"),
      parent: {
        id: productId,
        name: text(product.name) ?? "Producto base sin nombre",
        code: text(product.code),
      },
      facts: [
        { label: "Código de la variante", value: text(data.sku) ?? "No registrado", group: "record", status: text(data.sku) ? "known" : "missing" },
        { label: "Tono / variante", value: text(shade.name) ?? text(data.name) ?? "No registrado", group: "record" },
        { label: "Producto base", value: text(product.name) ?? "No registrado", group: "catalog" },
        { label: "Código del producto base", value: text(product.code) ?? "No registrado", group: "catalog", status: text(product.code) ? "known" : "missing" },
        { label: "Marca", value: nestedName(product.brands) ?? "No registrada", group: "catalog", status: nestedName(product.brands) ? "known" : "missing" },
        { label: "Presentación", value: text(product.presentation) ?? "No registrada", group: "catalog", status: text(product.presentation) ? "known" : "missing" },
        { label: "Categoría actual", value: nestedName(product.categories) ?? "No registrada", group: "catalog", status: nestedName(product.categories) ? "known" : "missing" },
        { label: "Plantilla", value: nestedName(product.attribute_templates) ?? "No registrada", group: "catalog", status: nestedName(product.attribute_templates) ? "known" : "missing" },
        { label: "Familia cromática", value: colorFamily ?? "Por clasificar", group: "catalog", status: colorFamily ? "known" : "warning" },
        { label: "Color de referencia", value: text(shade.reference_color) ?? "No registrado", group: "catalog", status: text(shade.reference_color) ? "known" : "missing" },
        { label: "Clave de variante", value: text(data.variant_key) ?? "No registrada", group: "catalog" },
        { label: "Código de barras", value: text(data.barcode) ?? "No registrado", group: "catalog", status: text(data.barcode) ? "known" : "missing" },
        { label: "Proveedor", value: supplierNames.length ? [...new Set(supplierNames)].join(", ") : "No registrado", group: "catalog", status: supplierNames.length ? "known" : "missing" },
        { label: "Variantes del producto base", value: String(variantsResult.count ?? 0), group: "catalog" },
        { label: "Imagen interna de esta variante", value: mediaRows.some((entry) => text(entry.variant_id) === row.subject_id) ? "Registrada" : "Solo imagen del producto base", group: "catalog", status: mediaRows.some((entry) => text(entry.variant_id) === row.subject_id) ? "known" : "warning" },
        { label: "Disponibilidad", value: text(data.availability_status) ?? "No registrada", group: "catalog" },
      ],
      sourceSnapshot,
    };
  }

  if (row.subject_type === "shade") {
    const result = await supabase
      .from("color_shades")
      .select("id,name,code,reference_color,brands(name)")
      .eq("id", row.subject_id)
      .maybeSingle();
    if (result.error) throw new HttpError(400, "catalog_review_entity_failed", result.error.message);
    if (!result.data) return fallback;
    const data = result.data as unknown as JsonObject;
    return {
      id: text(data.id),
      type: "Tono interno",
      name: text(data.name) ?? fallback.name,
      code: text(data.code),
      brand: nestedName(data.brands),
      description: "Tono estructurado del catálogo",
      imageUrl: null,
      parent: null,
      facts: [{ label: "Color de referencia", value: text(data.reference_color) ?? "No registrado", group: "catalog", status: text(data.reference_color) ? "known" : "missing" }],
      sourceSnapshot,
    };
  }

  return fallback;
}

function evidenceFor(row: QueueRow, entity: CatalogReviewEntity): CatalogReviewEvidence[] {
  const context = object(row.context);
  const evidence = object(context.evidence);
  const details = object(context.details);
  const result: CatalogReviewEvidence[] = [];
  const add = (item: CatalogReviewEvidence | null) => {
    if (item && !result.some((current) => current.id === item.id)) result.push(item);
  };

  add({
    id: "internal-record",
    kind: "fact",
    label: "Registro interno",
    value: [entity.brand, entity.name, entity.code].filter(Boolean).join(" · "),
  });

  const officialTitle = text(evidence.official_title) ?? text(context.officialTitle);
  if (officialTitle) add({ id: "official-title", kind: "fact", label: "Registro oficial", value: officialTitle });

  const officialLine = text(evidence.official_line);
  if (officialLine) add({ id: "official-line", kind: "fact", label: "Línea oficial", value: officialLine });

  const officialUrl = text(evidence.official_url) ?? text(details.source_url);
  if (officialUrl) add({ id: "official-url", kind: "link", label: "Fuente consultada", value: "Abrir ficha oficial", url: officialUrl });

  const officialImage = text(evidence.official_image_url) ?? text(details.image_url);
  if (officialImage) add({
    id: "official-image",
    kind: "image",
    label: "Imagen de la fuente",
    value: officialTitle ?? "Imagen oficial candidata",
    imageUrl: officialImage,
    url: officialUrl ?? undefined,
  });

  for (const [index, key] of ["candidate_2", "candidate_3"].entries()) {
    const candidate = text(evidence[key]);
    if (candidate) add({
      id: key,
      kind: isFamilyMembershipCase(row) ? "fact" : "warning",
      label: isFamilyMembershipCase(row)
        ? `Otra ficha que también coincidió con la familia ${index + 1}`
        : `Alternativa ${index + 2}`,
      value: candidate,
    });
  }

  const requiredAction = text(details.required_action);
  if (requiredAction) add({ id: "required-action", kind: "warning", label: "Qué falta comprobar", value: requiredAction });
  return result;
}

function findingFor(row: QueueRow, entity: CatalogReviewEntity) {
  const context = object(row.context);
  const evidence = object(context.evidence);
  const official = text(evidence.official_title) ?? row.recommendation;
  const score = number(context.score);

  if (row.context.semanticOrigin === "problem_group") {
    return `${number(row.context.problemCount)} problemas en ${number(row.context.affectedProductCount)} productos comparten la misma regla o causa raíz. La Mesa decide el criterio una vez; no revisa cada producto.`;
  }
  if (row.source_type === "reconciliation_case") {
    if (row.subject_type === "product") {
      const signal = score > 0
        ? `La comparación automática encontró ${Math.round(score * 100)} % de similitud.`
        : "La comparación automática no dio una similitud suficientemente clara.";
      return `${official ?? "La ficha oficial"} describe un artículo concreto. ${entity.name} reúne varias variantes. ${signal} Esto solo sugiere que puede pertenecer a la familia; no significa que sea igual a uno de sus tonos.`;
    }
    const confidence = score > 0 ? `${Math.round(score * 100)} % de similitud` : "sin similitud suficiente";
    return `${entity.name} fue comparado con ${official ?? "un registro oficial"}. El algoritmo encontró ${confidence}; tu decisión debe basarse en nombre, código, presentación e imagen.`;
  }
  if (row.source_type === "enrichment_exception") {
    return `El pipeline detuvo este registro para que una persona compruebe la evidencia antes de modificar el catálogo.`;
  }
  if (row.purpose === "relation") {
    return "La coincidencia de marca o sistema no demuestra por sí sola compatibilidad producto→producto.";
  }
  return row.recommendation ?? "La información disponible requiere una decisión humana verificable.";
}

function decisionScopeFor(row: QueueRow, entity: CatalogReviewEntity): CatalogReviewDecisionScope {
  const context = object(row.context);
  const evidence = object(context.evidence);
  const official = text(evidence.official_title) ?? row.recommendation ?? "el registro externo";
  const variantCount = entity.facts.find((fact) => fact.label === "Variantes del producto base" || fact.label === "Variantes activas")?.value;

  if (row.context.semanticOrigin === "problem_group") {
    return {
      resolves: `Decide el criterio de ${text(row.context.ruleCode) ?? entity.name} para el conjunto cuya huella es ${text(row.context.affectedSetFingerprint) ?? "la mostrada en la evidencia"}.`,
      approveEffect: "Registra una decisión de regla reproducible para que el pipeline pueda reprocesar todo el conjunto afectado.",
      rejectEffect: "No modifica productos individualmente ni convierte claims inciertos en hechos canónicos.",
      doesNotResolve: [
        "No aprueba cada producto por separado.",
        "No completa UNKNOWN, NOT_STATED o NOT_APPLICABLE con información inventada.",
        "No crea hechos comerciales ni escribe directamente en Neo4j.",
      ],
    };
  }

  if (row.source_type === "reconciliation_case") {
    const internal = row.subject_type === "variant"
      ? `la variante interna ${entity.name}${entity.code ? ` (${entity.code})` : ""}`
      : `el producto interno ${entity.name}${entity.code ? ` (${entity.code})` : ""}`;
    const familyMembership = isFamilyMembershipCase(row);
    return {
      resolves: familyMembership
        ? `Decide únicamente si «${official}» forma parte de la familia ${entity.name}.`
        : `Decide únicamente si «${official}» y ${internal} representan la misma variante comercial.`,
      approveEffect: familyMembership
        ? "Confirma la pertenencia a la familia. No la enlaza con un tono existente ni crea automáticamente una variante."
        : "Confirma esta correspondencia puntual y conserva la ficha oficial como evidencia de esta identidad.",
      rejectEffect: familyMembership
        ? "Descarta esta familia como destino; puedes indicar otra clasificación o dejar una observación para investigarla."
        : "Rechaza únicamente esta pareja. Si señalas otro destino, el sistema crea una nueva candidata separada; si no, conserva tus referencias como trabajo pendiente.",
      doesNotResolve: [
        familyMembership
          ? "No afirma que la ficha oficial sea igual a una de las variantes existentes."
          : variantCount && Number(variantCount) > 1
          ? `No confirma automáticamente las otras ${Math.max(Number(variantCount) - 1, 0)} variantes del producto base.`
          : "No confirma automáticamente otros productos o variantes.",
        familyMembership
          ? "No crea el tono faltante ni publica su fotografía sin el proceso de medios."
          : "No aprueba en bloque fotografías, tonos, presentaciones ni atributos que tengan su propia evidencia pendiente.",
        "No crea relaciones de compatibilidad, uso conjunto o recomendación entre productos.",
      ],
    };
  }

  return {
    resolves: `Decide solamente el caso abierto sobre ${entity.name}.`,
    approveEffect: "La acción elegida se aplica a este expediente y queda registrada en su historial.",
    rejectEffect: "La acción no modifica otros casos ni afirma hechos que no estén respaldados por evidencia.",
    doesNotResolve: ["No completa automáticamente otros atributos, imágenes o relaciones pendientes."],
  };
}

function warningsFor(row: QueueRow): string[] {
  const context = object(row.context);
  const evidence = object(context.evidence);
  const warnings: string[] = [];
  if (row.has_contradiction && !isFamilyMembershipCase(row)) warnings.push("Hay señales contradictorias: revisa las alternativas antes de decidir.");
  if (evidence.ambiguous === true) warnings.push(isFamilyMembershipCase(row)
    ? "Varias fichas oficiales coincidieron con esta familia porque representan tonos distintos; no deben tratarse como el mismo artículo."
    : "Más de un registro obtuvo una puntuación similar.");
  if (number(context.score) > 0 && number(context.score) < 0.8) warnings.push("La similitud automática es menor a 80 %.");
  if (row.purpose === "relation") warnings.push("Misma marca o mismo sistema no equivalen a compatibilidad demostrada.");
  if (row.context.semanticOrigin === "problem_group" && text(row.context.partitionKey)) {
    warnings.push(`Este conjunto fue separado de la regla general: ${text(row.context.nonAggregationJustification) ?? "revisa la justificación de no agregación"}.`);
  }
  return warnings;
}

function historyTitle(eventType: string, actionCode: string | null) {
  if (eventType === "work_created") return "Caso creado";
  if (eventType === "work_superseded") return "Versión sustituida";
  if (eventType === "work_started") return "Revisión iniciada";
  if (eventType === "work_deferred") return "Revisión pospuesta";
  if (eventType === "work_resumed") return "Revisión reanudada";
  if (eventType === "decision_taken") return actionCode === "approve" ? "Identidad confirmada" : "Decisión registrada";
  if (eventType === "decision_superseded") return "Decisión sustituida";
  return "Fuente sincronizada";
}

async function historyFor(supabase: Supabase, workItemId: string): Promise<CatalogReviewHistoryEvent[]> {
  const result = await supabase
    .from("catalog_review_events")
    .select("id,event_type,action_code,actor_label,payload,occurred_at")
    .eq("work_item_id", workItemId)
    .order("occurred_at", { ascending: false })
    .limit(30);
  if (result.error) throw new HttpError(400, "catalog_review_history_failed", result.error.message);

  return (result.data ?? []).map((entry) => {
    const payload = object(entry.payload);
    const reason = text(payload.reason) ?? text(payload.notes) ?? text(payload.dismissReason);
    return {
      id: String(entry.id),
      title: historyTitle(String(entry.event_type), text(entry.action_code)),
      detail: reason ?? "El sistema conservó esta transición en el historial del caso.",
      actor: text(entry.actor_label) ?? "Sistema",
      occurredAt: String(entry.occurred_at),
      tone: entry.event_type === "decision_taken"
        ? "success"
        : entry.event_type === "work_deferred" ? "warning" : "neutral",
    };
  });
}

async function relatedWorkFor(supabase: Supabase, row: QueueRow) {
  if (!row.subject_id) return [];
  const result = await supabase
    .from("catalog_review_work_items")
    .select("purpose")
    .eq("subject_type", row.subject_type)
    .eq("subject_id", row.subject_id)
    .in("status", ["open", "in_progress"]);
  if (result.error) throw new HttpError(400, "catalog_review_related_failed", result.error.message);
  const counts = new Map<string, number>();
  for (const item of result.data ?? []) counts.set(item.purpose, (counts.get(item.purpose) ?? 0) + 1);
  return [...counts.entries()].map(([purpose, count]) => ({ purpose, label: purposeLabel(purpose), count }));
}

async function presentCase(supabase: Supabase, row: QueueRow): Promise<CatalogReviewCase> {
  const [entity, history, relatedOpenWork] = await Promise.all([
    entityFor(supabase, row),
    historyFor(supabase, row.id),
    relatedWorkFor(supabase, row),
  ]);

  const displayContradiction = row.has_contradiction && !isFamilyMembershipCase(row);
  return {
    id: row.id,
    workKey: row.work_key,
    rowVersion: number(row.row_version),
    caseKind: caseKind(row),
    title: titleFor(row),
    eyebrow: isFamilyMembershipCase(row)
      ? "Familia del catálogo · decisión humana"
      : `${purposeLabel(row.purpose)} · ${displayContradiction ? "señales contradictorias" : "decisión humana"}`,
    question: questionFor(row),
    findingSummary: findingFor(row, entity),
    entity,
    decisionScope: decisionScopeFor(row, entity),
    evidence: evidenceFor(row, entity),
    options: optionsFor(row),
    recommendedAction: row.recommendation,
    impact: {
      unlockCount: number(row.unlock_count),
      blockedByCount: number(row.blocked_by_count),
      invalidatedByCount: number(row.invalidated_by_count),
    },
    warnings: warningsFor(row),
    risk: row.risk_level,
    hasContradiction: displayContradiction,
    canSkip: true,
    canRequestCapture: ["identity", "image", "attribute"].includes(row.purpose),
    history,
    relatedOpenWork,
  };
}

export async function getCatalogReviewSummary(supabase: Supabase): Promise<CatalogReviewSummary> {
  const result = await supabase.from("catalog_review_summary_v1").select("*").single();
  if (result.error) throw new HttpError(400, "catalog_review_summary_failed", result.error.message);
  return {
    reviewable: number(result.data.reviewable_count),
    capture: number(result.data.capture_count),
    waiting: number(result.data.waiting_count),
    completed: number(result.data.completed_count),
    blocked: number(result.data.blocked_count),
    potentialUnlocks: number(result.data.reviewable_unlock_count),
    automaticDebt: number(result.data.automatic_debt_count),
    humanShareOfActive: number(result.data.human_share_of_active),
  };
}

export async function getCatalogReviewActivity(supabase: Supabase): Promise<CatalogReviewActivity> {
  const result = await supabase.from("catalog_review_activity_summary_v1").select("*").single();
  if (result.error) throw new HttpError(400, "catalog_review_activity_failed", result.error.message);
  return {
    decisionsToday: number(result.data.decisions_today),
    unlockedToday: number(result.data.unlocked_today),
    entitiesAdvancedToday: number(result.data.entities_advanced_today),
  };
}

export async function getNextCatalogReviewCase(
  supabase: Supabase,
  excludeIds: string[] = [],
): Promise<CatalogReviewCase | null> {
  const result = await supabase.rpc("next_catalog_review_item_v1", {
    p_exclude_ids: excludeIds,
  });
  if (result.error) rpcFailure(result.error, "catalog_review_next_failed");
  const row = (result.data?.[0] ?? null) as QueueRow | null;
  return row ? presentCase(supabase, row) : null;
}

export async function getCatalogReviewCase(supabase: Supabase, id: string): Promise<CatalogReviewCase> {
  const result = await supabase
    .from("catalog_review_operational_queue_v1")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new HttpError(400, "catalog_review_case_failed", result.error.message);
  if (!result.data) throw new HttpError(404, "catalog_review_case_not_found", "El caso ya no está disponible.");
  return presentCase(supabase, result.data as QueueRow);
}

export async function getCatalogReviewBootstrap(supabase: Supabase): Promise<CatalogReviewBootstrap> {
  const [summary, activity, nextCase] = await Promise.all([
    getCatalogReviewSummary(supabase),
    getCatalogReviewActivity(supabase),
    getNextCatalogReviewCase(supabase),
  ]);
  return { summary, activity, nextCase };
}

export async function searchCatalogReviewTargets(
  supabase: Supabase,
  query: string,
  limit = 12,
): Promise<CatalogReviewTarget[]> {
  const normalized = query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.length < 2) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 20);

  const [productSearch, variantSearch] = await Promise.all([
    supabase.rpc("admin_product_search", {
      p_query: query,
      p_estado: null,
      p_active: true,
      p_brand_id: null,
      p_limit: safeLimit,
      p_offset: 0,
    }),
    supabase
      .from("product_variants")
      .select("id,product_id,name,sku,barcode,variant_key,products(id,name,code,presentation,main_image_path,brands(name))")
      .eq("is_active", true)
      .ilike("search_document", `%${normalized}%`)
      .limit(safeLimit),
  ]);
  if (productSearch.error || variantSearch.error) {
    throw new HttpError(400, "catalog_review_target_search_failed", productSearch.error?.message ?? variantSearch.error?.message ?? "No se pudo buscar el destino.");
  }

  const productIds = ((object(productSearch.data).ids as unknown[]) ?? []).map(String).slice(0, safeLimit);
  const productsResult = productIds.length
    ? await supabase
      .from("products")
      .select("id,name,code,presentation,main_image_path,brands(name)")
      .in("id", productIds)
    : { data: [], error: null };
  if (productsResult.error) throw new HttpError(400, "catalog_review_target_search_failed", productsResult.error.message);

  const productsById = new Map((productsResult.data ?? []).map((entry) => [String(entry.id), entry as unknown as JsonObject]));
  const productTargets = productIds.flatMap((id): CatalogReviewTarget[] => {
    const product = productsById.get(id);
    if (!product) return [];
    const name = text(product.name) ?? "Producto sin nombre";
    const code = text(product.code);
    const brand = nestedName(product.brands);
    return [{
      id,
      entityType: "product",
      productId: id,
      name,
      productName: name,
      code,
      brand,
      detail: ["Producto base", brand, code, text(product.presentation)].filter(Boolean).join(" · "),
      imageUrl: assetUrl(supabase, text(product.main_image_path)),
    }];
  });

  const variantTargets = (variantSearch.data ?? []).map((entry): CatalogReviewTarget => {
    const data = entry as unknown as JsonObject;
    const product = relatedObject(data.products);
    const name = text(data.name) ?? "Variante sin nombre";
    const productName = text(product.name) ?? "Producto sin nombre";
    const code = text(data.sku) ?? text(data.barcode);
    const brand = nestedName(product.brands);
    return {
      id: text(data.id) ?? "",
      entityType: "variant",
      productId: text(data.product_id) ?? text(product.id) ?? "",
      name,
      productName,
      code,
      brand,
      detail: ["Variante", productName, brand, code].filter(Boolean).join(" · "),
      imageUrl: assetUrl(supabase, text(product.main_image_path)),
    };
  }).filter((target) => target.id && target.productId);

  const seen = new Set<string>();
  return [...variantTargets, ...productTargets]
    .filter((target) => {
      const key = `${target.entityType}:${target.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, safeLimit);
}

type CursorPayload = { createdAt: string; id: string };

function decodeCursor(cursor: string | null): CursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (!parsed.createdAt || !parsed.id) throw new Error("incomplete");
    return parsed;
  } catch {
    throw new HttpError(400, "catalog_review_cursor_invalid", "El cursor de revisión no es válido.");
  }
}

export async function listCatalogReviewCases(
  supabase: Supabase,
  filters: { queueState?: string; workKind?: string; purpose?: string; cursor?: string | null; limit?: number },
): Promise<CatalogReviewListResult> {
  const cursor = decodeCursor(filters.cursor ?? null);
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 50);
  const result = await supabase.rpc("list_catalog_review_items_v1", {
    p_queue_state: filters.queueState ?? null,
    p_work_kind: filters.workKind ?? null,
    p_purpose: filters.purpose ?? null,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit + 1,
  });
  if (result.error) rpcFailure(result.error, "catalog_review_list_failed");
  const rows = (result.data ?? []) as QueueRow[];
  const visible = rows.slice(0, limit);
  const items = await Promise.all(visible.map((row) => presentCase(supabase, row)));
  const last = rows.length > limit ? visible.at(-1) : null;
  return {
    items,
    nextCursor: last
      ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
      : null,
  };
}

export async function resolveCatalogReviewCase(
  supabase: Supabase,
  id: string,
  input: CatalogReviewResolveInput,
): Promise<CatalogReviewCommandResult> {
  const result = await supabase.rpc("resolve_catalog_review_item_v1", {
    p_work_item_id: id,
    p_expected_version: input.expectedVersion,
    p_action_code: input.actionCode,
    p_decision_payload: input.payload,
    p_evidence: input.evidence,
    p_idempotency_key: input.idempotencyKey,
  });
  if (result.error) rpcFailure(result.error, "catalog_review_resolve_failed");
  const data = object(result.data);
  return {
    workItemId: text(data.workItemId) ?? id,
    status: text(data.status) ?? "resolved",
    rowVersion: number(data.rowVersion),
    unlockedCount: number(data.unlockedCount),
    invalidatedCount: number(data.invalidatedCount),
    deferredUntil: null,
    idempotentReplay: data.idempotentReplay === true,
  };
}

export async function transitionCatalogReviewCase(
  supabase: Supabase,
  id: string,
  input: CatalogReviewTransitionInput,
): Promise<CatalogReviewCommandResult> {
  const result = await supabase.rpc("transition_catalog_review_item_v1", {
    p_work_item_id: id,
    p_expected_version: input.expectedVersion,
    p_action_code: input.actionCode,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
    p_defer_minutes: input.deferMinutes ?? 1440,
  });
  if (result.error) rpcFailure(result.error, "catalog_review_transition_failed");
  const data = object(result.data);
  return {
    workItemId: text(data.workItemId) ?? id,
    status: text(data.status) ?? "open",
    rowVersion: number(data.rowVersion),
    unlockedCount: 0,
    invalidatedCount: 0,
    deferredUntil: text(data.deferredUntil),
    idempotentReplay: data.idempotentReplay === true,
  };
}
