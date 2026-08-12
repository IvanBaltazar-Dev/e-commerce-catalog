from __future__ import annotations

import json
import pandas as pd

from storage import DATA

DATA.mkdir(parents=True, exist_ok=True)


families = pd.read_csv(DATA / "catalog_taxonomy_tree.csv", dtype=str).fillna("")


def taxonomy_fields(family: str, domain: str) -> tuple[str, str, str, str]:
    name = family.casefold()
    if "esmaltes tradicionales" in name:
        return "Tradicional / gel", "Color", "Esmaltar", "sistema|línea|tono|familia cromática|subtono|acabado|efecto|volumen|curado"
    if "bases, tops" in name:
        return "Tradicional / gel", "Preparación o acabado", "Preparar / finalizar", "sistema|función|con color|no-wipe|viscosidad|volumen|curado"
    if "preparadores" in name:
        return "Multisistema uñas", "Preparación y adherencia", "Preparar", "ácido/no ácido|función|sistema compatible|volumen|secuencia"
    if "sistema acrílico" in name:
        return "Acrílico", "Construcción", "Construir", "polvo/monómero|color|acabado|viscosidad|tiempo de secado|presentación"
    if "polygel" in name:
        return "Polygel / builder gel", "Construcción", "Construir", "tecnología|tono|viscosidad|volumen|curado|solución compatible"
    if "soft gel" in name:
        return "Soft gel / press-on", "Adherencia", "Extender", "forma|longitud|curvatura|cantidad|adhesivo|curado"
    if "tips, dual" in name:
        return "Extensión de uñas", "Estructura", "Extender", "forma|longitud|curva|material|cantidad|tallas"
    if "lámparas uv" in name:
        return "Gel / polygel / soft gel", "Curado", "Curar", "UV/LED|potencia real|longitudes de onda|temporizador|voltaje|batería|dimensiones"
    if "drills" in name:
        return "Manicure / pedicure", "Equipo", "Desbastar / retirar", "rpm|torque|sentido|voltaje|mandril|accesorios"
    if "brocas" in name:
        return "Drill", "Consumible técnico", "Desbastar / retirar", "material|forma|granulometría|diámetro de vástago|uso"
    if "extensiones profesionales" in name:
        return "Pestañas", "Aplicación", "Extender", "curva|grosor|longitud|efecto|abanico|color|cantidad"
    if "adhesivos, removedores" in name:
        return "Pestañas", "Preparación / aplicación / retiro", "Adherir / retirar", "tiempo de secado|retención|humedad|temperatura|color|volumen"
    if "lifting" in name:
        return "Lifting / laminado", "Proceso químico", "Elevar / laminar", "paso|tiempo|tamaño de molde|compatibilidad|contenido"
    if "ceras depilatorias" in name:
        return "Depilación", "Aplicación", "Depilar", "tipo de cera|temperatura|zona|presentación|ingredientes"
    if "equipos para cera" in name:
        return "Depilación", "Equipo", "Calentar", "capacidad|potencia|voltaje|temperatura|compatibilidad"
    if "coloración" in name:
        return "Cabello", "Proceso químico", "Colorear", "familia|código|tono|oxidante|proporción|tiempo|contenido"
    if "máquinas de corte" in name:
        return "Barbería", "Equipo", "Cortar / afeitar", "tipo|voltaje|batería|cuchilla|peines|repuestos"
    if "maquillaje" in name or "labios" in name:
        return "Maquillaje", "Aplicación", "Maquillar", "zona|tono|acabado|formato|contenido"
    if domain == "Pendiente de clasificación":
        return "Sin determinar", "Sin determinar", "Revisar", "foto|marca|código|medidas|etiqueta"
    return domain, "Uso funcional", "Seleccionar / usar / mantener", "marca|tipo|material|tamaño|unidad|compatibilidad"


