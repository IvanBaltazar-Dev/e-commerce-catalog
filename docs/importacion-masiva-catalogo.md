# Importación masiva del catálogo real Bellaroshé

Herramienta permanente para incorporar el catálogo real (1,500 artículos del Excel
`Listado_organizado_productos_Bellaroshe.xlsx`) a la base V2 sin captura manual,
ampliando el sistema de importación existente (`import_batches`, `import_rows`,
`import_issues` y los módulos XLSX/medios/ZIP). No es un segundo importador: es el
mismo staging con una etapa previa de normalización para listados crudos.

## 1. Qué dice el Excel real (análisis 2026-08-08)

Archivo: `F:\Products_SIVAN\Bellaroshe\version-V2\Listado_organizado_productos_Bellaroshe.xlsx`
(hojas `Resumen`, `Catálogo organizado` con 1,500 filas de datos, `Familias y ejemplos` con 51 familias).

Columnas reales de `Catálogo organizado`:

| # | Columna | Llenado | Observación |
|---|---------|---------|-------------|
| 1 | Categoría propuesta | 1500/1500 | 7 áreas + «Pendiente de clasificación» (6 filas) |
| 2 | Familia propuesta | 1500/1500 | 51 familias |
| 3 | Estado de revisión | 1500/1500 | 1,494 `Clasificado`, 6 `Pendiente` (filas 474–479) |
| 4 | Código | 731/1500 | **Todos únicos** (patrones `AAA999`, `A&A999`) — identifica la unidad vendible |
| 5 | Marca o línea | 1489/1500 | 187 valores; `OTROS` (475 filas) es marcador de «sin marca», no una marca |
| 6 | Descripción original | 1499/1500 | MAYÚSCULAS; fila 477 vacía |
| 7 | Categoría original | 32/1500 | residual, solo trazabilidad |
| 8 | Código proveedor | 526/1500 | **`S/C` = «sin código» → tratar como NULL** (76 filas); resto único por proveedor |
| 9 | Proveedor | 1497/1500 | 71 proveedores; MAY concentra 841 filas |

Señales medidas en las descripciones: presentación (`X2`, `10MTS`, `7GR`, `ML`…) en 489
filas; número de tono (`#26`, `N° 5`) en 51; color textual en 199; medidas (`10MM`, `5 1/2`) en 40.

Duplicados de descripción: 53 grupos (135 filas) en tres subtipos que exigen tratamiento
distinto — mismo proveedor (28 grupos: posible re-registro), distinto proveedor
(25 grupos: mismo artículo con dos abastecimientos → `product_suppliers`, no dos productos),
y con marca distinta (24 grupos: probablemente artículos DIFERENTES; jamás fusionar solos).

Patrones de variante confirmados en filas reales:

- **ADMISS/MASGLO esmaltes**: una fila por tono (`ADM001 | ADMISS | ALEJO`) → 1 producto,
  N variantes con `color_shades`. La descripción ES el nombre del tono.
- **AOYASIYUE pestañas**: `PESTAÑA 1*1 10D 10MM` vs `…12MM` → eje `lash_length`.
- **ANDREA**: `PESTAÑA 1X1 SMALL/MEDIUM/LONG` → eje de talla.
- **ACRYLOVE kits**: `KIT POLVO ACRILICO 7GR. X4pza <COLECCIÓN>` → eje colección/set.
- **CROCODILE**: misma descripción, dos proveedores (filas 5–6) → una variante, dos ofertas.

## 2. Qué existe ya en la BD (verificado contra Supabase local)

- 10 `attribute_templates` (LEGACY_V1, ESMALTE_TONOS, PESTANA_TIRA, EXTENSIONES_PRO,
  ADHESIVO_PRO, LAMPARA, TORNO_ELECTRICO, MAQUINA_CORTE, ACCESORIO_REPUESTO, EXTENSIONES),
  79 `attribute_definitions`, 10 ejes de variante (`tone`, `color`, `lash_curve/thickness/length`,
  `extension_color/length`, `shape`, `strip_style`, `adhesive_color`).
