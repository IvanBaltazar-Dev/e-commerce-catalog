from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
import pandas as pd

from storage import DATA

DATA.mkdir(parents=True, exist_ok=True)


def norm(value: object) -> str:
    if pd.isna(value):
        return ""
    value = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii").casefold()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    value = re.sub(r"\bn(?:\s+o)?\s+(?=\d)", "", value)
    return re.sub(r"\s+", " ", value).strip()


def score(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    left_tokens, right_tokens = set(left.split()), set(right.split())
    containment = len(left_tokens & right_tokens) / max(1, min(len(left_tokens), len(right_tokens)))
    sequence = SequenceMatcher(None, left, right).ratio()
    substring = 0.94 if min(len(left), len(right)) >= 6 and (left in right or right in left) else 0.0
    return max(sequence, containment * 0.9, substring)


source = pd.read_csv(DATA / "bellaroshe_source_catalog.csv", dtype=str).fillna("")
catalog = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str).fillna("")

source_columns = list(source.columns)
source_row_col = source_columns[0]
source_category_col = source_columns[1]
source_family_col = source_columns[2]
source_review_col = source_columns[3]
source_code_col = source_columns[4]
source_brand_raw_col = source_columns[5]
source_description_col = source_columns[6]
source_supplier_code_col = source_columns[8]
source_supplier_col = source_columns[9]
source_brand_col = source_columns[10]

source["_description_norm"] = source[source_description_col].map(norm)
source["_brand_norm"] = source[source_brand_col].map(norm)
catalog["_description_norm"] = catalog["description"].map(norm)
catalog["_product_norm"] = catalog["product_name"].map(norm)
catalog["_variant_norm"] = catalog["variant_name"].map(norm)
catalog["_combined_norm"] = (catalog["product_name"] + " " + catalog["variant_name"]).map(norm)
catalog["_brand_norm"] = catalog["brand"].map(norm)
catalog["_brand_product_norm"] = (catalog["brand"] + " " + catalog["product_name"]).map(norm)
catalog["_brand_variant_norm"] = (catalog["brand"] + " " + catalog["variant_name"]).map(norm)

brand_aliases = {
    "otros": "generica sin marca",
    "generico": "generica sin marca",
    "sin marca": "generica sin marca",
}

rows = []
for _, item in source.iterrows():
    query = item["_description_norm"]
    source_brand = brand_aliases.get(item["_brand_norm"], item["_brand_norm"])
    review_state = item[source_review_col]

    exact = catalog[
        (catalog["_description_norm"] == query)
        | (catalog["_product_norm"] == query)
        | (catalog["_variant_norm"] == query)
        | (catalog["_combined_norm"] == query)
        | (catalog["_brand_product_norm"] == query)
        | (catalog["_brand_variant_norm"] == query)
    ].copy()
    if source_brand:
        exact_brand = exact[exact["_brand_norm"] == source_brand]
        if not exact_brand.empty:
            exact = exact_brand
    exact = exact.drop_duplicates(["product_id", "variant_id"])

    candidate = None
    candidate_score = 0.0
    runner_score = 0.0
    candidate_count = len(exact)
    method = ""
    if not exact.empty:
        candidate = exact.iloc[0]
        candidate_score = 1.0
        method = "COINCIDENCIA_TEXTO_EXACTO"
    else:
        pool = catalog[catalog["_brand_norm"] == source_brand] if source_brand else catalog
        if pool.empty or source_brand == "generica sin marca":
            family_pool = catalog[catalog["category"].map(norm) == norm(item[source_family_col])]
            pool = family_pool if not family_pool.empty else catalog
        scored = []
        for _, option in pool.drop_duplicates(["product_id", "variant_id"]).iterrows():
            option_score = max(
                score(query, option["_description_norm"]),
                score(query, option["_product_norm"]),
                score(query, option["_variant_norm"]),
                score(query, option["_combined_norm"]),
            )
            scored.append((option_score, option))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        if scored:
            candidate_score, candidate = scored[0]
            runner_score = scored[1][0] if len(scored) > 1 else 0.0
            candidate_count = sum(1 for option_score, _ in scored if option_score >= candidate_score - 0.03)
            method = "COINCIDENCIA_TEXTO_APROXIMADO"

    if review_state.casefold() != "clasificado" or "pendiente" in item[source_category_col].casefold():
        status = "INSUFICIENTE"
        reason = "La fila fuente ya estaba marcada para revisión manual."
    elif candidate is not None and candidate_score == 1.0:
        status = "EXACTO"
        reason = "Descripción, producto o variante coincide exactamente tras normalización."
    elif candidate is not None and candidate_score >= 0.88 and runner_score < candidate_score - 0.03:
        status = "PROBABLE_EXISTENTE"
        reason = "Coincidencia alta, pero requiere aprobación humana antes de promoverse."
    elif candidate is not None and candidate_score >= 0.72:
        status = "CONFLICTO"
        reason = "Hay similitud útil, pero también ambigüedad o transformación estructural."
    else:
        status = "INSUFICIENTE"
        reason = "No existe evidencia textual suficiente para una asociación segura."

    rows.append({
        "source_excel_row": item[source_row_col],
        "source_category": item[source_category_col],
        "source_family": item[source_family_col],
        "source_review_state": review_state,
        "source_code": item[source_code_col],
        "source_brand_raw": item[source_brand_raw_col],
        "source_brand_normalized": item[source_brand_col],
        "source_description": item[source_description_col],
        "source_supplier_code": item[source_supplier_code_col],
        "source_supplier": item[source_supplier_col],
        "reconciliation_status": status,
        "matching_method": method,
        "matching_score": round(candidate_score, 4),
        "ambiguous_candidate_count": candidate_count,
        "internal_product_id": candidate["product_id"] if candidate is not None else "",
        "internal_product_code": candidate["product_code"] if candidate is not None else "",
        "internal_brand": candidate["brand"] if candidate is not None else "",
        "internal_product_name": candidate["product_name"] if candidate is not None else "",
        "internal_variant_id": candidate["variant_id"] if candidate is not None else "",
        "internal_sku": candidate["sku"] if candidate is not None else "",
        "internal_variant_name": candidate["variant_name"] if candidate is not None else "",
        "decision_reason": reason,
        "canonical_write_allowed": "SI" if status == "EXACTO" else "NO",
    })

result = pd.DataFrame(rows)
result.to_csv(DATA / "source_row_reconciliation.csv", index=False)

status_counts = result["reconciliation_status"].value_counts().to_dict()
metrics = {
    "source_rows": len(result),
    "rows_with_explicit_outcome": int(result["reconciliation_status"].ne("").sum()),
    "explicit_outcome_pct": round(100 * result["reconciliation_status"].ne("").mean(), 2),
    "exact": int(status_counts.get("EXACTO", 0)),
    "probable_existing": int(status_counts.get("PROBABLE_EXISTENTE", 0)),
    "conflict": int(status_counts.get("CONFLICTO", 0)),
    "insufficient": int(status_counts.get("INSUFICIENTE", 0)),
    "automatic_write_allowed": int((result["canonical_write_allowed"] == "SI").sum()),
    "automatic_write_blocked": int((result["canonical_write_allowed"] == "NO").sum()),
}
(DATA / "source_reconciliation_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
