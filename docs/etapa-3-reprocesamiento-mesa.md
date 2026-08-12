# Etapa 3 · Reprocesamiento de Catálogo

Estado: cerrada el 2026-08-12. Etapa 4 no iniciada.

## Resultado

La Mesa ahora concentra excepciones humanas reales sin resolver las 113 entradas ADMISS una por una. El motor es genérico: toma una fotografía, persiste un preview inmutable y solo permite aplicar exactamente su fingerprint. Reutiliza `catalog_review_work_items`, eventos, versiones, dependencias, `work_key` e idempotencia; no crea una segunda cola.

PostgreSQL conserva toda autoridad. Neo4j recibe después el estado mediante Graph Projector y MCP continúa de solo lectura.

## Fotografía antes/después

| Métrica | Antes | Después |
| --- | ---: | ---: |
| Trabajo total | 1.679 | 1.679 |
| Trabajo activo | 1.629 | 1.447 |
| Excepción humana accionable | 623 | 387 |
| Porcentaje humano del activo | 38,24 % | 26,74 % |
| Deuda automática | 0 | 436 |
| Captura física | 527 | 527 |
| Espera externa | 296 | 66 |
| Bloqueado | 183 | 31 |
| Completado | 49 | 231 |
| Superseded | 1 | 1 |
| Desbloqueado por el apply | 0 | 94 |
| Nuevo por evidencia real | 0 | 0 |
| Contradicción histórica real nueva | 0 | 0 |

El trabajo humano bajó 236 casos (37,9 %) y 11,50 puntos porcentuales sobre el trabajo activo. No se redujo ocultando captura física: sus 527 casos conservan su clase.

## Preview aplicado

- Preview: `52b0ae6d-60e5-4b51-8e09-23bacd9b416b`.
- Snapshot inicial: `6aa0c10e86830a28980615a0273282c0e94ca39ca36b621242c4e155c7c79495`.
- Fingerprint exacto del preview: `51fe0a32c2802d52045792dfbf40f1641206bded9768536781a03ad72c0ef65e`.
- Resultado lógico: `b46f4cd63a653adcbff6a025001990ac64d4d853724879783d725046d9ea217e`.
- Acciones: 1.011 sin cambio, 182 cierres objetivos, 436 reclasificaciones, 50 auditorías de terminados, 618 cambios/eventos y 94 desbloqueos.

La huella congelada impide aplicar otro conjunto de acciones. Si la Mesa o su evidencia cambian, el preview expira y debe generarse otro.

## Reglas ejecutadas

| Regla | Casos | Justificación |
| --- | ---: | --- |
| `objective_tone_identity` | 161 | tono oficial exacto, normalizado y no ambiguo |
| `objective_product_identity` | 21 | producto oficial inequívoco con regla objetiva aprobada |
| `external_candidate_signal` | 112 | señal externa ADMISS no contradictoria; se conserva como deuda automática, no como decisión humana |
| `relation_deferred_stage4` | 324 | 323 relaciones históricas más un fixture de Etapa 1; no se reconciliaron ni aprobaron en bloque |
| `audit_completed` / `unchanged` | 50 | decisiones terminadas auditadas sin editar historia |

No existe una regla particular para ADMISS, ZAC o AJO Y LIMÓN. Tampoco se autoaprobaron afirmaciones comerciales, compatibilidades, precios, stock, medios ni publicación.

ADMISS queda así:

- 112 candidatas no contradictorias como `automatic_debt`.
- Una contradicción de clasificación AJO Y LIMÓN como excepción humana.
- ZAC permanece como referencia/candidata, sin alta ni modificación comercial.
- 121 productos, 121 variantes, 121 precios externos y 197 imágenes remotas conservados en el Universo de Referencia.

## Invariantes y fixtures

Las 33 pruebas de `0108_catalog_review_reprocessing.test.sql` demuestran:

- captura física resuelta solo por evidencia oficial aprobada;
- espera externa satisfecha por evidencia persistida;
- caso bloqueado que avanza al cumplirse su dependencia;
- decisión terminada byte por byte inmutable ante evidencia contradictoria;
- nuevo trabajo/evento enlazado para esa contradicción;
- imagen faltante normal como deuda automática;
- rechazo de fingerprint incorrecto y aplicación idempotente.

En datos reales no apareció una contradicción histórica nueva; el comportamiento se probó de forma controlada sin fabricar una en producción local.

La recarga idéntica conservó 1.679 trabajos, 2.234 eventos y 183 dependencias. El segundo reproceso produjo cero cambios, eventos, trabajo, desbloqueos y cambios comerciales, con el mismo fingerprint lógico.

## Neo4j y MCP

La secuencia ejecutada fue PostgreSQL → estado aplicado → `graph:sync` → `graph:verify`.

- Graph Projector `v2.3.0`.
- 7.630 nodos y 11.423 relaciones.
- Fingerprint común: `9b542ae3e1bd4db7fa53506778d9513aee4bce447a4f18069ac97b20f27d9b92`.
- Cero faltantes, duplicados, huérfanos, referencias inválidas, versiones antiguas o elementos inesperados.
- Nueva capa `workflow` para trabajo y dependencias; Neo4j no decide transiciones.
- MCP con diez herramientas de lectura, incluida `review_reprocess_status`; `review_cases` devuelve por defecto solo `human_exception`.

## Gates

- Reconstrucción desde base vacía: migraciones `0001`–`0108`, checkpoint, seeds y fixtures.
- 45 archivos y 968 pruebas pgTAP.
- Graph Projector rebuild/sync/verify.
- Integrales B1, B2, B3 y B4.
- Concurrencia de inventario, ventas/caja y omnicanal.
- `test:catalog-review-rerun`, `test:review-reprocess`, `gate:enriquecimiento`, aceptación ADMISS y MCP fresco.
- Auditoría estructural sin violaciones; `npm audit` con cero vulnerabilidades.
- Typecheck, lint y build de producción en verde.
- Gate total definitivo: 470,5 s; evidencia local `test-results/gate-rebuild-18.md`.

## Riesgos que permanecen

- Las 324 relaciones diferidas pertenecen principalmente a Etapa 4 y no son hechos aprobados.
- Los 527 casos de captura física siguen requiriendo evidencia propia u oficial suficiente; no deben cerrarse por similitud.
- Las reglas automáticas deben mantenerse versionadas y medidas; cualquier ampliación exige preview, fixtures e invariantes comerciales.
- El CLI del Graph Projector aún usa el transformador TypeScript experimental de Node.
- Antes de volumen masivo continúa vigente el riesgo medido de almacenamiento en Supabase Free y la necesidad de retención/archivo.

No se inició expansión masiva de marcas, sistemas, procesos, clases o relaciones.