- 16 categorías (árbol parcial: Uñas, Pestañas, Barbería y cabello, Equipos, Accesorios…).
- Staging completo: `import_batches` (estados uploaded→parsing→normalized→needs_review→
  approved→committed/failed), `import_rows` (raw_data/normalized_data/proposed_action/estados,
  únicos por lote+fila), `import_issues` (severidad info/warning/error/blocking, resolución).
- `commit_approved_import_row` (SQL) sólo cubre `create_product` simple; el camino rico es
  `saveCatalogV2Product` (variantes+atributos+medios+precios+rollback). `retailPrice` admite
  NULL → **se puede importar catálogo sin precios** (el Excel no trae precios).
- `product_suppliers` (alcance variante, `supplier_sku`) es el destino natural de
  proveedor + código proveedor. `suppliers` está vacía: se crean como datos al importar.
- `media_assets` ya exige `checksum` único (hash anti-duplicado) y bucket+path únicos.
- Convención física de medios YA desplegada (Masglo, 162 archivos):
  `productos/<PRODUCT_CODE>/main.webp`, `productos/<CODE>/tonos/<tono>.webp`,
  `productos/<CODE>/carta-colores.{webp,pdf}` — el ZIP de medios está restringido a
  `productos/` y a WebP/PDF con validación de firma. Se conserva esa convención
  (clave estable = código de producto + slug de tono), cumpliendo
  «marca/producto/variante/archivo» vía el código estable que ya incluye la marca.

## 3. Decisiones de diseño

1. **Identidad de la unidad vendible = Código interno del Excel** cuando existe
   (731 filas): pasa a `product_variants.sku` (índice único ya existente) y ancla la
   idempotencia. Sin código interno → variante sin SKU con `variant_key` determinista.
2. **Código de producto determinista**: `<MARCA(3)>-<FAMILIA(3)>-<hash6>` calculado de
   (marca normalizada + familia + nombre base sin eje). Re-ejecutar no puede crear un
   segundo producto: choca por `products.code` y se reutiliza.
3. **Escalera de identidad** (en orden, nunca solo descripción):
   código interno → proveedor+código proveedor (S/C excluido) → marca+nombre base+
   presentación → atributos comerciales → descripción normalizada como señal secundaria.
   Mismo nombre+marca con proveedor distinto ⇒ misma variante + segunda oferta
   (`product_suppliers`) sólo si no hay contradicción de atributos; cualquier ambigüedad
   (marca distinta, presentación distinta) ⇒ `needs_review`, jamás fusión automática.
4. **Agrupamiento producto/variante por familia**: cada familia declara su plantilla y
   sus ejes de variante permitidos (los `attribute_definitions` con `is_variant_axis`).
   El nombre base se obtiene quitando el valor del eje detectado; filas que comparten
   marca+familia+nombre base y difieren sólo en el eje se agrupan. Confianza baja ⇒ revisión.
5. **Los 51 → familias como categorías (datos)** bajo las raíces existentes cuando
   correspondan (Uñas, Pestañas, Barbería y cabello…) y nuevas raíces sólo para
   Depilación, Higiene y consumibles, Organización y apoyo, Rostro/cuerpo/maquillaje.
   Plantillas nuevas SOLO genéricas y como datos (sin columnas por familia):
   HERRAMIENTA_BASICA, CONSUMIBLE_BASICO, PRODUCTO_COSMETICO, SISTEMA_UNAS,
   EQUIPO_ELECTRICO, ORGANIZACION_APOYO, PRESS_ON_DECORADO, DECORACION_NAIL_ART.
   Ejes nuevos: `aroma`, `set_name` (colección/set), `size_label` (talla) — reutilizables.
6. **Normalización previa obligatoria**: cada fila del Excel se vuelve un
   `import_rows.raw_data` literal (trazabilidad) + `normalized_data` con el registro
   normalizado completo (§4). El Excel jamás toca las tablas definitivas.
