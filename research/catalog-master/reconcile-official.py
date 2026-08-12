from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
import pandas as pd

from storage import DATA

DATA.mkdir(parents=True, exist_ok=True)


def text(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def norm(value: object) -> str:
    value = unicodedata.normalize("NFKD", text(value)).encode("ascii", "ignore").decode("ascii")
    value = value.casefold().replace("n.º", " ").replace("n°", " ").replace("nº", " ")
    value = re.sub(r"\b(masglo|admiss|acry\s*love|mcnails|mc\s+nails|cherimoya|bigen)\b", " ", value)
    value = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:ml|gr|g|oz|pza|pzas|und|unidades)\b", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def token_score(left: object, right: object) -> float:
    a, b = norm(left), norm(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    seq = SequenceMatcher(None, a, b).ratio()
    aset, bset = set(a.split()), set(b.split())
    jaccard = len(aset & bset) / max(1, len(aset | bset))
    containment = len(aset & bset) / max(1, min(len(aset), len(bset)))
    substring = 0.92 if (a in b or b in a) and min(len(a), len(b)) >= 5 else 0.0
    return max(seq, 0.55 * containment + 0.45 * jaccard, substring)


def masglo_line(row: pd.Series) -> str:
    haystack = f"{text(row['title'])} | {text(row['tags'])}".upper()
    if "GEL EVOLUTION" in haystack:
        return "Gel Evolution"
    if any(token in haystack for token in ["GEL POLISH", "MASGLO PROFESSIONAL", "SEMIPERMANENTE"]):
        return "Masglo Professional / Gel Polish"
    if "MASGLO KIDS" in haystack:
        return "Masglo Kids"
    if "ADVANCED" in haystack:
        return "Masglo Advanced"
    if "TRADICIONAL" in haystack:
        return "Tradicional"
    return text(row["product_type"]) or "Otros Masglo"


def admiss_line(row: pd.Series) -> str:
    haystack = f"{text(row['title'])} | {text(row['tags'])}".upper()
    if "DECORACION" in haystack or "DECORACIÓN" in haystack:
        return "Decoración"
    if "BASE" in haystack:
        return "Bases"
    if "BRILLO" in haystack:
        return "Brillos"
    if "ESMALTE TRADICIONAL" in haystack:
        return "Esmalte tradicional"
    return text(row["product_type"]) or "Otros Admiss"


def acrylove_line(row: pd.Series) -> str:
    tags = [part.strip() for part in text(row["tags"]).split("|") if part.strip()]
    priority = [
        "LOVE G3L", "AURA G3L", "ON GEL", "ACRYLIC", "GEL - ARTE", "DECOR ONE",
        "LOVE EFFECTS", "RUBBER", "SOFT GEL", "POLYGEL", "HERRAMIENTAS NAILS",
        "PINCELES / ACRYLIC", "DECOR NAILS",
    ]
    upper = " | ".join(tags).upper()
    for candidate in priority:
        if candidate in upper:
            return candidate.title()
    return tags[0] if tags else "Otros AcryLove"


def official_line(row: pd.Series) -> str:
    brand = text(row["brand"])
    if brand == "Masglo":
        return masglo_line(row)
    if brand == "Admiss":
        return admiss_line(row)
    if brand == "AcryLove":
        return acrylove_line(row)
    if brand == "MC Nails":
        return text(row["product_type"]) or "Otros MC Nails"
    if brand == "Cherimoya":
        product_type = text(row["product_type"])
        return product_type.split("|")[0].strip() if product_type else "Otros Cherimoya"
    if brand == "Bigen":
        return text(row["title"])
    return text(row["product_type"]) or "Sin línea identificada"


def tone_from_title(row: pd.Series) -> tuple[str, str]:
    brand, title, line = text(row["brand"]), text(row["title"]), text(row["canonical_line"])
    if brand in {"Masglo", "Admiss"} and "ESMALTE" in title.upper():
        tone = re.split(r"\s+-\s+ESMALTE", title, maxsplit=1, flags=re.IGNORECASE)[0]
        return tone.strip(), ""
    if brand == "AcryLove":
        match = re.search(r"(?:#|N[ÚU]MERO\s*)(\d{1,3})\b", title, re.IGNORECASE)
        if match and any(token in line.casefold() for token in ["g3l", "on gel"]):
            return f"N.º {match.group(1)}", match.group(1)
    if brand == "MC Nails":
        match = re.search(r"(?:#|N[ÚU]MERO\s*)(\d{1,3})\b", title, re.IGNORECASE)
        if match and any(token in line.casefold() for token in ["colorful", "polvos acrílicos"]):
            return f"N.º {match.group(1)}", match.group(1)
    if brand == "Cherimoya":
        match = re.match(r"\s*(\d{3})\s+", title)
        if match and "Esmalte" in line:
            return f"N.º {match.group(1)}", match.group(1)
    return "", ""


internal = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str).fillna("")
external_products = pd.read_csv(DATA / "external_official_products.csv", dtype=str).fillna("")
external_variants = pd.read_csv(DATA / "external_official_variants.csv", dtype=str).fillna("")
external_images = pd.read_csv(DATA / "external_official_images.csv", dtype=str).fillna("")

