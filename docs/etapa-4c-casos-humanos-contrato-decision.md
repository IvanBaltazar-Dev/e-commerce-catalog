# Etapa 4C · Casos humanos y contrato de decisión

**Corte certificado:** 2026-08-17

**Migración:** `0115_human_decision_read_model.sql`

**Estado:** cerrada; detenerse antes de producto/UX y frontend

**Contrato:** `stage4c-v1`

## Objetivo y frontera

Etapa 4C convierte el preview universal de 4B en decisiones humanas agrupadas por causa compartida. El backend entrega una explicación lista para consumo; React no interpreta `rule_code`, no reconstruye reglas y no decide qué acción corresponde.

Este corte es exclusivamente de lectura y preparación:

- no aplica decisiones;
- no aprueba, rechaza ni promueve las 323 candidatas de origen;
- no crea trabajo humano por candidata;
- no convierte inferencias en hechos canónicos;
- no crea ni publica productos;
- no fija precio Bellaroshé ni modifica inventario;
- no inicia investigación masiva, GraphRAG ni producción;
- conserva `stage4Authorized=false` en el contrato.

## Entrada real

La entrada es el último preview 4B completo: 323 relaciones históricas, 99 `CLASS_MEMBERSHIP`, 68 `CLASS_RELATION`, 60 `NEEDS_EVIDENCE` y 96 `REJECTED`. Las 60 necesidades de evidencia continúan como deuda automática y quedan fuera de la cola humana: incertidumbre aislada no justifica una decisión manual.

El corte certificado usó:

| Elemento | Huella |
| --- | --- |
| Snapshot 4B | `6947c31eb087efbbf0c3532064098a66329c58ff2faffd5939ae86d5d97174ca` |
| Preview 4B | `f23a5c4668bc0854054f412e663b9c390c94e0fb737b50db1ee729306514475f` |
| Contrato agrupado 4C | `b57afd01bff2aaba3973300a5fc480c6f968a5e56dbed2932c90cf4494cd2917` |

Las huellas incluyen las identidades del checkpoint local. Una restauración nueva puede cambiar UUID y huellas aunque conserve la misma clasificación semántica; el gate vuelve a congelarlas y verifica los conteos e invariantes.

## Familias reales de decisión

| Familia | Decisiones | Detecciones | Criterio humano |
| --- | ---: | ---: | --- |
| `CLASS_RULE_PROMOTION` | 9 | 68 | Confirmar si muchos pares deben representarse por una regla compartida entre clases |
| `ENDPOINT_SCOPE_RECLASSIFICATION` | 5 | 99 | Confirmar membresías útiles y corregir el alcance del extremo sin afirmar pares |
| `FALSE_PAIR_RETIREMENT` | 4 | 96 | Retirar falsos pares del conjunto promovible sin borrar historia |
| **Total** | **18** | **263** | Una decisión por causa compartida |

Agrupar 263 detecciones en 18 decisiones evita el 93,16 % de la revisión individual. Los productos pueden aparecer en más de una decisión; el reporte contabiliza 207 productos afectados a través de decisiones, no 207 identidades únicas globales.

Casos representativos del conjunto real:

- 19 relaciones `gel_color → gel_top` forman una sola decisión de regla entre clases;
- 38 relaciones `drill → drill_bit` con alcance de extremo incorrecto forman una sola decisión de reclasificación;
- 88 falsos pares relacionados con `lamp_uv_led`, incluidos guantes o lámparas de escritorio interpretados como equipos de curado, forman una sola decisión de retiro.

## Contrato de lectura

`catalog_relation_decision_groups_v1` agrupa por familia y causa. `catalog_decision_read_model_v1` entrega cada decisión con:

- `decision_id`, `title` y `business_summary`;
- `what_was_found`, `why_human_is_needed` y `system_recommendation`;
- `affected_count`, `affected_product_count` y `affected_entity_types`;
- `evidence_summary` con huellas, autoridad, requisitos, reglas, relaciones y ejemplo;
- `impact_preview`, `available_actions`, `rule_code`, `rule_codes` y `fingerprint`;
- estado del preview y guardas explícitas de no aplicación, no canonización y cero efecto comercial.

`rule_code` solo es un atajo cuando el grupo contiene una regla; `rule_codes` conserva el conjunto completo. La UI debe renderizar la explicación y las acciones entregadas por el backend, no inferir comportamiento desde ninguno de esos campos.

Las funciones paginadas `get_catalog_decision_queue_v1(limit, offset)` y `get_catalog_stage4c_report_v1()` son `security invoker`, están revocadas para `public` y `anon`, y se conceden únicamente a `authenticated` y `service_role`. MCP expone `stage4c_decision_queue` y `stage4c_decision_report` como herramientas de solo lectura.

## Certificación

La reconstrucción completa `0001`–`0115` restauró 1.056 productos y 1.578 variantes y pasó 52 archivos con 1.246 comprobaciones pgTAP. También pasaron:

- `npm run gate:stage4b` y `npm run gate:stage4c`;
- `npm run test:mcp:stage4b` y `npm run test:mcp:stage4c`;
- typecheck, lint de aplicación y auditoría de seguridad;
- Graph Projector `v2.7.0`: 5.290 nodos, 7.545 aristas, cero diferencias y huella común `de38e7c66647c62c4ce83447e41937611968a02446f7f70a59dee4c45607169f`.

El linter de base conserva un único error preexistente en `issue_purchase_order`: referencia `supplier_cost_agreement_id` en una tabla de tiers que no expone esa columna. No pertenece a `0114` ni `0115` y no altera el resultado de estos gates.

## Punto de detención

4C deja datos reales suficientes para diseñar la experiencia humana, pero no implementa esa experiencia. El siguiente paso requiere una decisión explícita de producto/UX sobre jerarquía, lenguaje, comparación de evidencia, confirmaciones y tratamiento de acciones. Hasta entonces no se crea frontend ni se habilita aplicación de decisiones.