7. **Medios como parte del lote pero sin bloquearlo**: la conciliación clasifica
   `exact` / `high` / `review` / `missing` / `color_fallback`. `exact` y `high` avanzan;
   `review` se aprueba en masa; `missing` no bloquea el commit y queda como deuda visible;
   tono conocido sin foto ⇒ `color_fallback` con `reference_color` y marca
   `media_backfill='color'`; sin tono confiable ⇒ `media_backfill='pending'` + issue.
   Nunca se asocia la foto de otro tono.
8. **Deuda de medios persistida** en `products.media_backfill` /
   `product_variants.media_backfill` (`'color'|'pending'`, NULL = sin deuda), limpiada por
   trigger cuando entra un medio real. Es estado del catálogo, no solo del import.
9. **Commit por clúster de producto** vía `saveCatalogV2Product` + `create_color_shade`
   + `product_suppliers` + medios por hash. `import_rows` marca `committed` con
   `target_product_id`/`target_variant_id`; re-ejecutar un lote sólo procesa filas no
   committed (idempotencia a nivel fila + código + sku + checksum).
10. **Lotes por familias compatibles** (~100–250 filas), piloto primero con los casos
    difíciles obligatorios; el mismo pipeline sirve para todos los lotes.
11. **Sin tocar producción**: piloto local → lote completo en entorno de prueba →
    reporte → recién entonces la carga definitiva. Nada de desactivar constraints.

## 4. Registro normalizado (contenido de `normalized_data`)

```
source:        { sheet, row, estado, categoriaOriginal }        ← texto original íntegro en raw_data
classification:{ familia, categoryPath, templateCode, confidence }
identity:      { internalCode, supplierCode, supplierName, brandName, brandSlug }
naming:        { originalDescription, normalizedName, baseName, presentation }
grouping:      { productKey, productCode, variantKey, axis: {code, value}|null, confidence }
attributes:    [ { code, value, source } ]
color:         { shadeName, shadeCode, colorFamily, referenceColor|null } | null
supplier:      { name, supplierSku|null }
media:         { matches: [{path, mechanism, confidence}], status, backfill|null }
action:        create_product | create_variant | update_product | update_variant | skip | merge
review:        [ razones que exigen revisión ] (vacío si puede avanzar sola)
```

`proposed_action` usa el enum existente; «relacionar con producto existente» =
`update_product` (nueva oferta/variante sobre producto ya creado); «omitir duplicado» =
`skip`; «revisión manual» = fila en `needs_review` con sus `import_issues`.

## 5. Flujo definitivo

`Excel` → ingesta segura (parser genérico con las mismas defensas del XLSX curado)
→ normalización → clasificación familia/plantilla → deduplicación → agrupamiento
producto/variantes → extracción de atributos → conciliación de imágenes → validación
→ `import_rows` + `import_issues` → preview → revisión SOLO de excepciones →
aprobación (individual o masiva) → commit → productos/variantes/precios/atributos/
`color_shades`/`media_assets`/`product_media`/`product_suppliers` → verificación final
→ reporte del lote (obligatorio, con navegación issue → fila original del Excel).

## 6. Reporte por lote (contrato)

filas procesadas · productos nuevos · productos reutilizados · variantes creadas ·
duplicados evitados · imágenes exactas · imágenes alta confianza · imágenes en revisión ·
imágenes faltantes · variantes con color de respaldo · filas rechazadas · issues ·
tiempo del proceso. Cada issue enlaza `import_row` → fila del Excel original.

## 7. Estado de ejecución (2026-08-08)

- [x] Análisis del Excel real y cruce con BD (este documento).
- [x] Migración 0049 (media_backfill + summary de lote + plantillas/ejes/categorías
      de familias como datos + «Por clasificar» en color_family). pgTAP 0049 en verde.
