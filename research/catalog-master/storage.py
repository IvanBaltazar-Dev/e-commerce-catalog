from __future__ import annotations

import os
from pathlib import Path


RESEARCH_ROOT = Path(__file__).resolve().parent
STORAGE_ROOT = Path(
    os.environ.get("CATALOG_RESEARCH_STORAGE_ROOT", str(RESEARCH_ROOT))
).expanduser().resolve()
DATA = STORAGE_ROOT / "data"
SOURCES = STORAGE_ROOT / "sources"
LOCAL = STORAGE_ROOT / "local"
OUTPUTS = LOCAL / "outputs"


def configured_path(env_name: str, *fallback: str) -> Path:
    value = os.environ.get(env_name)
    return Path(value).expanduser().resolve() if value else LOCAL.joinpath(*fallback)
