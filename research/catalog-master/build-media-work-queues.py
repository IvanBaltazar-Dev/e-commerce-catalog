from __future__ import annotations

import json
import pandas as pd

from storage import DATA, configured_path

DATA.mkdir(parents=True, exist_ok=True)
MASGLO_MANIFEST = configured_path(
    "CATALOG_MASGLO_MANIFEST", "inputs", "masglo", "MANIFIESTO_IMAGENES.csv"
)


catalog = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str).fillna("")
products = catalog.drop_duplicates("product_id").copy()
variants = catalog[catalog["variant_id"] != ""].drop_duplicates("variant_id").copy()
tones = pd.read_csv(DATA / "internal_official_tone_reconciliation.csv", dtype=str).fillna("")
product_matches = pd.read_csv(DATA / "internal_official_product_reconciliation.csv", dtype=str).fillna("")
brand_registry = pd.read_csv(DATA / "brand_resolution_registry.csv", dtype=str).fillna("")
official_images = pd.read_csv(DATA / "external_official_images.csv", dtype=str).fillna("")

tone_by_variant = {row["internal_variant_id"]: row for _, row in tones.iterrows()}
match_by_product = {row["internal_product_id"]: row for _, row in product_matches.iterrows()}
brand_status = {str(row["brand"]).casefold(): row["research_status"] for _, row in brand_registry.iterrows()}

media_rows = []
for _, row in variants.iterrows():
    tone = tone_by_variant.get(row["variant_id"])
    product_match = match_by_product.get(row["product_id"])
    internal_media_count = int(float(row.get("variant_media_count", "0") or 0))
    internal_paths = row.get("variant_storage_paths", "")
    official_url = tone["official_image_url"] if tone is not None else ""
    official_source = tone["official_product_url"] if tone is not None else ""

    if official_url:
        classification = "ENCONTRADA_OFICIAL_PENDIENTE_DESCARGA"
        action = "DESCARGAR_NORMALIZAR_HASH_Y_APROBAR"
        confidence = "CONFIRMADO_OFICIAL"
    elif internal_media_count > 0:
        classification = "ACTIVO_INTERNO_REQUIERE_AUDITORIA"
        action = "VERIFICAR_ORIGEN_DERECHOS_Y_CORRESPONDENCIA_DE_VARIANTE"
        confidence = "SIN_CLASIFICAR_ORIGEN"
    elif product_match is not None and product_match["match_status"] in {"CONFIRMADO_OFICIAL", "CANDIDATO_ALTO"} and product_match["official_primary_image_url"]:
        classification = "IMAGEN_DE_PRODUCTO_OFICIAL_PENDIENTE_VALIDAR_VARIANTE"
        action = "VALIDAR_QUE_LA_IMAGEN_REPRESENTE_ESTA_VARIANTE"
        confidence = product_match["match_status"]
        official_url = product_match["official_primary_image_url"]
        official_source = product_match["official_product_url"]
    elif brand_status.get(str(row["brand"]).casefold()) == "REQUIERE_LEVANTAMIENTO_FISICO":
        classification = "REQUIERE_FOTOGRAFIA_PROPIA"
        action = "INCLUIR_EN_SESION_FOTOGRAFICA"
        confidence = "REQUIERE_VERIFICACION_FISICA"
    else:
        classification = "CODIGO_INSUFICIENTE_O_IDENTIDAD_PENDIENTE"
        action = "RESOLVER_IDENTIDAD_ANTES_DE_BUSCAR_O_ASOCIAR_IMAGEN"
        confidence = "SIN_CONFIRMAR"

    media_rows.append({
        "variant_id": row["variant_id"],
        "sku": row["sku"],
        "brand": row["brand"],
        "product_code": row["product_code"],
        "product_name": row["product_name"],
        "variant_name": row["variant_name"],
        "shade_name": row["shade_name"],
        "family": row["category"],
        "classification": classification,
        "confidence": confidence,
        "current_internal_media_count": internal_media_count,
        "current_internal_storage_paths": internal_paths,
        "official_remote_image_url": official_url,
        "official_evidence_url": official_source,
        "required_action": action,
        "publish_allowed_now": "NO",
    })