- [x] Módulos `src/lib/admin/catalog-bulk-import/` (tipos, léxicos, mapa de familias,
      normalización pura, conciliación de medios, servicio de lote) + parser crudo
      `parseCatalogXlsxRaw` dentro del módulo XLSX existente.
- [x] Rutas `api/admin/importaciones/bulk/{preview,approve,commit,report,media-sync}`
      + pestaña «Carga masiva» en Importaciones (revisión de excepciones, aprobación
      masiva, confirmación IMPORTAR LOTE, reporte e historial). Verificada en
      escritorio y con emulación móvil (sin desborde; tablas con scroll propio).
- [x] Piloto local `npm run test:bulk-import-pilot` con FILAS REALES y los diez casos
      difíciles: 346 filas → 152 productos, 343 variantes, 18 duplicados evitados,
      2 conciliaciones exact, 23 swatches de respaldo; segundo pase con CERO
      duplicados; tercera pasada adopta la imagen que llega tarde y el trigger
      limpia `media_backfill`. Las 2 filas `merge` quedan fuera hasta decisión humana.
- [ ] Lotes completos en entorno de prueba (staging sigue bloqueado por credenciales,
      ver `docs/staging-produccion.md` §0–§2) → reporte → carga definitiva.

## 8. Runbook: plan de lotes para las 1,500 filas

El piloto ya validó el pipeline; los lotes de producción se arman por familias
compatibles (~100–250 filas) desde la pestaña «Carga masiva». Plan propuesto:

| Lote | Familias | Filas |
|------|----------|------:|
| `unas-esmaltes-01` | Esmaltes tradicionales y gel · Bases, tops | 238 |
| `unas-sistemas-01` | Sistema acrílico · Polygel · Soft gel · Preparadores · Remoción | 161 |
| `unas-decoracion-01` | Decoración y nail art · Press on · Tips/dual system | 209 |
| `unas-herramientas-01` | Herramientas manicure · Limas · Pinceles | 151 |
| `unas-equipos-01` | Drills · Lámparas UV/LED · Brocas · Cutícula · Moldes · Recipientes | 129 |
| `cejas-pestanas-01` | Las 7 familias de cejas y pestañas | 170 |
| `cabello-barberia-01` | Las 8 familias de cabello y barbería | 196 |
| `rostro-cuerpo-01` | Las 5 familias de rostro, cuerpo y maquillaje | 134 |
| `transversales-01` | Depilación (4) · Higiene (5) · Organización (3) | 106 |
| — revisión manual | «Pendiente de clasificación» (filas 474–479) | 6 |

Por lote: preview → excepciones → aprobar → IMPORTAR LOTE → reporte. Cuando llegue
un ZIP de imágenes (flujo existente de medios), «Conciliar imágenes» sobre los lotes
committed adopta exact/high y deja `review` para decisión humana. Todo es
re-ejecutable sin duplicar.

## 9. Criterio de terminado del bloque

1. leer XLSX + ZIP ✔ (parser crudo con las defensas del curado; ZIP existente)
2. normalizar ✔ · 3. producto vs variante ✔ · 4. duplicados ✔ (escalera de identidad,
   `S/C` como nulo, merge nunca automático) · 5. asociar imágenes ✔ (5 mecanismos con
   confianza registrada) · 6. fallback de color ✔ (solo con tono conocido; hex en el
   léxico o en `attribute_options.metadata`) · 7. solo excepciones ✔ · 8. aprobar
   lote ✔ · 9. importar coherente ✔ (mismo camino del panel) · 10. repetir sin
   duplicar ✔ (verificado con dos pases sobre datos reales).

Pendientes conscientes: los pesos/contenidos por variante viajan en el nombre y la
clave de la variante (no hay atributo tipado por-variante de contenido); las
imágenes `review` se aprueban subiendo el archivo con la convención o desde el
detalle del producto (no hay aún botón de adopción individual); staging/producción
esperan credenciales (R-12 y provisión siguen del lado humano).
