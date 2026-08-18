# Etapa 4E · Contrato de decisión y aplicación exacta

**Baseline funcional:** `52f66de` + cierre 4D `eea1c2c`

**Contrato:** `stage4e-v1`

**Migración:** `0116_catalog_relation_decision_apply.sql`

**Estado:** implementada y certificada localmente; habilita 4F

## Resultado

Las 18 decisiones agrupadas de 4C ya no son una presentación de solo lectura. Cada una tiene un expediente persistido, un único trabajo en la Mesa, un conjunto afectado congelado y acciones backend que siguen esta secuencia:

`lectura → preview exacto → huella → confirmación humana → apply atómico → auditoría → sincronización del grafo → verificación`.

El contrato nunca delega reglas a React. La interfaz envía una intención y los identificadores de concurrencia; PostgreSQL decide qué registros corresponden exactamente a esa versión.

## Persistencia

| Pieza | Responsabilidad |
| --- | --- |
| `catalog_relation_decisions` | decisión agrupada, read model humano, huellas, estado y resolución |
| `catalog_relation_decision_items` | conjunto exacto e inmutable de candidatas y evidencia observado en 4B |
| `catalog_relation_decision_previews` | intención, versión esperada, plan de mutación y huella de confirmación |
| `catalog_review_work_items` | estado operativo único: abierto, aplazado, reanudado o resuelto |
| `catalog_review_events` | historia inmutable de cada transición y decisión |

No se crea una segunda Mesa ni un trabajo por producto. Las 263 detecciones materiales conservan 18 decisiones y 18 trabajos humanos.

## Contrato de lectura

- `get_catalog_relation_decision_queue_v1` entrega la cola paginada con problema, recomendación, resultado, tratamiento de incertidumbre, impacto y acciones.
- `get_catalog_relation_decision_detail_v1` entrega productos y asociaciones por páginas, evidencia natural e historial.
- La copia de producto sale del backend con tildes, singular/plural y nombres legibles; `rule_code`, fingerprints y vocabulario epistemológico no aparecen en el primer nivel.
- `get_catalog_stage4e_report_v1` certifica métricas y guardas.

La incertidumbre es explícita: si el tipo o función de un producto no está confirmado, no adquiere membresía, no hereda la regla y no se retira una asociación dudosa.

## Acciones y efectos exactos

| Acción | Efecto |
| --- | --- |
| `ACCEPT_CLASS_RULE` | confirma únicamente las membresías del conjunto congelado y crea o reutiliza una regla de clase en capa de evidencia |
| `REJECT_CLASS_RULE` | descarta la promoción agrupada sin decidir ni borrar las candidatas históricas |
| `ACCEPT_MEMBERSHIP_SCOPE` | confirma membresías exactas; no afirma compatibilidad ni crea pares producto–producto |
| `ADJUST_ENDPOINT_PROFILE` | registra comentario y solicitud de corrección; no aplica la propuesta original |
| `ACCEPT_FALSE_PAIR_RETIREMENT` | marca las candidatas confirmadas como incorrectas sin borrar su historia |
| `KEEP_DEFERRED` | guarda nota y fecha en la Mesa; la decisión continúa pendiente |
| `RESUME` | devuelve un caso aplazado a revisión con versión nueva |

Precio, stock, publicación y hechos canónicos permanecen sin cambios en todas las acciones.

## Concurrencia e idempotencia

El preview exige versión de Mesa e idempotency key. Congela el plan y deriva su huella a partir de la decisión, el estado material, la acción, el comentario y la versión. Apply exige la misma huella y vuelve a calcular el estado dentro de la transacción.

Se detiene con conflicto si:

- cambió la versión de la Mesa;
- cambió la huella material;
- una candidata dejó de estar en el estado esperado;
- apareció una clase, membresía o regla incompatible;
- se intenta usar una clave idempotente para otra petición;
- el caso está aplazado, cerrado o fue sustituido.

Una repetición con la misma clave devuelve el resultado previo. El adaptador vuelve a sincronizar y verificar Neo4j incluso después de un apply ya confirmado, de modo que un fallo externo entre PostgreSQL y el grafo es reparable sin repetir la decisión.

## Grafo

Las membresías y reglas nacidas en 4E se proyectan mediante `graph_stage4e_knowledge_edges_v1` con `layer=evidence`. No entran en la capa canónica. `verify_catalog_relation_decision_v1` comprueba decisión, Mesa, preview, auditoría y separación epistémica después de la sincronización.

## Seguridad

- lectura y ejecución solo para personal autenticado con rol administrativo;
- sincronización interna reservada a `service_role`;
- tablas con RLS;
- elementos congelados protegidos por trigger contra actualización o borrado;
- funciones de escritura con actor autenticado, versión y límites de entrada;
- no hay SQL, Cypher, HTTP o múltiples `UPDATE` controlados por React.

## Certificación

El gate específico ejecutó 72 pruebas pgTAP sobre los casos reales de 19, 38 y 88 asociaciones. Cubre todas las acciones, aplazamiento/reanudación, huella incorrecta, estado obsoleto, idempotencia, permisos, inmutabilidad, historia, grafo de evidencia y ausencia de efectos comerciales.

La reconstrucción completa `0001`–`0116` pasó 53 archivos y 1.318 pruebas pgTAP. También pasaron tipo, lint, contrato MCP 4C y las ocho herramientas MCP 4E. La restauración del checkpoint regenera el preview 4B, aplica su corte analítico y vuelve a sincronizar las 18 decisiones, por lo que el estado no depende de residuos de una base anterior.

## Frontera de 4F

4E habilita una única superficie de producto en `Catálogo → Revisar`. 4F debe limitarse a mostrar cola/detalle, elegir una acción, conservar comentario o aplazamiento, pedir preview, confirmar y presentar el resultado. Toda semántica, conjunto afectado, seguridad e impacto permanece en backend.
