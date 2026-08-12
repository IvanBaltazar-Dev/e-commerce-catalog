import csv
import json
import re
import unicodedata
from collections import Counter

import pandas as pd

from storage import DATA, configured_path


SOURCE_JSON = configured_path("CATALOG_SOURCE_JSON", "inputs", "source-workbook.json")
DATA.mkdir(parents=True, exist_ok=True)


def clean_text(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def slug(value):
    value = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


with SOURCE_JSON.open("r", encoding="utf-8") as handle:
    workbook = json.load(handle)

source_rows = workbook["Catálogo organizado"]
source_headers = [clean_text(item) for item in source_rows[0]]
source = pd.DataFrame(source_rows[1:], columns=source_headers)
source = source.fillna("")
for column in source.columns:
    source[column] = source[column].map(clean_text)
source.insert(0, "Fila Excel", range(2, len(source) + 2))
source["Marca normalizada"] = source["Marca o línea"].str.upper().str.strip()
source["Descripción normalizada"] = source["Descripción original"].str.upper().str.strip()
source.to_csv(DATA / "bellaroshe_source_catalog.csv", index=False, encoding="utf-8-sig", quoting=csv.QUOTE_MINIMAL)

family_rows = workbook["Familias y ejemplos"]
family_headers = [clean_text(item) for item in family_rows[0]]
families = pd.DataFrame(family_rows[1:], columns=family_headers).fillna("")
families.to_csv(DATA / "bellaroshe_source_families.csv", index=False, encoding="utf-8-sig")

flat = pd.read_csv(DATA / "bellaroshe_catalog_flat.csv", dtype=str, keep_default_na=False)
coverage = pd.read_csv(DATA / "bellaroshe_brand_coverage_internal.csv", dtype=str, keep_default_na=False)

descriptor_brands = {
    "CORDLESS", "CURVEX", "DESK LAMP", "DRILL PRO", "ELECTRIC NAIL DRILL",
    "EYES", "FACE GEMS", "FASHION", "GEMS STICKERS", "HAND MADE", "LASH",
    "MAGNETIC", "NAIL ACCESSORIES", "NAIL ART", "NAIL ART STICKER", "NAIL ART TOOL",
    "NAIL DRILLPORTABLE", "WAX HEATER", "WIG CAP", "BQ730", "BQI", "CAT EYES",
}

well_known_candidates = {
    "MASGLO", "OPI", "ARDELL", "MIA SECRET", "BIGEN", "WELLA", "TONI&GUY",
    "WAHL", "ANDIS", "AQUANET", "HERBAL ESSENCES", "KIRKLAND", "GIGI", "BANDIDO",
    "KARSEELL", "BIOAQUA", "NAGARAKU", "ZOLA", "WAXKISS", "MUNDIAL", "DORCO",
    "ADMISS", "CHERIMOYA", "MYSTYLE", "MC NAILS", "ACRYLOVE", "CANDY SECRET",
    "REVEL", "BELLESPA", "STRONGER", "SUN", "ROSE&LIN", "KONSUNG", "ICONSIGN",
    "LANOSTERIN", "FAMOSSA", "SUPREME", "AOYASIYUE", "CHARM LIMIT", "AIFER",
}

source_brand_counts = Counter(source["Marca normalizada"])

def initial_status(row):
    name = clean_text(row["brand"]).upper()
    if row.get("is_generic", "").lower() == "true" or name in {"OTROS", "GENÉRICA / SIN MARCA"}:
        return "GENERICA_O_SIN_MARCA"
    if name in descriptor_brands:
        return "DESCRIPTOR_NO_MARCA"
    if name in well_known_candidates:
        return "CANDIDATA_TRAZABLE"
    return "REQUIERE_INVESTIGACION"

coverage["source_rows"] = coverage["brand"].map(lambda name: source_brand_counts.get(clean_text(name).upper(), 0))
coverage["initial_identity_status"] = coverage.apply(initial_status, axis=1)
coverage["research_priority"] = coverage.apply(
    lambda row: (
        "P0_CROMATICO" if int(row.get("shades") or 0) > 0
        else "P1_ALTO_VOLUMEN" if int(row.get("products") or 0) >= 20
        else "P2_MEDIO" if int(row.get("products") or 0) >= 3
        else "P3_COLA_LARGA"
    ), axis=1
)
coverage["source_search_key"] = coverage["brand"].map(slug)
coverage.to_csv(DATA / "bellaroshe_brand_research_queue.csv", index=False, encoding="utf-8-sig")

metrics = {
    "source_rows": len(source),
    "source_classified": int((source["Estado de revisión"].str.casefold() == "clasificado").sum()),
    "source_pending": int((source["Estado de revisión"].str.casefold() != "clasificado").sum()),
    "source_distinct_brand_labels": int(source["Marca normalizada"].nunique()),
    "source_families": int(source["Familia propuesta"].nunique()),
    "internal_products": int(flat["product_id"].nunique()),
    "internal_variants": int(flat["variant_id"].replace("", pd.NA).nunique()),
    "internal_brands": int(coverage.shape[0]),
    "internal_shades": int(flat["shade_id"].replace("", pd.NA).nunique()),
    "internal_media_links": int(pd.to_numeric(coverage["media_links"], errors="coerce").fillna(0).sum()),
    "internal_relations": int(pd.read_csv(DATA / "bellaroshe_relations_internal.csv").shape[0]),
    "brands_traceable_candidates": int((coverage["initial_identity_status"] == "CANDIDATA_TRAZABLE").sum()),
    "brands_descriptor_or_generic": int(coverage["initial_identity_status"].isin(["GENERICA_O_SIN_MARCA", "DESCRIPTOR_NO_MARCA"]).sum()),
    "brands_pending_identity_research": int((coverage["initial_identity_status"] == "REQUIERE_INVESTIGACION").sum()),
}

with (DATA / "internal_metrics.json").open("w", encoding="utf-8") as handle:
    json.dump(metrics, handle, ensure_ascii=False, indent=2)

print(json.dumps(metrics, ensure_ascii=False, indent=2))
