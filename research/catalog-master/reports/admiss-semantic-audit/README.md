# Auditoria de Cobertura Taxonomica y Semantica ADMISS

Generada: 2026-08-12T19:58:58.416Z

Etapa 4 permanece detenida. Alcance: **121 productos oficiales**, **1,134 observaciones basales** y **1,587 claims semanticos activos**.

## Contrato epistemico

La memoria conserva que **la fuente oficial declara X**. Los terminos normalizados viven en capa `evidence`, llevan procedencia y estado, y no son hechos tecnicos universales ni hechos comerciales canonicos.

## Auditoria de las 1.134 observaciones existentes

| Predicado | Clase | Observaciones | Productos | Variantes |
| --- | --- | --- | --- | --- |
| official.finish | type | 96 | 96 | 0 |
| official.line | type | 120 | 120 | 0 |
| official.presentation | presentation | 238 | 119 | 119 |
| official.primary_image | remote_image | 121 | 121 | 0 |
| official.product_type | type | 121 | 121 | 0 |
| official.shade | shade | 196 | 98 | 98 |
| official.sku | code | 121 | 0 | 121 |
| official.title | identity | 121 | 121 | 0 |

Solo contenian ocho predicados: identidad, SKU, tipo, linea, presentacion, tono, acabado e imagen. Concern, beneficio, ingrediente, uso, rol, etapa, sistema, formulacion y relaciones no estaban estructurados.

## Cobertura basica

| Dimension | Productos | Total | Cobertura |
| --- | --- | --- | --- |
| identity | 121 | 121 | 100% |
| sku | 121 | 121 | 100% |
| type | 121 | 121 | 100% |
| price | 121 | 121 | 100% |
| image | 121 | 121 | 100% |

## Cobertura semantica

| Dimension | Productos | Cobertura | Claims | Terminos |
| --- | --- | --- | --- | --- |
| type | 121 | 100% | 121 | 5 |
| subtype | 121 | 100% | 129 | 8 |
| concern | 7 | 5.79% | 7 | 3 |
| benefit | 118 | 97.52% | 239 | 11 |
| ingredient | 3 | 2.48% | 5 | 5 |
| use | 17 | 14.05% | 17 | 6 |
| role | 121 | 100% | 121 | 8 |
| stage | 121 | 100% | 121 | 6 |
| system | 121 | 100% | 242 | 4 |
| formulation | 120 | 99.17% | 122 | 4 |
| finish | 109 | 90.08% | 142 | 9 |
| relation | 120 | 99.17% | 321 | 33 |

La cobertura baja de concern o ingrediente significa que la fuente solo lo declara para algunos productos; no debe rellenarse por inferencia.

## Consultas demostradas desde memoria propia

| Consulta | Productos |
| --- | --- |
| Productos para unas fragiles | 4 |
| Productos para unas debiles/maltratadas | 2 |
| Productos que declaran fortalecimiento | 5 |
| Productos con Biotina/Urea | 1 |
| Productos con extracto de ajo/limon | 1 |
| Productos que pueden funcionar como base | 6 |
| Productos relacionados con el sistema ADMISS | 121 |
| Coleccion comercial que no coincide con tipo real | 6 |

## Gaps reales y disposicion

| Gap | Cantidad | Disposicion |
| --- | --- | --- |
| Claims funcionales no revisados tecnicamente | 385 | Se conservan como source_claim; revision humana/tecnica solo si se pretende canonizar. |
| Productos sin pertenencia a coleccion oficial capturada | 1 | Gap real de superficie comercial; no inferir coleccion. |
| Productos sin formulacion declarada | 1 | Ausencia en fuente, no completar por similitud. |
| Productos sin acabado declarado/normalizable | 12 | Esperable en liquidos/herramientas; revisar solo si el tipo requiere acabado. |
| Contradicciones coleccion comercial versus tipo oficial | 6 | Conservar como contradiccion de fuente; no reclasificar automaticamente ni abrir Mesa. |

## Idempotencia e impacto

- Dos corridas exitosas consecutivas comparten fingerprint material: **true**.
- Reutilizaron el mismo snapshot material: **true**.
- Claims activos: **1587**; duplicados materiales: **0**; superseded en ambas: **0, 0**.
- Mesa creada por la auditoria: **0**. El guard comercial persistido confirma productos, variantes, precios, stock y media sin cambios.
- Neo4j recibe 102 terminos y 1587 aristas `NORMALIZES_TO`, siempre en capa evidence.

- Graph Projector v2.4.0: **9562 nodos**, **18256 aristas**, fingerprints PostgreSQL/Neo4j iguales y **0 divergencias**.

## Archivos

La matriz completa de 121 filas esta en `admiss-121-semantic-matrix.csv`; el detalle reproducible de consultas, excerpts, fingerprints y matriz esta en `admiss-semantic-audit.json`.
