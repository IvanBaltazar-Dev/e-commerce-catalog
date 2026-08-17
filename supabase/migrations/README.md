# Migraciones de base de datos

Este directorio es el historial real y acumulativo de Bellaroshé. El corte documental vigente llega a `0113`. Las migraciones aplicadas no se reescriben, renombran, consolidan ni eliminan; toda corrección nueva recibe el siguiente número y sus pruebas.

## Mapa del historial

| Rango | Responsabilidad principal |
| --- | --- |
| `0001`–`0004` | Catálogo V1, columnas y endurecimiento de lectura |
| `0005`–`0007` | Catálogo V2, contratos públicos y pedidos administrativos |
| `0008`–`0015` | Alta guiada, familias, líneas, tonos, atributos y coherencia |
| `0016`–`0022` | Rol developer, importación, PDF/medios y relaciones contextuales |
| `0023`–`0027` | Organización, sedes, seller, auditoría y proveedores/costos |
| `0028`–`0034` | Inventario, venta, compras, devoluciones, gastos, caja y lecturas |
| `0035`–`0042` | Canales, conversaciones, carrito público, atribución e integraciones |
| `0043`–`0046` | Inteligencia, asistencia, cierre de privilegios y rendimiento |
| `0047`–`0071` | POS, catálogo masivo, tonos, pagos, personas, entrega, documentos e inventario |
| `0072`–`0084` | Documento de búsqueda, facetas, proyecciones de lectura y contratos admin |
| `0085`–`0090` | Procedencia, conocimiento, grafo, privilegios y gate de publicación |
| `0091`–`0096` | Vertical de Sistema Acrílico, evidencia, brechas y colas de trabajo |
| `0097`–`0100` | Mesa de revisión, dependencias, contratos de aplicación y redirección de identidad |
| `0101`–`0106` | Memoria de investigación, Universo de Referencia, proyección Neo4j y resolución desde staging |
| `0107` | Reconciliación genérica marca + fuente, reporte agregado para MCP y capas explícitas de identidad en el grafo |
| `0108` | Reprocesamiento congelado e idempotente de la Mesa, clasificación operativa y proyección workflow |
| `0109` | Claims semánticos de referencias, vocabulario normalizado con estado/procedencia y proyección exclusiva en evidencia |
| `0110` | Agregación de problemas semánticos por causa compartida y barrera de escala humana antes de Mesa |
| `0111` | Contrato epistemológico universal, dimensiones extensibles, perfiles técnicos, reglas versionadas, autoridad fuente×predicado, contradicción, entailment, promoción y certificación |
| `0112` | Puente automático desde claims de fuente 0109 hacia observación literal + normalización explicable, con backfill fail-closed y sin canonización/Mesa |
| `0113` | Contrato universal sistema→etapa→rol→clase→requisito, referencias, secuencias, autoridad de procesos, fixture Acrílico, reporte y proyección v2.7.0 |

Los nombres de archivo son el detalle autoritativo. Este mapa evita duplicar una descripción extensa que pronto queda desactualizada.

## Hitos vigentes

- `0028_inventory_core.sql`: saldo por variante/sede, kardex, valoración y disponibilidad efectiva.
- `0029_sales_core.sql`: venta, reserva, pagos, snapshots y concurrencia.
- `0027_supplier_domain.sql` y `0030_purchasing_core.sql`: ofertas, costos, órdenes y recepciones.
- `0045_close_default_privileges.sql`: cierre de privilegios por defecto.
- `0072_search_document.sql`–`0084_brand_exact_short_term.sql`: búsqueda normalizada y proyecciones escalables.
- `0074_catalog_enrichment_pipeline.sql`: fuentes, snapshots, registros externos, casos y excepciones.
- `0085_catalog_facts_provenance.sql`: observaciones y procedencia aprobada por valor.
- `0086_catalog_knowledge_model.sql`–`0090_catalog_publication_knowledge_gate.sql`: conocimiento, grafo de solo lectura y publicación segura.
- `0091_acrylic_knowledge_vertical.sql`–`0096_acrylic_reconciliation_work_queues.sql`: primer vertical de conocimiento y captura pendiente.
- `0097_catalog_review_workflow.sql`–`0100_catalog_review_identity_redirect.sql`: trabajo humano versionado, dependencias, aplicación y corrección de identidad.
- `0101_research_memory_reference_universe.sql`–`0106_import_reference_resolution.sql`: corridas/deltas, identidad externa tipada, observaciones y precios externos, contratos de proyección, matching indexado y reutilización desde el staging existente.
- `0107_stage2_brand_research_mcp_contracts.sql`: claves materiales de reconciliación, candidatos/contradicciones para Mesa, reporte ADMISS reutilizable y proyección de señales de identidad separadas.
- `0108_catalog_review_reprocessing.sql`: preview/apply exacto, historia inmutable, clases de trabajo y grafo de Mesa.
- `0109_reference_semantic_claims.sql`: claims observados, vocabulario no canónico, cobertura semántica y `SemanticTerm`/`NORMALIZES_TO` en capa de evidencia.
- `0110_semantic_problem_aggregation.sql`: detecciones individuales fuera de Mesa, grupos por regla/causa, particiones justificadas, excepción humana de regla y reporte de escala.
- `0111_universal_semantic_checkpoint.sql`: contrato epistemológico, registros universales dirigidos por datos y certificación sintética sin autorización de Etapa 4.
- `0112_universal_semantic_ingestion_bridge.sql`: materialización automática de evidencia 0109 como literal + normalizada, sin inferencia, canonización ni Mesa.
- `0113_universal_system_class_model.sql`: amplía el modelo 0086 sin tablas paralelas, valida estados epistemológicos y conserva intactas las 323 relaciones diferidas.

## Aplicación local

Desde la raíz:

```bash
npx supabase start
npm run db:reset:local
npm run test:db
npm run audit:security
```

Un `db reset` debe reconstruir únicamente desde migraciones y seeds. Ninguna migración puede depender de una fila creada después por un seed.

## Convenciones

- `0001`, `0002` y `0004` preservan el origen V1 y son inmutables.
- Los cambios de enum que PostgreSQL no permite usar en la misma transacción permanecen aislados.
- Toda tabla nueva habilita RLS y define de forma explícita sus privilegios.
- Funciones `SECURITY DEFINER` fijan `search_path`, tienen grants mínimos y cuentan con prueba de alcance.
- Libros de solo adición no se mutan directa ni indirectamente.
- Migración, pgTAP, contrato de aplicación y documento canónico se actualizan juntos.
- Staging y producción siguen el runbook de [Operación](../../docs/operacion.md); local es el único destino por defecto.

## Documentación relacionada

- [Arquitectura](../../docs/arquitectura.md)
- [Catálogo](../../docs/catalogo.md)
- [Importación](../../docs/importacion-catalogo.md)
- [Calidad y riesgos](../../docs/calidad-y-riesgos.md)