media_queue = pd.DataFrame(media_rows)
media_queue.to_csv(DATA / "image_pending_queue.csv", index=False)

physical_brand_names = set(
    brand_registry.loc[brand_registry["research_status"] == "REQUIERE_LEVANTAMIENTO_FISICO", "brand"].str.casefold()
)
physical_products = products[products["brand"].str.casefold().isin(physical_brand_names)].copy()
variant_counts = variants.groupby("product_id").size().to_dict()
physical_rows = []
for _, row in physical_products.iterrows():
    physical_rows.append({
        "session_group": f"{row['category']} | {row['brand']}",
        "brand_label": row["brand"],
        "product_code": row["product_code"],
        "product_name": row["product_name"],
        "presentation": row["presentation"],
        "family": row["category"],
        "variants_to_capture": variant_counts.get(row["product_id"], 0),
        "reason": "Marca descriptiva, genérica, OEM o identidad digital insuficiente.",
        "required_shots": "Frente | reverso | lateral izquierdo | lateral derecho | base | tapa | caja | accesorios incluidos",
        "required_labels": "Código de barras | SKU/código impreso | volumen | ingredientes | lote | potencia/voltaje | medidas | colores disponibles",
        "handling_note": "Una carpeta por código interno; una subcarpeta por variante; no reutilizar la misma foto entre tonos.",
        "priority": "P0" if row["brand_is_generic"] == "t" else "P1",
    })
physical_checklist = pd.DataFrame(physical_rows).sort_values(["priority", "session_group", "product_name"])
physical_checklist.to_csv(DATA / "physical_capture_checklist.csv", index=False)

official_inventory = official_images.copy()
official_inventory["inventory_status"] = "DESCUBIERTA_REMOTA_NO_PERSISTIDA"
official_inventory["required_action"] = "DESCARGAR_HASH_EXACTO_HASH_PERCEPTUAL_NORMALIZAR_Y_REVISAR"
official_inventory["publish_allowed_now"] = "NO"
official_inventory.to_csv(DATA / "official_image_inventory.csv", index=False)

if MASGLO_MANIFEST.exists():
    masglo = pd.read_csv(MASGLO_MANIFEST, dtype=str).fillna("")
    masglo["asset_root"] = str(MASGLO_MANIFEST.parent)
    masglo["evidence_status"] = masglo["tipo_imagen"].apply(
        lambda value: "FOTO_OFICIAL_ORIGINAL" if "oficial original" in value.casefold() else "VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL"
    )
    masglo["publish_gate"] = "VALIDAR_DERECHOS_Y_CORRESPONDENCIA"
    masglo.to_csv(DATA / "masglo_local_asset_manifest_audited.csv", index=False)
    masglo_assets = len(masglo)
    masglo_standardized = int((masglo["evidence_status"] == "VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL").sum())
else:
    masglo_assets = masglo_standardized = 0

counts = media_queue["classification"].value_counts().to_dict()
metrics = {
    "variants_classified": len(media_queue),
    "variants_classification_pct": round(100 * len(media_queue) / max(1, len(variants)), 2),
    "official_images_discovered": len(official_inventory),
    "official_tone_images_ready_for_download": int(counts.get("ENCONTRADA_OFICIAL_PENDIENTE_DESCARGA", 0)),
    "official_product_images_need_variant_validation": int(counts.get("IMAGEN_DE_PRODUCTO_OFICIAL_PENDIENTE_VALIDAR_VARIANTE", 0)),
    "internal_assets_need_audit": int(counts.get("ACTIVO_INTERNO_REQUIERE_AUDITORIA", 0)),
    "requires_own_photography": int(counts.get("REQUIERE_FOTOGRAFIA_PROPIA", 0)),
    "identity_must_be_resolved_first": int(counts.get("CODIGO_INSUFICIENTE_O_IDENTIDAD_PENDIENTE", 0)),
    "physical_products_in_checklist": len(physical_checklist),
    "masglo_local_assets_manifested": masglo_assets,
    "masglo_standardized_visuals_not_individual_photos": masglo_standardized,
}
(DATA / "media_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
