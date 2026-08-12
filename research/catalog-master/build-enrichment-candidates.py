from __future__ import annotations

import json
import re
import pandas as pd

from storage import DATA

DATA.mkdir(parents=True, exist_ok=True)


def clean(value: object) -> str:
    return "" if pd.isna(value) else str(value).strip()


def classify_roles(row: pd.Series) -> set[str]:
    haystack = " ".join([
        clean(row.get("product_name")),
        clean(row.get("category")),
        clean(row.get("product_type")),
        clean(row.get("description")),
    ]).casefold()
    roles: set[str] = set()
    rules = {
        "acrylic_powder": r"(polvo\s+acr[ií]lico|acr[ií]lico\s+(cover|nude|rose|clear)|acrylic powder)",
        "monomer": r"\bmon[oó]mero\b",
        "primer": r"(\bprimer\b|ultrabond|adherente|deshidratador|ph\s*balanc|bond\s*[12]?)",
        "gel_color": r"(esmalte\s+(en\s+)?gel|gel\s+polish|gel\s+evolution|color\s+gel)",
        "gel_base": r"(base\s+(coat|gel)|gel\s+base|foundation)",
        "gel_top": r"(top\s+(coat|gel|finish)|gel\s+top|brillo\s+gel|sellante)",
        "lamp_uv_led": r"(l[aá]mpara|linterna).*(uv|led|u[ñn]a)|\buv\s*led\b",
        "polygel": r"\b(poly\s*gel|polygel)\b",
        "slip_solution": r"(slip\s+solution|dilusor\s+de\s+pol[iy]gel)",
        "soft_gel_tips": r"(gelly\s+tips|soft\s+gel|tips\s+.*(almond|coffin|sharp|stiletto)|u[ñn]as\s+dual\s+sist)",
        "nail_adhesive": r"(press\s+gel|pegamento\s+de\s+u[ñn]a|adhesivo\s+para\s+u[ñn]as)",
        "drill": r"\b(drill|torno|pulidor)\b",
        "drill_bit": r"\b(broca|fresa)\b",
        "wax": r"\bcera\b.*(depilat|granulada|roll|miel|aloe|chocolate)",
        "wax_warmer": r"(olla|ollita|calentador|termostato).*(cera|roll)|prowax",
        "lash_extension": r"(pesta[ñn]a).*(1x1|volumen|pelo\s+a\s+pelo|extensi)",
        "lash_adhesive": r"pegamento.*pesta[ñn]a",
        "lash_remover": r"removedor.*pesta[ñn]a",
    }
    for role, pattern in rules.items():
        if re.search(pattern, haystack):
            roles.add(role)
    return roles


catalog = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str).fillna("")
products = catalog.drop_duplicates("product_id").copy()
products["roles"] = products.apply(classify_roles, axis=1)

# These links are operational hypotheses produced by catalog-process rules. They are useful
# for curation but never promoted to canonical compatibility without packaging/manual evidence.
relation_rules = [
    ("acrylic_powder", "monomer", "requires", "Sistema acrílico: el polvo se trabaja con monómero."),
    ("acrylic_powder", "primer", "recommended_with", "Preparación previa del sistema acrílico."),
    ("gel_color", "gel_base", "recommended_with", "Secuencia de servicio gel: base antes del color."),
    ("gel_color", "gel_top", "recommended_with", "Secuencia de servicio gel: top después del color."),
    ("gel_color", "lamp_uv_led", "requires", "El curado depende de lámpara; potencia/tiempo deben validarse."),
    ("polygel", "slip_solution", "requires", "Modelado de polygel con solución de deslizamiento."),
    ("polygel", "gel_base", "recommended_with", "Preparación recomendada para sistema polygel."),
    ("polygel", "gel_top", "recommended_with", "Finalización recomendada para sistema polygel."),
    ("polygel", "lamp_uv_led", "requires", "El curado depende de lámpara; potencia/tiempo deben validarse."),
    ("soft_gel_tips", "nail_adhesive", "requires", "Fijación de tip/soft gel con adhesivo compatible."),
    ("soft_gel_tips", "lamp_uv_led", "requires", "El adhesivo gel puede requerir curado UV/LED."),
    ("drill", "drill_bit", "compatible_with", "Equipo y consumible; diámetro de vástago debe verificarse."),
    ("wax", "wax_warmer", "requires", "La cera requiere equipo de calentamiento apropiado."),
    ("lash_extension", "lash_adhesive", "requires", "Extensión profesional requiere adhesivo específico."),
    ("lash_extension", "lash_remover", "recommended_with", "Removedor recomendado para retiro seguro."),
]

relations: list[dict] = []
for source_role, target_role, relation_type, rationale in relation_rules:
    sources = products[products["roles"].apply(lambda roles: source_role in roles)]
    targets = products[products["roles"].apply(lambda roles: target_role in roles)]
    for _, source in sources.iterrows():
        same_brand = targets[targets["brand"].str.casefold() == clean(source["brand"]).casefold()]
        candidates = same_brand if not same_brand.empty else targets[targets["brand_is_generic"] == "t"]
        if candidates.empty:
            continue
        # Keep a bounded, auditable candidate set. Same-brand candidates are safer than cross-brand
        # assumptions, but remain unconfirmed until manuals/labels establish compatibility.
        for _, target in candidates.head(3).iterrows():
            if source["product_id"] == target["product_id"]:
                continue
            confidence = "INFERIDO_MISMA_MARCA" if clean(source["brand"]).casefold() == clean(target["brand"]).casefold() else "INFERIDO_CATEGORIA"
            relations.append({
                "source_product_id": source["product_id"],
                "source_code": source["product_code"],
                "source_brand": source["brand"],
                "source_product": source["product_name"],
                "source_role": source_role,
                "relation_type": relation_type,
                "target_product_id": target["product_id"],
                "target_code": target["product_code"],
                "target_brand": target["brand"],
                "target_product": target["product_name"],
                "target_role": target_role,
                "confidence": confidence,
                "canonical_write_allowed": "NO",
                "validation_required": "ENVASE_MANUAL_FICHA_TECNICA",
                "rationale": rationale,
            })

