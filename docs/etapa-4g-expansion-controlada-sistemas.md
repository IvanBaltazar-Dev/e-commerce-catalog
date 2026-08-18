# Etapa 4G · Expansión controlada de sistemas

**Migración:** `0117_controlled_system_expansion.sql`

**Contrato:** `stage4g-v1`

**Estado:** implementada y certificada localmente; habilita Etapa 5

## Qué resuelve

El modelo universal de 4A ya podía representar cualquier sistema, pero solo Acrílico tenía una estructura profunda. 4G demuestra que el mismo contrato puede ampliarse sin investigar marcas en masa, clasificar productos por nombre ni multiplicar decisiones humanas.

La expansión toma un manifiesto pequeño, muestra primero su alcance y exige una huella exacta antes de aplicarlo. Solo crea vocabulario y propuestas de proceso:

- sistema y dominio;
- etapas y orden propuesto;
- roles y clases vacías;
- puentes etapa–rol–clase;
- requisitos de evidencia;
- transiciones y relaciones entre clases todavía no aprobadas.

No crea productos, variantes, membresías, roles por producto, precios, stock, publicación ni hechos canónicos.

## Pilotos reales

Se eligieron dos dominios ya presentes en las 18 decisiones de relaciones, sin búsqueda web adicional:

| Sistema | Dominio | Caso real que lo justifica |
| --- | --- | --- |
| `GEL_POLISH` | Uñas | `gel_color → gel_base`, `gel_top` y `lamp_uv_led` |
| `LASH_EXTENSION` | Pestañas | `lash_extension → lash_adhesive` y `lash_remover` |

Los manifiestos viven en `research/catalog-master/system-manifests/`. Gel aporta 6 etapas, 6 roles y 6 clases; Pestañas, 4 etapas, 5 roles y 5 clases. En conjunto cubren 8 decisiones de las tres familias humanas existentes.

## Frontera epistemológica

Toda aserción nueva queda en `NEEDS_EVIDENCE` y `needs_evidence`, sin `semantic_claim_id`. Esto incluye expectativas, puentes, requisitos, transiciones y las cinco relaciones propuestas. Una clase vacía explica qué tipo de producto podría cubrir una función; no afirma que un producto concreto pertenezca a ella y mucho menos que sea compatible con otro.

Los requisitos traducen la deuda a preguntas verificables, por ejemplo **Confirmar la función declarada** o **Confirmar para qué productos aplica**. La futura investigación podrá responderlas con fuente técnica; 4G no inventa la respuesta.

## Preview, concurrencia y auditoría

El flujo es:

```text
manifiesto → validación cerrada → preview → huella del modelo universal
           → apply exacto → corrida de auditoría → graph sync → verify
```

El preview rechaza claves comerciales incluso si aparecen anidadas, referencias internas rotas, códigos duplicados, tipos desconocidos y manifiestos fuera del límite controlado. Apply exige la huella mostrada y vuelve a calcular el estado completo del modelo; si otro conocimiento cambió, se detiene. Preview y apply son idempotentes y cada aplicación queda enlazada a `catalog_research_runs`.

## Operación

```bash
npm run system:expand -- preview <manifiesto.json> <clave>
npm run system:expand -- apply <preview-id> <huella> <clave>
npm run system:expand -- run-approved
npm run system:expand -- report
npm run gate:controlled-expansion
npm run test:mcp:stage4g
```

El adaptador MCP expone únicamente el reporte de certificación. La escritura permanece en el comando operacional y en las funciones cerradas de PostgreSQL.

## Certificación

- 42 pruebas pgTAP específicas;
- reconstrucción integrada: 54 archivos y 1.360 pruebas pgTAP;
- dos manifiestos aplicados con preview y huella;
- 2 sistemas, 2 dominios, 10 etapas, 11 roles, 11 clases y 5 relaciones propuestas;
- 8 decisiones reales cubiertas en 3 familias;
- 0 membresías, 0 roles por producto, 0 hechos canónicos y 0 efectos comerciales;
- herramienta MCP de solo lectura certificada;
- gate aislado 4G: 5.355 nodos y 7.595 aristas; certificación integrada con ADMISS: 12.965 nodos y 23.997 aristas. Graph Projector `v2.7.0` dejó fingerprints iguales y 0 divergencias en ambos cortes.

## Frontera de Etapa 5

4G no inicia campañas indiscriminadas ni toma decisiones humanas. Etapa 5 debe orquestar en un único comando los contratos ya cerrados: delta, auditoría, reprocesamiento seguro, sincronización de decisiones, manifiestos aprobados, proyección del grafo y reporte final. No puede aceptar por sí sola ninguna de las 18 decisiones ni convertir evidencia pendiente en conocimiento canónico.
