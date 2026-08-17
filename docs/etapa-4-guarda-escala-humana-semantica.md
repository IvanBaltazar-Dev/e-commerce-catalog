# Guarda previa a Etapa 4 · Escala humana semántica

Estado: implementada y certificada localmente el 2026-08-12. La autorización humana para iniciar Etapa 4 fue otorgada el 2026-08-17.

## Regla operativa

El motor puede detectar más problemas, pero no puede convertir su volumen en revisión humana por producto. `UNKNOWN`, `NOT_STATED`, `DERIVED`, `INFERRED_UNCERTAIN` y ausencia de evidencia se conservan como conocimiento incompleto o deuda automática; no crean por sí solos un `human_exception`.

La única ruta semántica hacia Mesa exige simultáneamente:

1. una decisión material realmente bloqueada;
2. criterio humano que una regla automática no puede sustituir;
3. un problema previamente agregado con conjunto afectado y fingerprint;
4. sujeto de Mesa `rule`, nunca `product`;
5. una pregunta concreta sobre la regla o causa compartida.

## Contrato implementado

`catalog_semantic_problems` conserva cada detección y su producto, claim opcional, clase epistémica, `rule_code`, tipo técnico, dimensión, causa raíz y dos señales explícitas: `decision_blocking` y `requires_human_judgment`.

Cada detección pertenece obligatoriamente a `catalog_semantic_problem_groups`. La agrupación privilegia `rule_code`; sin regla conocida puede usar tipo técnico, dimensión o causa raíz. Una segunda partición de la misma regla exige `partition_key` y una justificación de no agregación de al menos 30 caracteres. Sin esa prueba, la base rechaza la operación.

`escalate_catalog_semantic_problem_group_v1` crea o versiona un único trabajo de la Mesa existente. El trabajo contiene:

- cantidad de problemas, productos y claims afectados;
- base y valor de agrupación;
- regla, tipos, dimensiones y causas raíz;
- fingerprint ordenado del conjunto afectado;
- justificación de cualquier partición excepcional.

No existe una segunda cola. Un trigger impide tanto el trabajo por producto como una ruta `manual` sin el contrato de agregación. Si el conjunto cambia, el expediente anterior queda `superseded` y aparece una nueva versión activa; no se muta la evidencia revisada.

## Embudo obligatorio de campaña

`catalog_semantic_campaign_funnel_v1` y `get_catalog_semantic_campaign_report_v1` reportan siempre:

`productos investigados → claims → problemas detectados → problemas agrupados → reglas afectadas → excepciones humanas`

Además exponen:

- excepciones humanas por 1.000 productos;
- proporción de revisiones individuales evitadas;
- fingerprints y cardinalidad de cada conjunto;
- evolución acumulada frente al Universo de Referencia mediante `catalog_semantic_scaling_v1`.

El MCP local de solo lectura incorpora `semantic_campaign_report`. La interfaz de Mesa presenta el expediente como problema de regla y obliga a explicar el criterio de resolución.

## Proyección al grafo

Graph Projector `v2.6.0` proyecta un nodo `SemanticProblemGroup` y, cuando corresponde, una sola arista `ESCALATED_AS` hacia `ReviewWork`. El conjunto de productos permanece en PostgreSQL mediante cardinalidad y fingerprint: no se generan aristas grupo×producto.

## Evidencia de certificación

| Control | Resultado |
| --- | ---: |
| Reconstrucción vacía | migraciones `0001`–`0112` aplicadas |
| Suite PostgreSQL | 49 archivos, 1.152 pruebas, todo verde |
| Invariantes nuevas | 49/49 |
| Gate de escala | 10.000 productos, 10.001 problemas |
| Problemas agrupados / reglas | 1 / 1 |
| Excepciones humanas activas | 1 |
| Versiones históricas al crecer el conjunto | 2 |
| Trabajo humano por producto | 0 |
| Excepciones por 1.000 productos | 0,1 |
| Ratio crecimiento excepción / universo | 0,0222 (`passes`) |
| Revisión individual evitada | 99,99 % |
| Tiempo del gate local | 22,9 s |
| Graph Projector | 12.624 nodos, 23.278 aristas, 0 divergencias |
| Seguridad estructural | sin violaciones |

El gate parte de una campaña base de 100 productos y una excepción, y luego usa dos olas de 5.000 productos distintos sometidos a la misma regla. La segunda ola cambia el conjunto y versiona el expediente, pero conserva exactamente una excepción humana activa. Frente a la base, el indicador longitudinal termina en `passes`; toda la carga sintética se revierte al terminar.

## Límite del cierre

`0110` queda cerrada como barrera de escala humana y no se amplía salvo regresión comprobada. `0111` y `0112` completan por separado el Checkpoint Semántico Universal descrito en [Checkpoint Semántico Universal](checkpoint-semantico-universal.md). La decisión expresa del 2026-08-17 levanta únicamente la barrera de inicio de Etapa 4; no autoriza expansión indiscriminada, trabajo por producto, canonización automática ni efectos comerciales.
