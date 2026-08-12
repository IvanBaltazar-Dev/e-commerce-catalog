# Investigación y enriquecimiento del catálogo

Este directorio conserva evidencia externa, normalización, reconciliación y trabajo manual. Su flujo es conservador y reentrante:

```text
FUENTES → RAW → NORMALIZADO → STAGING → RECONCILIACIÓN
→ REVISIÓN HUMANA → CANÓNICO
```

La investigación nunca escribe directamente en productos, variantes, tonos, medios o relaciones. El contrato general está en [docs/catalogo.md](../../docs/catalogo.md).

## Almacenamiento local administrado

Git conserva código, contratos, reportes humanos y `local-storage.manifest.json`. Los payloads se excluyen:

- `sources/`: snapshots RAW de fuentes externas;
- `data/`: CSV/JSON derivados y regenerables;
- `local/`: inputs privados, binarios y salidas de trabajo.
- `backups/`: volcados de base pesados; el corte requerido por el checkpoint se referencia por ruta, tamaño y SHA-256, pero no se versiona.

Por omisión estas carpetas viven en `research/catalog-master`. `CATALOG_RESEARCH_STORAGE_ROOT` puede moverlas a otro disco. Las demás rutas privadas se configuran con las variables documentadas en `.env.example`.

```bash
npm run catalog:storage:verify
```

El comando compara tamaño y SHA-256 de cada archivo con el manifiesto versionado, incluido el volcado de datos exigido por el checkpoint. Restaurar un checkpoint completo exige restaurar también este almacenamiento hasta obtener el mismo fingerprint.

Tras `supabase db reset`, `npm run checkpoint:restore:local` restaura el catálogo base desde ese volcado, reconstruye sus proyecciones y vuelve a cargar el staging de investigación. `CATALOG_CHECKPOINT_DATA_SQL` permite reubicar el volcado sin cambiar su identidad.

Las campañas nuevas guardan cada captura en `local/research-runs/<source-key>/<raw-fingerprint>/`. Cada directorio tiene un `manifest.json` autocontenido; `catalog:storage:verify` valida también estos manifiestos dinámicos sin agregar sus payloads a Git.

## Corte medido del 10 de agosto de 2026

- 1.500 filas fuente con resultado: 1.393 `EXACTO`, 6 `PROBABLE_EXISTENTE`, 95 `CONFLICTO` y 6 `INSUFICIENTE`.
- 185 etiquetas de marca cuantificadas.
- 6 fuentes oficiales capturadas masivamente: Masglo, Admiss, AcryLove, MC Nails, Cherimoya y Bigen.
- 3.298 productos, 3.406 variantes y 5.787 imágenes externas inventariadas.
- 253 tonos internos cruzados; 172 coincidencias exactas con imagen oficial en ese corte.
- 371 relaciones candidatas; ninguna promovida automáticamente.
- 2.101 excepciones abiertas y visibles.

Estos conteos son históricos y deben regenerarse antes de usarlos para planificar.

## Ejecución reproducible

```bash
node research/catalog-master/export-snapshot.mjs
python research/catalog-master/analyze-internal.py
node research/catalog-master/crawl-official-sources.mjs
python research/catalog-master/reconcile-official.py
python research/catalog-master/reconcile-source-rows.py
python research/catalog-master/build-enrichment-candidates.py
python research/catalog-master/build-media-work-queues.py
python research/catalog-master/build-master-tables.py
node research/catalog-master/download-verified-tone-images.mjs
npm run catalog:enrichment:stage
```

El último paso requiere las migraciones de enriquecimiento aplicadas y usa `.env.supabase.local`. Repetir el mismo contenido no duplica snapshots ni trabajos equivalentes.

Para una fuente oficial registrada, la ruta vigente marca + fuente es:

```bash
npm run research:official-brand -- --source-key admiss-co-official --brand ADMISS --summary
```

El adaptador parte de `catalog_sources.base_url`, descubre robots, manifiestos para agentes, sitemaps, colecciones y superficies de producto compatibles y conserva la evidencia RAW administrada. Los campos volátiles observados se guardan, pero se excluyen de la huella material para no fabricar deltas.

## Gates

- Solo `EXACTO` puede proponerse para automatización; no significa publicación automática.
- `PROBABLE_EXISTENTE`, `CONFLICTO` e `INSUFICIENTE` permanecen bloqueados.
- URL remota no equivale a activo publicable.
- Regla heurística no equivale a compatibilidad técnica.
- Un visual estandarizado no se presenta como fotografía individual.
- El gate principal es `npm run gate:enriquecimiento`.

## Trabajo humano

- [Bandeja de evidencia física](evidence-inbox/README.md)
- [Bandeja de apuntes manuales](manual-intake/README.md)
- [Apuntes capturados](manual-intake/apuntes-productos.md)
- [Segunda pasada de marcas](reports/segunda-pasada-marcas-2026-08-10.md)

Los apuntes no aplican decisiones. Solo un caso marcado `APLICADO` y reflejado por el comando canónico cuenta como cambio real.