relations_df = pd.DataFrame(relations).drop_duplicates(
    ["source_product_id", "relation_type", "target_product_id"]
)
relations_df.to_csv(DATA / "product_relation_candidates.csv", index=False)

families = pd.read_csv(DATA / "bellaroshe_source_families.csv", dtype=str).fillna("")
family_process = {
    "Bases, tops, brillos y finalizadores": "Preparar > aplicar sistema > finalizar",
    "Brocas y repuestos de drill": "Preparar equipo > trabajar > limpiar",
    "Cuidado de cutícula, manos y pies": "Preparar > tratar > hidratar",
    "Decoración y nail art": "Preparar > decorar > sellar",
    "Drills, extractores y equipos": "Configurar > trabajar > mantener",
    "Esmaltes tradicionales y gel": "Preparar > color > finalizar/curar",
    "Lámparas UV/LED y linternas": "Curar y verificar compatibilidad",
    "Polygel, gel constructor y soluciones": "Preparar > construir > curar > finalizar",
    "Preparadores y adherencia": "Deshidratar > adherir > aplicar sistema",
    "Remoción y limpieza química": "Ablandar/limpiar > retirar > cuidar",
    "Sistema acrílico: polvos y monómeros": "Preparar > mezclar > modelar > finalizar",
    "Soft gel, press gel y adhesivos para uñas": "Preparar > adherir > curar > finalizar",
    "Tips, dual system y uñas para extensión": "Seleccionar > adherir/construir > dar forma",
    "Adhesivos, removedores y preparadores": "Preparar > adherir > retirar",
    "Extensiones profesionales 1x1/volumen": "Preparar > aislar > adherir > retirar",
    "Ceras depilatorias": "Calentar > aplicar > retirar > cuidar",
    "Equipos para cera": "Calentar y controlar temperatura",
}
families["process_flow"] = families["Familia"].map(family_process).fillna("Seleccionar > usar > mantener según ficha técnica")
families["taxonomy_status"] = families["Categoría principal"].apply(
    lambda value: "REVISION_MANUAL" if value == "Pendiente de clasificación" else "VALIDA_COMO_NODO_DE_NAVEGACION"
)
families.to_csv(DATA / "catalog_taxonomy_tree.csv", index=False)

brand_queue = pd.read_csv(DATA / "bellaroshe_brand_research_queue.csv", dtype=str).fillna("")
captured_brands = {"masglo", "admiss", "acrylove", "mc nails", "cherimoya", "bigen"}
source_summary = pd.read_csv(DATA / "external_official_sources_summary.csv", dtype=str).fillna("")
summary_by_brand = {clean(row["brand"]).casefold(): row for _, row in source_summary.iterrows()}

registry = []
for _, row in brand_queue.iterrows():
    key = clean(row["brand"]).casefold()
    source = summary_by_brand.get(key)
    if key in captured_brands and source is not None:
        status = "FUENTE_OFICIAL_CAPTURADA"
        authority = "PRIMARIA_OFICIAL"
        next_action = "REVISAR_COINCIDENCIAS_Y_PROMOVER_SOLO_CONFIRMADAS"
        source_url = source["source_root_url"]
        official_products = source["products"]
        official_images = source["images"]
    elif row["is_generic"] == "t" or row["initial_identity_status"] in {"DESCRIPTOR_NO_MARCA", "GENERICA_O_SIN_MARCA"}:
        status = "REQUIERE_LEVANTAMIENTO_FISICO"
        authority = "SIN_FUENTE_DIGITAL_CONFIABLE"
        next_action = "FOTOGRAFIAR_FRENTE_REVERSO_CODIGO_Y_MEDIDAS"
        source_url = official_products = official_images = ""
    else:
        status = "PENDIENTE_RESOLVER_IDENTIDAD"
        authority = "NO_VERIFICADA"
        next_action = "BUSCAR_FABRICANTE_DISTRIBUIDOR_Y_CONTRASTAR_ENVASE"
        source_url = official_products = official_images = ""
    registry.append({
        **row.to_dict(),
        "research_status": status,
        "source_authority": authority,
        "official_source_url": source_url,
        "official_products_captured": official_products,
        "official_images_inventoried": official_images,
        "next_action": next_action,
        "canonical_write_allowed": "SOLO_CONFIRMADOS" if status == "FUENTE_OFICIAL_CAPTURADA" else "NO",
    })
registry_df = pd.DataFrame(registry)
registry_df.to_csv(DATA / "brand_resolution_registry.csv", index=False)

metrics = {
    "taxonomy_top_categories": int(families["Categoría principal"].nunique()),
    "taxonomy_families": len(families),
    "relation_candidates": len(relations_df),
    "brands_total": len(registry_df),
    "brands_official_bulk_captured": int((registry_df["research_status"] == "FUENTE_OFICIAL_CAPTURADA").sum()),
    "brands_physical_lift_required": int((registry_df["research_status"] == "REQUIERE_LEVANTAMIENTO_FISICO").sum()),
    "brands_identity_pending": int((registry_df["research_status"] == "PENDIENTE_RESOLVER_IDENTIDAD").sum()),
}
(DATA / "enrichment_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
