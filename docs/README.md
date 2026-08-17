# Documentación canónica de Bellaroshé

Este índice es la puerta de entrada a la documentación vigente. La auditoría del 12 de agosto de 2026 redujo 44 archivos Markdown dispersos a un conjunto pequeño de documentos con dueño y propósito explícitos.

## Qué leer

| Documento | Para qué sirve | Se actualiza cuando |
| --- | --- | --- |
| [Arquitectura](arquitectura.md) | Límites del sistema, fuentes de verdad e invariantes | cambia el modelo o una frontera técnica |
| [Catálogo](catalogo.md) | Modelo comercial, evidencia, revisión y conocimiento | cambia el flujo de catálogo o reconciliación |
| [Importación](importacion-catalogo.md) | Contrato XLSX/ZIP, carga masiva e idempotencia | cambia el formato o el proceso de ingesta |
| [Operación](operacion.md) | Instalación, pruebas, roles, despliegue y recuperación | cambia un comando o un procedimiento |
| [Frontend](frontend.md) | Decisiones visuales y de interacción aprobadas | cambia una decisión de experiencia |
| [Calidad y riesgos](calidad-y-riesgos.md) | Requisitos transversales, gates y riesgos activos | se abre, mitiga o cierra un riesgo |
| [Plan vivo del MCP](plan-vivo-mcp-inteligencia-catalogo.md) | Plan de construcción y checklist progresivo | termina una sección del MCP |
| [Etapa 3 · Reprocesamiento de la Mesa](etapa-3-reprocesamiento-mesa.md) | Evidencia, métricas y cierre reproducible de Etapa 3 | cambia el motor o se reabre la etapa |
| [Guarda previa a Etapa 4 · Escala humana semántica](etapa-4-guarda-escala-humana-semantica.md) | Agrupación por regla, barrera de Mesa y curva sublineal de excepciones | cambia la escalación semántica o su gate |
| [Checkpoint Semántico Universal](checkpoint-semantico-universal.md) | Epistemología, modelo dirigido por datos, contradicciones, entailment y certificación | cambia el contrato semántico universal |
| [Etapa 4A · Modelo universal de sistemas y clases](etapa-4a-modelo-universal-sistemas-clases.md) | Sistema→etapa→rol→clase→requisito, fixture Acrílico, reporte y gate | cambia el contrato 4A o se inicia el reprocesamiento histórico |
| [Auditoría específica de Etapa 1](etapa-1-auditoria-modelo.md) | Reutilización y cambios mínimos del modelo de conocimiento | cambia la frontera referencia/catálogo |
| [Migraciones](../supabase/migrations/README.md) | Historial técnico del esquema | se agrega una migración |
| [Investigación de catálogo](../research/catalog-master/README.md) | Pipeline, evidencia externa y trabajo manual | cambia el pipeline o su corte medido |

## Resultado de la auditoría documental

Se retiraron cuatro clases de documentos:

1. auditorías de punto de partida que ya habían sido absorbidas por la arquitectura;
2. planes de continuación y bitácoras por bloque cuyo estado quedó obsoleto;
3. especificaciones duplicadas de catálogo, frontend, operación e importación;
4. reportes generados o cortes históricos que no debían competir con la fuente viva.

La información única se consolidó antes de retirar cada archivo: reglas de inventario y venta en Arquitectura; decisiones de conciliación en Catálogo; contratos de carga en Importación; paleta e interacción en Frontend; gates y riesgos en Calidad; y comandos en Operación.

### Mapa de consolidación

| Documentos auditados | Destino de la información útil |
| --- | --- |
| `PLAN.md`, `plan-continuacion.md`, `plan-maestro-convergencia.md` | Plan vivo del MCP, Calidad y este índice |
| `arquitectura-actual.md`, `auditoria-plataforma-actual.md`, `inventario-base-datos.md`, `inventario-rutas-y-modulos.md`, `decision-reutilizacion-v2.md`, `CONTEXTO_CONTINUACION_CATALOGO_V2.md` | Arquitectura |
| `bloque-2-modelo.md`, `bloque-2-preparacion.md`, `bloque-2/3/4/5-ejecucion.md`, `vertical-1-organizacion.md`, `vertical-2-proveedores.md` | Arquitectura, Operación y Migraciones |
| `CATALOG_V2_IMPLEMENTATION.md`, `carta-de-tonos-publica.md`, `certificacion-catalogo-local.md`, `catalog-review-workflow.md`, `catalog-review-phase1.md`, `auditoria-enriquecimiento.md`, `investigacion-sistema-acrilico.md` | Catálogo y Plan vivo del MCP |
| `importacion-catalogo-xlsx.md`, `importacion-masiva-catalogo.md` | Importación |
| `rediseno-frontend-plan.md`, `rediseno-prototipos-aprobados.md` | Frontend |
| `operacion.md`, `staging-produccion.md`, `roles-y-accesos-local.md`, `rendimiento-navegacion-local.md` | Operación reescrita |
| `requisitos-no-funcionales.md`, `riesgos-v2.md`, `backlog-b5.md` | Calidad y riesgos |

Se conservaron dos cortes fechados porque contienen evidencia primaria todavía consultable: `docs/evidencia-certificacion-1c/auditoria.md` y `research/catalog-master/reports/segunda-pasada-marcas-2026-08-10.md`. No son fuentes vivas y no deben editarse para reflejar el presente.

## Jerarquía de fuentes de verdad

Cuando dos documentos o capas discrepen, manda este orden:

1. migraciones SQL aplicadas y sus pruebas;
2. contratos de servidor y tipos de aplicación;
3. documentos canónicos de este índice;
4. reportes de investigación fechados;
5. apuntes manuales todavía no aplicados.

Un apunte, una evidencia externa o una candidata no modifica por sí sola el catálogo. La promoción siempre pasa por un comando transaccional y deja procedencia.

## Regla de mantenimiento

- No crear documentos llamados `plan-continuacion`, `contexto`, `bloque-N` o `auditoria-actual`.
- Actualizar el documento canónico del tema y su fecha o corte cuando corresponda.
- Los conteos variables deben llevar fecha; no deben presentarse como una constante del sistema.
- El detalle generado debe vivir en `test-results/`, `research/` o un artefacto estructurado, no en otro manual paralelo.
- Todo enlace a un documento retirado debe corregirse en el mismo cambio.

## Checklist de limpieza

- [x] Inventariar todos los Markdown del repositorio.
- [x] Clasificar vigencia, valor único y redundancia.
- [x] Definir la estructura canónica.
- [x] Consolidar reglas, decisiones y procedimientos útiles.
- [x] Retirar documentos redundantes y obsoletos.
- [x] Verificar enlaces y referencias internas.