canonical_rows = []
for _, row in families.iterrows():
    system, function, stage, attributes = taxonomy_fields(row["Familia"], row["Categoría principal"])
    canonical_rows.append({
        "domain": row["Categoría principal"],
        "canonical_family": row["Familia"],
        "user_intent": row["process_flow"].split(">")[0].strip(),
        "system_or_technology": system,
        "function": function,
        "usage_stage": stage,
        "canonical_attribute_bundle": attributes,
        "source_rows": row["Registros"],
        "taxonomy_status": row["taxonomy_status"],
        "entity_boundary": "Producto = función estable; variante = tono/tamaño/forma/eje comercial; presentación no duplica producto.",
    })
canonical_taxonomy = pd.DataFrame(canonical_rows)
canonical_taxonomy.to_csv(DATA / "canonical_taxonomy.csv", index=False)

registry = pd.read_csv(DATA / "brand_resolution_registry.csv", dtype=str).fillna("")
sources = pd.read_csv(DATA / "external_official_sources_summary.csv", dtype=str).fillna("")
lines = pd.read_csv(DATA / "external_official_lines.csv", dtype=str).fillna("")
image_queue = pd.read_csv(DATA / "image_pending_queue.csv", dtype=str).fillna("")
tone_coverage = pd.read_csv(DATA / "internal_official_tone_coverage.csv", dtype=str).fillna("")

source_by_brand = {str(row["brand"]).casefold(): row for _, row in sources.iterrows()}
tone_by_brand = {str(row["brand"]).casefold(): row for _, row in tone_coverage.iterrows()}
line_counts = lines.groupby(lines["brand"].str.casefold()).size().to_dict()
image_counts = image_queue.groupby([image_queue["brand"].str.casefold(), "classification"]).size().unstack(fill_value=0)

brand_rows = []
for _, row in registry.iterrows():
    key = str(row["brand"]).casefold()
    external = source_by_brand.get(key)
    tone = tone_by_brand.get(key)
    counts = image_counts.loc[key] if key in image_counts.index else pd.Series(dtype=int)
    known_external_products = int(external["products"]) if external is not None and external["products"] else 0
    known_external_variants = int(external["variants"]) if external is not None and external["variants"] else 0
    official_images = int(external["images"]) if external is not None and external["images"] else 0
    brand_rows.append({
        "brand": row["brand"],
        "identity_status": row["initial_identity_status"],
        "research_status": row["research_status"],
        "source_authority": row["source_authority"],
        "official_source_url": row["official_source_url"],
        "known_external_lines": int(line_counts.get(key, 0)),
        "internal_lines": int(row["lines"] or 0),
        "known_external_products": known_external_products,
        "internal_products": int(row["products"] or 0),
        "known_external_variants": known_external_variants,
        "internal_variants": int(row["variants"] or 0),
        "internal_tones": int(row["shades"] or 0),
        "tones_confirmed_current_official": int(tone["confirmed_in_current_official_catalog"]) if tone is not None else 0,
        "official_images_inventoried": official_images,
        "official_tone_images_exact": int(tone["official_photo_available"]) if tone is not None else 0,
        "variants_with_internal_asset_only_or_also_official": int(counts.get("ACTIVO_INTERNO_REQUIERE_AUDITORIA", 0)) + int(counts.get("ENCONTRADA_OFICIAL_PENDIENTE_DESCARGA", 0)),
        "variants_requiring_own_photography": int(counts.get("REQUIERE_FOTOGRAFIA_PROPIA", 0)),
        "variants_identity_pending_before_image": int(counts.get("CODIGO_INSUFICIENTE_O_IDENTIDAD_PENDIENTE", 0)),
        "next_action": row["next_action"],
        "canonical_write_allowed": row["canonical_write_allowed"],
    })
brand_coverage = pd.DataFrame(brand_rows).sort_values(["internal_products", "brand"], ascending=[False, True])
brand_coverage.to_csv(DATA / "brand_coverage_master.csv", index=False)

