# Certificación del catálogo real Bellaroshé — local (Fase 1C)

**Fecha de certificación:** 2026-08-09
**Objeto auditado:** base local congelada al inicio del bloque (snapshot
`backups/certificacion-1c/pre-certificacion-1c.dump`, 2026-08-08).
**Auditor re-ejecutable:** `npm run audit:catalog-real` → evidencia en
`docs/evidencia-certificacion-1c/` (conciliación CSV de 1,500 filas,
`auditoria.json`, `auditoria.md`).

Toda corrección de este bloque regresó por el mecanismo de importación/revisión
(staging + resoluciones con motivo); ninguna por SQL sin trazabilidad. Los dos
ajustes directos quedan citados con su evidencia: re-publicación de
`MAS-ESM-4C95F3` tras validar el trigger de completitud, y corrección de dos
erratas de grafía contra la carta oficial (§Esmaltes).

---

## 1. Fuentes

| Fuente | Fecha | Uso |
|--------|-------|-----|
| `Listado_organizado_productos_Bellaroshe.xlsx` (1,500 filas) | 2026-08-06 | Fuente primaria de la carga |
| Plantilla curada oficial Masglo Tradicional (`plantilla_masglo_tradicional_lista_para_importar.xlsx`, 157 tonos TRA-XXX con SKU, familia y hex) | 2026-07-22 | FUENTE_OFICIAL_ACTUAL de Masglo Tradicional 13,5 ml |
| Paquete de 157 swatches reales (`masglo_tradicional_media_envases_reales`) | 2026-07-22 | Medios oficiales por tono |
| Catálogo V1 (`scripts/catalog-data.mjs`, 11 productos) | 2026-07-13 | FUENTE_OFICIAL_HISTORICA (presentaciones y contenidos: Masglo 13,5 ml, Admiss 10 ml, Gel Polish 7/14 ml) |

## 2. Conciliación 1,500 → destino definitivo

**Ecuación cerrada y estable ante re-ejecuciones:**

| Filas | IMPORTED | MERGED_CONFIRMED | DUPLICATE_CONFIRMED | EXCLUDED_CONFIRMED | PENDING |
|------:|---------:|-----------------:|--------------------:|-------------------:|--------:|
| 1,500 | **1,492** | 0 | **3** | **5** | **0** |

- Duplicados confirmados: fila 1291 (BELLESPA re-registro exacto) y filas
  1489/1491 (soft gel ALMOND/STILETTO re-escritos con otras palabras, mismo
  código de proveedor).
- Excluidas explícitas (motivo reincorporable en el expediente): filas 474
  (FIGARO ROSADO), 475 (PCI), 477 (sin descripción), 478 (JUMBO), 479 (BLEDO
  UNICORNIO).
- La tabla completa (una fila por fila original, con product_id, variant_id,
  SKU, oferta, decisión, issue y motivo) es
  `docs/evidencia-certificacion-1c/conciliacion-1500.csv`.

## 3. Decisiones humanas (las 67)

Expediente completo: `decisiones-67.json` + registro de aplicación
`decisiones-67-aplicadas.json`. Resumen por grupo:

- **D1 (40) mismo proveedor, códigos distintos → importadas como artículos
  distintos** con su referencia visible («Ref. LC2545»…): un código diferente
  no desaparece por compartir descripción. Los seis «ESMALTE GEL CAT EYE» de
  CHARM LIMIT, las cuatro planchas ROZIAPRO HR-xxx, los repujadores GN&HM,
  REVEL SH-236A/B, etc.
- **D2 (18) código de proveedor repetido**: 16 eran reutilización de código del
  proveedor para variantes reales (colores de sets AJI, granos de limas,
  aromas CHOVEMOAR, tallas dual system) → importadas como artículos propios con
  el código registrado solo en la primera oferta; 2 eran el mismo artículo
  re-escrito → duplicado confirmado.
- **D3 (3) conflicto de código interno → resueltos individualmente**: WEL003,
  YEM003 y OTR117 son unidades vendibles distintas (el código interno es el
  ancla); importadas con su código como identidad. **0 conflictos restantes.**