external_products["canonical_line"] = external_products.apply(official_line, axis=1)
tones = external_products.apply(tone_from_title, axis=1)
external_products["tone_name"] = [item[0] for item in tones]
external_products["tone_code"] = [item[1] for item in tones]
external_products.to_csv(DATA / "external_official_products_enriched.csv", index=False)

line_rows = []
for (brand, line), group in external_products.groupby(["brand", "canonical_line"], dropna=False):
    line_rows.append({
        "brand": brand,
        "line": line,
        "products": group["external_product_id"].nunique(),
        "variants": int(pd.to_numeric(group["variant_count"], errors="coerce").fillna(0).sum()),
        "tones": int((group["tone_name"] != "").sum()),
        "images": int(pd.to_numeric(group["image_count"], errors="coerce").fillna(0).sum()),
        "source_root_url": group.iloc[0]["source_root_url"],
        "captured_at": group.iloc[0]["captured_at"],
        "confidence": "CONFIRMADO_OFICIAL",
    })
pd.DataFrame(line_rows).sort_values(["brand", "products"], ascending=[True, False]).to_csv(
    DATA / "external_official_lines.csv", index=False
)

brand_map = {
    "masglo": "Masglo",
    "admiss": "Admiss",
    "acrylove": "AcryLove",
    "mc nails": "MC Nails",
    "cherimoya": "Cherimoya",
    "bigen": "Bigen",
}

unique_internal_products = internal.drop_duplicates("product_id").copy()
product_matches = []
for _, item in unique_internal_products.iterrows():
    source_brand = brand_map.get(text(item["brand"]).casefold())
    if not source_brand:
        continue
    candidates = external_products[external_products["brand"] == source_brand].copy()
    scored = []
    for _, candidate in candidates.iterrows():
        score = token_score(item["product_name"], candidate["title"])
        scored.append((score, candidate))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    top = scored[:3]
    best_score = top[0][0] if top else 0.0
    runner_score = top[1][0] if len(top) > 1 else 0.0
    ambiguous = runner_score >= best_score - 0.03
    if best_score >= 0.98 and not ambiguous:
        status = "CONFIRMADO_OFICIAL"
    elif best_score >= 0.84 and not ambiguous:
        status = "CANDIDATO_ALTO"
    else:
        status = "REQUIERE_REVISION"
    product_matches.append({
        "internal_product_id": item["product_id"],
        "internal_brand": item["brand"],
        "internal_product_name": item["product_name"],
        "internal_product_code": item["product_code"],
        "match_status": status,
        "match_score": round(best_score, 4),
        "ambiguous": ambiguous,
        "official_product_id": top[0][1]["external_product_id"] if top else "",
        "official_title": top[0][1]["title"] if top else "",
        "official_line": top[0][1]["canonical_line"] if top else "",
        "official_product_url": top[0][1]["source_product_url"] if top else "",
        "official_primary_image_url": top[0][1]["primary_image_url"] if top else "",
        "candidate_2": top[1][1]["title"] if len(top) > 1 else "",
        "candidate_2_score": round(top[1][0], 4) if len(top) > 1 else "",
        "candidate_3": top[2][1]["title"] if len(top) > 2 else "",
        "candidate_3_score": round(top[2][0], 4) if len(top) > 2 else "",
    })
product_matches_df = pd.DataFrame(product_matches)
product_matches_df.to_csv(DATA / "internal_official_product_reconciliation.csv", index=False)

