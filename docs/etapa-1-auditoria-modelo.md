# Etapa 1 · Auditoría específica del modelo a extender

**Corte:** 2026-08-12

Esta revisión se limita a investigación, evidencia, reconciliación, conocimiento y proyección. No reabre la auditoría general de la plataforma.

## Decisiones de reutilización

| Pieza existente | Decisión | Motivo |
| --- | --- | --- |
| `catalog_sources` | reutilizar | ya expresa autoridad, adaptador, marca y URL estable |
| `catalog_source_snapshots` | reutilizar | conserva captura, hash, estado, RAW administrado y métricas |
| `catalog_source_records` | reutilizar | es la evidencia normalizada de cada entidad observada |
| `catalog_observations` | extender | ya es inmutable y trazable, pero solo admite producto/variante internos y atributos definidos |
| `catalog_attribute_provenance` | extender | su resolución soporta y contradice observaciones; necesita sujetos externos explícitos |
| `catalog_evidence_sets/items` | reutilizar | agrupa evidencia reutilizable con posturas `supports` y `contradicts` |
| `catalog_reconciliation_cases` | extender | evita una segunda Mesa; incorporará referencia externa tipada junto al candidato interno |
| sistemas, etapas, roles y clases | reutilizar | son conocimiento canónico con evidencia y estados de decisión |
| `product_relations` y candidatas | reutilizar | ya separa hechos aprobados de hipótesis |
| `products` / `product_variants` | no extender para descubrimiento | continúan representando exclusivamente catálogo comercial Bellaroshé |
| vistas `graph_*_v1` | conservar y versionar | ya definen un contrato de lectura, pero falta identidad externa, evidencia y un runtime Neo4j |

## Cambios mínimos elegidos

1. Crear corridas de investigación y alcances marca/fuente con claves idempotentes, ejecución previa, fingerprints, métricas y errores.
2. Crear `catalog_reference_products` y `catalog_reference_variants`; ninguna de ellas tiene FK obligatoria hacia el catálogo comercial.
3. Crear identificadores externos tipados, eventos de presencia/delta y medios remotos por referencia.
4. Extender observaciones y procedencia con cuatro FKs de sujeto explícitas: producto/variante comercial o producto/variante de referencia. No se usa una columna `subject_id` polimórfica sin integridad.
5. Extender la reconciliación existente con FKs de referencia; no se crea otro flujo ni otra Mesa.
6. Separar precios externos históricos de `variant_prices`.
7. Crear el contrato de proyección v2 y un único Graph Projector. PostgreSQL permanece como autoridad.

## Decisiones de escala

- La identidad primaria se resuelve por claves de fuente, códigos normalizados, fingerprints e índices B-tree/trigram; la similitud solo opera sobre candidatos acotados.
- Las tablas de eventos y observaciones se indexan por corrida, fuente, sujeto y fecha.
- Los contratos de lectura son paginados. El projector procesa lotes y no carga el universo completo en una sola respuesta RPC.
- `REFERENCE_LIGHT` evita descargar o duplicar medios pesados. `REFERENCE_ENRICHED` se reserva para referencias justificadas.
- El gate debe medir catálogo y universo de referencia como volúmenes independientes. Los 1.056 productos actuales no se usan como supuesto de diseño.

## Fronteras preservadas

- Investigar nunca crea `products`, `product_variants`, `variant_prices`, inventario ni publicación.
- Una observación no materializa un hecho canónico.
- Una ausencia no elimina identidad ni historia.
- Neo4j no acepta escrituras libres y puede borrarse por completo sin pérdida de verdad.
- ADMISS, MCP de escritura, reproceso de Mesa, crawler global y carga masiva quedan fuera de Etapa 1.