enriched = pd.read_csv(DATA / "external_official_products_enriched.csv", dtype=str).fillna("")
internal_catalog = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str).fillna("")
collection_rows = []
for (brand, line), group in enriched.groupby(["brand", "canonical_line"]):
    known_tones = int((group["tone_name"] != "").sum())
    internal_tones = matched_tones = 0
    if brand == "Masglo" and line == "Tradicional":
        internal_tones = int(((internal_catalog["brand"].str.casefold() == "masglo") & (internal_catalog["product_name"] == "Esmalte MASGLO") & (internal_catalog["shade_id"] != "")).sum())
        tone_rows = pd.read_csv(DATA / "internal_official_tone_reconciliation.csv", dtype=str).fillna("")
        matched_tones = int(((tone_rows["internal_brand"] == "Masglo") & (tone_rows["match_status"] == "CONFIRMADO_OFICIAL") & tone_rows["official_title"].str.contains("TRADICIONAL", case=False, na=False)).sum())
    elif brand == "Masglo" and line == "Gel Evolution":
        internal_tones = int(((internal_catalog["brand"].str.casefold() == "masglo") & (internal_catalog["product_name"] == "Gel Evolution Demo") & (internal_catalog["shade_id"] != "")).sum())
    elif brand == "Admiss" and line == "Esmalte tradicional":
        internal_tones = int(((internal_catalog["brand"].str.casefold() == "admiss") & (internal_catalog["shade_id"] != "")).sum())
        matched_tones = int(tone_by_brand["admiss"]["confirmed_in_current_official_catalog"])
    collection_rows.append({
        "brand": brand,
        "line_or_collection": line,
        "known_external_products": group["external_product_id"].nunique(),
        "known_external_variants": int(pd.to_numeric(group["variant_count"], errors="coerce").fillna(0).sum()),
        "known_external_tones": known_tones,
        "internal_tones_assigned": internal_tones,
        "internal_tones_confirmed_current_official": matched_tones,
        "gap_known_vs_internal_tones": max(0, known_tones - internal_tones),
        "official_images": int(pd.to_numeric(group["image_count"], errors="coerce").fillna(0).sum()),
        "source_url": group.iloc[0]["source_root_url"],
        "confidence": "CONFIRMADO_OFICIAL",
        "reconciliation_state": "PARCIAL" if internal_tones or matched_tones else "EXTERNO_DETECTADO_NO_RECONCILIADO",
    })

# Bigen's color axis is represented by variants in one official product, not one product per tone.
bigen_variants = pd.read_csv(DATA / "external_official_variants.csv", dtype=str).fillna("")
bigen_powder = bigen_variants[(bigen_variants["brand"] == "Bigen") & bigen_variants["product_title"].str.contains("Permanent Powder", case=False, na=False)]
collection_rows.append({
    "brand": "Bigen",
    "line_or_collection": "Permanent Powder Hair Color",
    "known_external_products": 1,
    "known_external_variants": len(bigen_powder),
    "known_external_tones": len(bigen_powder),
    "internal_tones_assigned": 11,
    "internal_tones_confirmed_current_official": 11,
    "gap_known_vs_internal_tones": max(0, len(bigen_powder) - 11),
    "official_images": "",
    "source_url": "https://www.bigen-usa.com/products/permanent-powder",
    "confidence": "CONFIRMADO_OFICIAL",
    "reconciliation_state": "PARCIAL",
})
collection_coverage = pd.DataFrame(collection_rows).sort_values(["brand", "known_external_tones"], ascending=[True, False])
collection_coverage.to_csv(DATA / "collection_tone_coverage.csv", index=False)

source_reconciliation = pd.read_csv(DATA / "source_row_reconciliation.csv", dtype=str).fillna("")
tone_reconciliation = pd.read_csv(DATA / "internal_official_tone_reconciliation.csv", dtype=str).fillna("")
masglo_assets = pd.read_csv(DATA / "masglo_local_asset_manifest_audited.csv", dtype=str).fillna("")