# Shade/tone reconciliation is deliberately stricter than product matching: only an exact
# normalized tone/code is auto-confirmed. Anything else remains reviewable evidence.
internal_shades = internal[internal["shade_id"] != ""].drop_duplicates("shade_id").copy()
tone_matches = []
for _, item in internal_shades.iterrows():
    source_brand = brand_map.get(text(item["brand"]).casefold())
    candidates: list[dict] = []
    if source_brand in {"Masglo", "Admiss"}:
        source_rows = external_products[
            (external_products["brand"] == source_brand) & (external_products["tone_name"] != "")
        ]
        for _, candidate in source_rows.iterrows():
            score = token_score(item["shade_name"], candidate["tone_name"])
            candidates.append({"score": score, "kind": "product", "row": candidate})
    elif source_brand == "Bigen":
        source_rows = external_variants[
            (external_variants["brand"] == "Bigen")
            & (external_variants["product_title"].str.contains("Permanent Powder", case=False, na=False))
        ]
        wanted = re.search(r"(\d{2,3})", text(item["shade_name"]))
        for _, candidate in source_rows.iterrows():
            offered = re.match(r"\s*(\d{2,3})\b", text(candidate["variant_title"]))
            score = 1.0 if wanted and offered and wanted.group(1) == offered.group(1) else 0.0
            candidates.append({"score": score, "kind": "variant", "row": candidate})

    candidates.sort(key=lambda candidate: candidate["score"], reverse=True)
    best = candidates[0] if candidates else None
    score = best["score"] if best else 0.0
    confirmed = score == 1.0
    official_product_id = text(best["row"]["external_product_id"]) if best else ""
    official_variant_id = text(best["row"].get("external_variant_id", "")) if best else ""
    if best and best["kind"] == "product":
        official_tone = text(best["row"]["tone_name"])
        official_title = text(best["row"]["title"])
        official_url = text(best["row"]["source_product_url"])
        image_url = text(best["row"]["primary_image_url"])
    elif best:
        official_tone = text(best["row"]["variant_title"])
        official_title = text(best["row"]["product_title"])
        official_url = text(best["row"]["source_product_url"])
        product_images = external_images[
            (external_images["brand"] == source_brand)
            & (external_images["external_product_id"] == official_product_id)
        ]
        linked = product_images[
            product_images["variant_ids"].apply(lambda value: official_variant_id in text(value).split(" | "))
        ]
        image_url = text((linked if not linked.empty else product_images).iloc[0]["image_url"]) if not product_images.empty else ""
    else:
        official_tone = official_title = official_url = image_url = ""
    tone_matches.append({
        "internal_shade_id": item["shade_id"],
        "internal_brand": item["brand"],
        "internal_product_name": item["product_name"],
        "internal_variant_id": item["variant_id"],
        "internal_sku": item["sku"],
        "internal_shade_code": item["shade_code"],
        "internal_shade_name": item["shade_name"],
        "internal_variant_media_count": item.get("variant_media_count", "0"),
        "internal_variant_storage_paths": item.get("variant_storage_paths", ""),
        "match_status": "CONFIRMADO_OFICIAL" if confirmed else "NO_ENCONTRADO_EN_CATALOGO_OFICIAL_ACTUAL",
        "match_score": round(score, 4),
        "official_product_id": official_product_id if confirmed else "",
        "official_variant_id": official_variant_id if confirmed else "",
        "official_title": official_title if confirmed else "",
        "official_tone": official_tone if confirmed else "",
        "official_product_url": official_url if confirmed else "",
        "official_image_url": image_url if confirmed else "",
        "image_status": "FOTO_OFICIAL_DISPONIBLE" if confirmed and image_url else "FOTO_OFICIAL_NO_VINCULADA",
        "available_image_asset_status": (
            "ACTIVO_INTERNO_Y_FOTO_OFICIAL_REMOTA"
            if int(float(text(item.get("variant_media_count", "0")) or 0)) > 0 and confirmed and image_url
            else "ACTIVO_INTERNO_REQUIERE_AUDITORIA"
            if int(float(text(item.get("variant_media_count", "0")) or 0)) > 0
            else "FOTO_OFICIAL_REMOTA_PENDIENTE_DESCARGA"
            if confirmed and image_url
            else "SIN_IMAGEN_VERIFICADA"
        ),
    })
tone_matches_df = pd.DataFrame(tone_matches)
tone_matches_df.to_csv(DATA / "internal_official_tone_reconciliation.csv", index=False)

coverage = []
for brand, group in tone_matches_df.groupby("internal_brand"):
    confirmed = group["match_status"] == "CONFIRMADO_OFICIAL"
    with_image = group["image_status"] == "FOTO_OFICIAL_DISPONIBLE"
    available_asset = group["available_image_asset_status"] != "SIN_IMAGEN_VERIFICADA"
    coverage.append({
        "brand": brand,
        "internal_tones": len(group),
        "confirmed_in_current_official_catalog": int(confirmed.sum()),
        "not_found_in_current_official_catalog": int((~confirmed).sum()),
        "official_photo_available": int(with_image.sum()),
        "available_image_asset": int(available_asset.sum()),
        "official_match_pct": round(100 * confirmed.mean(), 2),
        "official_photo_pct": round(100 * with_image.mean(), 2),
        "available_image_asset_pct": round(100 * available_asset.mean(), 2),
    })
coverage_df = pd.DataFrame(coverage).sort_values("internal_tones", ascending=False)
coverage_df.to_csv(DATA / "internal_official_tone_coverage.csv", index=False)

metrics = {
    "official_sources": int(external_products["source_root_url"].nunique()),
    "official_products": int(external_products["external_product_id"].nunique()),
    "official_variants": len(external_variants),
    "official_images": len(external_images),
    "official_lines": len(pd.DataFrame(line_rows)),
    "internal_products_in_sourced_brands": len(product_matches_df),
    "product_matches_confirmed": int((product_matches_df["match_status"] == "CONFIRMADO_OFICIAL").sum()),
    "product_matches_high_candidates": int((product_matches_df["match_status"] == "CANDIDATO_ALTO").sum()),
    "product_matches_require_review": int((product_matches_df["match_status"] == "REQUIERE_REVISION").sum()),
    "internal_tones": len(tone_matches_df),
    "tone_matches_confirmed": int((tone_matches_df["match_status"] == "CONFIRMADO_OFICIAL").sum()),
    "tone_official_photos": int((tone_matches_df["image_status"] == "FOTO_OFICIAL_DISPONIBLE").sum()),
    "tone_available_image_assets": int((tone_matches_df["available_image_asset_status"] != "SIN_IMAGEN_VERIFICADA").sum()),
}
(DATA / "reconciliation_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
print(coverage_df.to_string(index=False))