- **D4 (6) pendientes de clasificación**: PEGAMENTO GOLLE reclasificado a
  adhesivos de uñas e importado; las otras 5 excluidas explícitamente con
  motivo (no quedan bajo «pendiente»).

## 4. Resultado en BD (catálogo ≠ stock)

| Entidad | Total |
|---------|------:|
| Productos | 1,056 |
| Variantes | 1,578 |
| Ofertas de proveedor | 1,487 |
| Marcas | 185 |
| Proveedores | 68 |
| Tonos (color_shades) | 253 |

Regla I respetada: **ningún inventario ficticio**. Todo lo importado queda
`availability=consult` y sin precios inventados; existencia en catálogo y
disponibilidad física son conceptos separados (el POS ya muestra «Consultar»).

**Checks globales E: todos en cero** (producto activo sin variante, default ≠ 1,
SKU duplicado, código interno en dos variantes, oferta duplicada, supplier_sku
duplicado, huérfanas, template/categoría incompatible, trazabilidad
import→destino y destino→fila). Los 2 productos DEMO pre-importación quedan
reportados fuera del alcance. Cola de anomalías (2, explicadas, para la dueña):
marcas REVE'L/REVEL a unificar; productos pastillero LIN-DEC-F87EC1/FA087F
fusionables.

## 5. Esmaltes (F/G/J/K)

### Masglo Tradicional 13,5 ml — COMPLETA (157/157)

Reconciliación 74 vs 157 vs 155 (`masglo-reconciliacion.json`):

- **La fuente vigente es la plantilla curada oficial (157)**: 157 tonos TRA-XXX
  con SKU oficial numérico, familia cromática y hex al 100 %.
- **155 vs 157**: las dos referencias adicionales corresponden a las
  ampliaciones que la propia ficha documenta (partículas, fotocromáticos y
  decoración: DEC-*/FOT-*) incorporadas tras la investigación inicial.
- **74 vs 157**: el Excel de 1,500 solo traía 67 coincidentes (con las erratas
  TRASCEDENTAL→Trascendental y SUCEPTIBLE→Susceptible, corregidas contra la
  carta) + 7 tonos que la carta oficial ya no lista (Inclusiva, Ajena, Audaz,
  Inconfundible, Escarcha Dorado/Plateado, Granizado Dorado): **se conservan**
  como extras documentados — nada se borra por una fuente distinta.
- **Carga**: los 90 faltantes entraron por lote de staging trazable
  (`masglo-completar-01`, fila a fila desde la plantilla), las 67 shades
  existentes subieron a datos oficiales, y los swatches con prefijo dec-/fot-
  se enlazaron por su `media_path` oficial.

**Estado final: 164 variantes = 157 oficiales (100 % con SKU, shade, familia,
hex y swatch real) + 7 extras del Excel (deuda de medio explícita).** El
producto está publicado y el trigger de completitud del dominio lo validó.
Verificado en UI pública y en POS: «abrumadora» → SKU 312142 · #2C352A;
búsqueda por SKU oficial directa; fotocromático «polifacetica» → MAS081.

### Gel Evolution y Gel Polish — separadas, no cargadas

El Excel de 1,500 contiene **0 filas** de Gel Evolution o Gel Polish (única
mención: «BRILLO GEL TAPA NEGRA», que es un brillo). Las líneas existen como
FUENTE_OFICIAL_HISTORICA (V1: Gel Evolution 13,5 ml; Gel Polish 7 ml y 14 ml
como presentaciones distintas) y quedan **NO_CARGADA** — fuera del alcance de
esta carga, sin copiar cartas entre presentaciones. La reconciliación futura
será por tono+SKU+presentación.

### Resto de marcas de esmaltes

