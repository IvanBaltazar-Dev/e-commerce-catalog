# Calidad, requisitos no funcionales y riesgos

**Corte:** 2026-08-12. Solo se registran aquí requisitos transversales y riesgos todavía accionables.

## Requisitos no funcionales

### Búsqueda

Toda superficie de búsqueda responde en menos de 3.000 ms en el peor caso con 100.000 productos. La línea base validó 19 superficies, 201.578 variantes y 500.930 valores de atributo. El gate comprueba tiempo, plan indexado y semántica; una mediana buena no compensa un peor caso lento.

Patrón obligatorio:

- documento de búsqueda normalizado por fila;
- `search_normalize` en documento y término;
- índice GIN trigrama;
- atributos `is_searchable` incorporados como datos;
- calcular antes del límite solo lo necesario para ordenar y después del límite lo necesario para presentar;
- términos cortos y orden comercial cubiertos por prueba.

Ejecutar `npm run gate:busqueda` cuando cambien búsqueda, catálogo, atributos, precios, stock o sus proyecciones.

### Disponibilidad de la interfaz

- Una ruta autenticada no debe tardar más de tres segundos en el build de revisión local.
- La carga inicial no se duplica entre SSR y cliente.
- Una interacción sobre una rejilla grande actualiza el elemento afectado, no toda la colección.
- Que un registro esté cargado no significa que tenga stock, imagen o publicación; la interfaz explica cada estado.

### Integridad y seguridad

- Toda regla crítica existe en PostgreSQL y se consume mediante un contrato único.
- Una migración no está cerrada sin `db reset`, pgTAP y `audit:security` en verde.
- Las pruebas se acotan a sus fixtures y limpian siempre.
- Ningún proveedor de IA puede confirmar ventas, publicar contenido o bloquear la operación.
- La investigación externa no escribe directamente en tablas canónicas.
- Producción requiere staging, backup restaurado y rollback ensayado.

## Gates de aceptación

| Cambio | Gates mínimos |
| --- | --- |
| Documentación | enlaces, `git diff --check` |
| TypeScript/UI | `typecheck`, `lint`, prueba específica |
| Migración/RLS | `db:reset:local`, `test:db`, `audit:security` |
| Búsqueda/proyección | anterior + `gate:busqueda` |
| Enriquecimiento/Mesa | anterior + `gate:enriquecimiento`, rerun de revisión |
| Venta/dinero/stock | anterior + concurrencia e integral del dominio |
| Despliegue | backup restaurado, E2E staging, seguridad, rendimiento y rollback |

## Riesgos activos

| ID | Riesgo | Nivel | Mitigación o condición de cierre |
| --- | --- | --- | --- |
| R-02 | Credenciales remotas podrían ser cargadas por un entorno local mal configurado | Crítico | retirar secretos de archivos que Next.js carga, rotar claves expuestas y mantener guardas loopback |
| R-03 | Consumidores V1 y V2 pueden mantener dos verdades | Alto | inventariar lecturas V1, migrarlas y retirar V1 solo con gate específico |
| R-04 | Un MCP de escritura prematuro podría saltarse revisión, RLS o procedencia | Alto | primera versión de lectura; staging de investigación; comandos estrechos e idempotentes |
| R-05 | Tipos TypeScript escritos a mano pueden divergir de RPC JSON | Medio | generar tipos o validar con Zod en el borde |
| R-06 | Investigación e imágenes pueden confundirse con activos publicables | Alto | procedencia, hash, licencia, normalización y aprobación separadas |
| R-07 | Staging, secretos y recuperación remota no están verificados desde el repositorio | Alto | provisionar entorno, restaurar backup y ejecutar E2E antes de producción |
| R-08 | Conocimiento inferido puede convertirse en compatibilidad afirmada | Alto | mantener estados `unknown_pair`, evidencia obligatoria y gate de publicación |
| R-09 | Falta de pruebas unitarias rápidas obliga a levantar Docker para demasiada lógica pura | Medio | añadir cobertura unitaria a normalización, presentación y contratos puros |
| R-10 | Los conteos y documentos pueden volver a quedar desactualizados | Medio | un solo documento canónico por tema, cortes fechados y checklist vivo |

No se confirma aquí si una credencial existe o no; el riesgo se cierra únicamente con una auditoría segura del entorno y rotación documentada, sin copiar secretos al reporte.

## Riesgos cerrados que no deben reabrirse como documentos

- La banda local `55320–55329` resolvió el conflicto de puertos de Windows.
- Organización, sedes, rol seller y auditoría append-only existen en el esquema.
- El documento de búsqueda y sus contratos cerraron la línea base de rendimiento.
- La carga masiva local cubrió las 1.500 filas con excepciones explícitas e idempotencia.
- La Mesa de revisión cuenta con versión, idempotencia, dependencias y lotes congelados.

Si una regresión reaparece, se abre un riesgo nuevo o se reactiva el ID con evidencia actual; no se restaura una auditoría histórica completa.

## Checklist de cierre por sección

- [x] Requisitos de búsqueda consolidados.
- [x] Requisitos de interacción consolidados.
- [x] Gates mínimos definidos.
- [x] Riesgos históricos depurados.
- [x] Riesgos activos alineados con el plan MCP.
- [x] R-01: cerrado por el checkpoint reproducible y los commits de Etapas 0–1; el árbol quedó limpio antes de iniciar Etapa 2.
- [ ] R-02: credenciales remotas auditadas y rotadas si corresponde.
- [ ] R-07: staging real provisionado y verificado.