exceptions = []
for _, row in source_reconciliation[source_reconciliation["reconciliation_status"] != "EXACTO"].iterrows():
    exceptions.append({
        "exception_scope": "SOURCE_ROW",
        "entity_key": f"Excel:{row['source_excel_row']}",
        "brand": row["source_brand_normalized"],
        "entity_name": row["source_description"],
        "exception_type": row["reconciliation_status"],
        "severity": "HIGH" if row["reconciliation_status"] in {"CONFLICTO", "INSUFICIENTE"} else "MEDIUM",
        "status": "OPEN",
        "evidence": row["decision_reason"],
        "required_action": "REVISAR_Y_APROBAR_MANUALMENTE",
        "publish_allowed": "NO",
    })
for _, row in tone_reconciliation[tone_reconciliation["match_status"] != "CONFIRMADO_OFICIAL"].iterrows():
    exceptions.append({
        "exception_scope": "TONE",
        "entity_key": row["internal_shade_id"],
        "brand": row["internal_brand"],
        "entity_name": row["internal_shade_name"],
        "exception_type": "NO_ENCONTRADO_EN_CATALOGO_OFICIAL_ACTUAL",
        "severity": "MEDIUM",
        "status": "OPEN",
        "evidence": "El tono interno no produjo coincidencia exacta en la fuente oficial actual.",
        "required_action": "CONTRASTAR_CATALOGO_HISTORICO_ENVASE_O_FOTOGRAFIA_PROPIA",
        "publish_allowed": "NO",
    })
for _, row in registry[registry["research_status"] != "FUENTE_OFICIAL_CAPTURADA"].iterrows():
    exceptions.append({
        "exception_scope": "BRAND",
        "entity_key": row["brand_id"],
        "brand": row["brand"],
        "entity_name": row["brand"],
        "exception_type": row["research_status"],
        "severity": "HIGH" if row["research_status"] == "REQUIERE_LEVANTAMIENTO_FISICO" else "MEDIUM",
        "status": "OPEN",
        "evidence": row["initial_identity_status"],
        "required_action": row["next_action"],
        "publish_allowed": "NO",
    })
for _, row in image_queue.iterrows():
    exceptions.append({
        "exception_scope": "IMAGE",
        "entity_key": row["variant_id"],
        "brand": row["brand"],
        "entity_name": f"{row['product_name']} / {row['variant_name']}",
        "exception_type": row["classification"],
        "severity": "HIGH" if row["classification"] in {"REQUIERE_FOTOGRAFIA_PROPIA", "CODIGO_INSUFICIENTE_O_IDENTIDAD_PENDIENTE"} else "MEDIUM",
        "status": "OPEN",
        "evidence": row["official_evidence_url"] or row["current_internal_storage_paths"],
        "required_action": row["required_action"],
        "publish_allowed": "NO",
    })
for _, row in masglo_assets[masglo_assets["evidence_status"] == "VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL"].iterrows():
    exceptions.append({
        "exception_scope": "IMAGE_RIGHTS_AND_REPRESENTATION",
        "entity_key": row["sku_fabricante"],
        "brand": "Masglo",
        "entity_name": row["tono"],
        "exception_type": "VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL",
        "severity": "HIGH",
        "status": "OPEN",
        "evidence": row["ruta_storage"],
        "required_action": "VALIDAR_DERECHOS_Y_NO_PRESENTAR_COMO_FOTOGRAFIA_INDIVIDUAL",
        "publish_allowed": "NO",
    })
exceptions_df = pd.DataFrame(exceptions)
exceptions_df.to_csv(DATA / "master_exception_register.csv", index=False)

metrics = {
    "canonical_taxonomy_rows": len(canonical_taxonomy),
    "brand_coverage_rows": len(brand_coverage),
    "collection_coverage_rows": len(collection_coverage),
    "exception_rows": len(exceptions_df),
    "open_exception_rows": int((exceptions_df["status"] == "OPEN").sum()),
}
(DATA / "master_tables_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
