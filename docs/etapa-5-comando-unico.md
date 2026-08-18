# Etapa 5 · Campaña unificada de Inteligencia de Catálogo

**Migración:** `0118_catalog_intelligence_campaign.sql`

**Comando:** `npm run catalog:intelligence`

**Estado:** implementada y certificada desde reconstrucción limpia

## Qué resuelve

La propietaria ya no tiene que ejecutar ni interpretar por separado investigación, auditoría semántica, Mesa, relaciones, sistemas y grafo. Una campaña toma una fuente oficial, parte del último corte persistido y termina con cuatro respuestas humanas:

- qué cambió en la fuente;
- qué productos nuevos tienen información suficiente para que Bellaroshé decida si quiere venderlos;
- qué productos siguen bloqueados y qué dato concreto falta;
- cuántas decisiones de relaciones y excepciones humanas continúan pendientes.

“Listo para decisión comercial” no significa “publicado”. La campaña no crea el producto Bellaroshé, no fija precio, no asigna stock y no decide por la dueña. Solo prepara una lista explicable para una decisión comercial posterior.

## Recorrido cerrado

Cada campaña congela fuente, marca, opciones, estado del conocimiento y huella comercial. Después registra nueve pasos:

1. delta de investigación oficial;
2. certificación semántica;
3. reprocesamiento seguro de la Mesa;
4. reprocesamiento de relaciones;
5. sincronización de las 18 decisiones agrupadas;
6. aplicación idempotente de manifiestos aprobados;
7. sincronización de Neo4j;
8. verificación de Neo4j contra PostgreSQL;
9. evaluación de referencias listas o bloqueadas.

El cierre exige que los nueve pasos estén terminados, que el grafo no tenga diferencias y que la huella de productos, precios, publicación y stock sea idéntica a la del preview. Si la evidencia o el conocimiento cambian antes de iniciar, el fingerprint queda obsoleto y la campaña debe prepararse otra vez.

Una interrupción no duplica el trabajo. Repetir la misma clave recupera los pasos exitosos y continúa desde el siguiente. Una misma clave no puede representar otra fuente, opciones diferentes ni otro resultado de paso.

## Criterio de preparación comercial

Una referencia oficial queda lista solo si conserva:

- identidad, marca y tipo definidos;
- al menos una variante presente;
- presentación informada;
- registro y URL de la fuente oficial;
- atributos semánticos suficientes;
- ninguna contradicción bloqueante;
- imagen oficial o deuda de imagen explícita.

El resultado conserva la referencia, el nombre, la razón de bloqueo y el estado sugerido. No actualiza `knowledge_status`: la sugerencia sigue separada de la adopción humana.

## Uso operativo

```bash
# Ver exactamente qué se congelará, sin ejecutar pasos
npm run catalog:intelligence -- preview \
  --source-key admiss-co-official --brand ADMISS --campaign-key <clave>

# Ejecutar o reanudar la misma campaña
npm run catalog:intelligence -- run \
  --source-key admiss-co-official --brand ADMISS --campaign-key <clave>

# Consultar una campaña sin modificarla
npm run catalog:intelligence -- report --campaign-id <uuid>

# Reusar el último universo sin volver a consultar la fuente
npm run catalog:intelligence -- run \
  --source-key admiss-co-official --brand ADMISS --campaign-key <clave> --skip-research
```

La herramienta MCP `catalog_campaign_report` ofrece el mismo reporte de solo lectura. No expone el comando de campaña, SQL, Cypher ni escrituras comerciales.

## Resultado real de aceptación

La campaña final `stage5-final-20260817`, ejecutada después de una reconstrucción completa, cerró los nueve pasos:

- delta oficial: 242 entidades sin cambios y cero altas, bajas o cambios;
- referencias evaluadas para adopción: 8;
- listas para decisión comercial: 6;
- bloqueadas: 2, ambas por presentación ausente;
- decisiones de relaciones pendientes: 18;
- cambios de producto, precio, stock o publicación: 0;
- decisiones humanas aplicadas por la campaña: 0;
- hechos canónicos automáticos: 0;
- grafo: 13.185 nodos, 24.445 aristas y cero diferencias.

La prueba pgTAP específica cubre 60 aserciones. La reconstrucción completa `0001`–`0118` pasó 55 archivos y 1.420 pruebas. Seguridad, tipos, lint y build pasaron; el gate de Etapa 5 y el cliente MCP verificaron además la campaña real y la paridad completa del grafo.

## Frontera posterior

Etapa 5 cierra la orquestación local manual. Automatización programada, ejecución remota, producción, adopción comercial, precio, stock, publicación, GraphRAG y expansión indiscriminada permanecen fuera de alcance. Antes de producción siguen pendientes la medición presencial de 4F, un entorno de staging, backup restaurado, E2E y rollback.