| Marca / línea | Fuente | Tonos BD | Cobertura |
|---------------|--------|---------:|-----------|
| Masglo Tradicional 13,5 ml | FUENTE_OFICIAL_ACTUAL (2026-07-22) | 164 | **COMPLETA 157/157 + 7 extras** |
| Admiss 10 ml | FUENTE_PROVEEDOR (Excel 2026-08-06) | 75 | COBERTURA_NO_DETERMINABLE (sin carta oficial en poder) |
| Charm Limit (Cat Eye) | FUENTE_PROVEEDOR | 6 refs LC | COBERTURA_NO_DETERMINABLE |
| BEIFA / REVEL / VOGGUE / MC NAILS / MYSTYLE / CHERIMOYA (esmaltes sueltos) | FUENTE_PROVEEDOR | 1–4 c/u | COBERTURA_NO_DETERMINABLE |
| Candy Secret / Flower Secret / Glam Nails | FUENTE_OFICIAL_HISTORICA (V1) | — | SIN_CARTA_COMPLETA; sin filas de esmalte en el Excel |

No se fabricó ninguna carta completa donde nunca la hubo. La matriz completa de
las 75 líneas con conteos está en `auditoria.md` §Líneas de esmalte.

### Auditoría de tonos (K)

253 variantes con tono → **0 sin shade**, **0 shades duplicadas en su ámbito**,
**0 incoherencias marca/shade**, **0 hex sin fuente** (los hex vienen del
léxico de colores estándar o de la carta oficial; los tonos de fantasía sin
carta no tienen hex). Familia «Por clasificar»: 93 shades (Admiss y sueltos,
honesto — sin carta no se inventa familia). Medios de tonos: 150 con foto real,
8 con swatch de archivo, 95 pendientes.

## 6. Medios (deuda explícita y medible)

| Clase | Variantes |
|-------|----------:|
| Con foto o swatch real | 158 |
| Fallback de color (hex conocido) | 154 |
| Pendientes (`media_backfill=pending`) | 1,037 |

Productos con medio: 3 · productos pendientes: 1,050. **La falta de fotografía
permanece como deuda explícita; ninguna variante/tono que debía existir falta.**
El ZIP de medios + «Conciliar imágenes» la irán saldando (el trigger limpia la
deuda al llegar el medio real).

## 7. Idempotencia (N)

Segundo pase global de los **9 lotes contra la BD completa: CERO duplicados —
ninguna tabla cambió** (products, variants, ofertas, shades, media, opciones,
proveedores, marcas), repetido tras las resoluciones y tras Masglo. Las
decisiones humanas sobreviven a cualquier re-stage (peldaño 0b del staging) y
la ecuación se mantiene cerrada tras re-ejecutar.

## 8. Gate de cierre de Fase 1 (P)

- [x] 1,500/1,500 filas con destino definitivo.
- [x] 0 decisiones pendientes.
- [x] 0 conflictos de código interno.
- [x] 0 duplicados no explicados.
- [x] 0 variantes huérfanas.
- [x] 0 ofertas duplicadas.
- [x] Auditoría de las 51 familias completada (matriz L + cola de anomalías: 2, explicadas).
- [x] Todas las líneas de esmaltes inventariadas (75 líneas en `auditoria.md`).
- [x] Conteo esperado vs real por línea de esmalte (completa solo donde hay fuente).
- [x] MASGLO 74 vs 157/155 reconciliado documentalmente.
- [x] Todos los tonos que deban estar cargados (157/157 oficiales + extras conservados).
- [x] Ningún tono inventado (ni nombre ni hex sin fuente).
- [x] Presentaciones de gel correctamente separadas (7/14 ml no cargadas, no mezcladas).
- [x] Swatches/imágenes reconciliados (157 reales en Masglo; mecanismo probado).
- [x] Deuda de imágenes explícita y medible (§6).
- [x] Segundo pase global sin cambios inesperados.
- [x] `docs/certificacion-catalogo-local.md` terminado (este documento).
- [x] Snapshot final del catálogo local (`backups/certificacion-1c/post-certificacion-1c.dump`).
- [x] Commit de toda la evidencia y correcciones (serie `0f320c8…`).
- [ ] Push — bloqueado por permisos de la sesión; ejecutar:
      `git -c credential.https://github.com.username=ivnp4 push origin feature/bellaroshe-platform-v2`

**Fase 1 (datos) queda COMPLETA y certificada. Siguiente: Fase 2 —
Convergencia Frontend #1 (Nueva venta B1 definitivo).**
