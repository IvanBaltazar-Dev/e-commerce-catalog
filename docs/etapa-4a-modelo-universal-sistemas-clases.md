# Etapa 4A · Modelo universal de sistemas y clases

Estado: **contrato universal implementado y certificado en `0113` el 2026-08-17**. El reprocesamiento de las 323 relaciones históricas no forma parte de este corte.

## Contrato

El modelo reutiliza `catalog_systems`, `catalog_stages`, `catalog_roles`, `catalog_system_stage_roles`, `catalog_classes`, `catalog_class_members`, `product_system_roles` y `catalog_relation_rules`. No existe ninguna tabla `stage4_*`.

La cadena queda representada así:

```text
catalog_systems
  → catalog_stages
  → catalog_system_stage_roles
  → catalog_system_stage_role_classes
  → catalog_class_requirements
  → catalog_class_members / product_system_roles
  → producto, variante, referencia de producto o referencia de variante
```

`catalog_role_kinds`, `catalog_relation_kinds` y `catalog_requirement_kinds` sustituyen listas cerradas por registros extensibles. Los nueve tipos de relación son `REQUIRES`, `PRECEDES`, `FOLLOWS`, `ALTERNATIVE_TO`, `SUBSTITUTES_FOR`, `EXCLUDES`, `COMPATIBLE_WITH`, `INCOMPATIBLE_WITH` y `COMPLEMENTS`. `catalog_stage_transitions` conserva orden y ramas explícitas; la posición de una etapa no se trata por sí sola como una afirmación de secuencia.

Pertenencia, función y compatibilidad son contratos distintos. Dos elementos pueden pertenecer al mismo sistema y cubrir roles del mismo proceso sin ser compatibles. Las relaciones estrictas exigen `brand_policy=explicit_evidence` y un claim afirmado de dimensión `compatibility`; un claim de proceso no supera esa guarda.

## Frontera epistemológica

Las declaraciones oficiales del fixture entran por la cadena existente:

```text
OBSERVATION_LITERAL
  → NORMALIZED_SOURCE_CLAIM
  → DERIVED_INFERRED
  → CANONICAL_FACT solo mediante promoción explícita
```

`0113` añade cuatro observaciones literales, cuatro claims normalizados y cuatro inferencias de sistema. Crea **cero** hechos canónicos. Las aserciones nuevas de rol–clase, requisito, transición y relación enlazan un claim compatible con su estado epistemológico o permanecen en `NEEDS_EVIDENCE`. El estado `LEGACY_CANONICAL_PRE_0111` documenta las dos reglas anteriores al checkpoint, pero está cerrado para inserts nuevos.

La autoridad de procesos continúa siendo fuente × predicado × campo. Manuales y fichas oficiales pueden sostener el paso o función que declaran; no reciben autoridad global. Popularidad y recomendación de marketplace están prohibidas como hecho técnico.

## Fixture real Acrílico

El fixture valida el motor con datos, no con reglas por familia:

| Medida | Resultado |
| --- | ---: |
| Sistemas | 1 |
| Etapas Acrílico | 8 |
| Roles | 15 |
| Clases | 16 |
| Puentes rol–clase | 16 |
| Requisitos | 8 |
| Secuencias | 8 |
| Productos internos que cubren roles | 45 |
| Referencias oficiales no comerciales | 2 |
| Requisitos pendientes de evidencia | 3 |
| Transiciones pendientes de evidencia | 1 |
| Canonizaciones creadas | 0 |

Las macrofases requeridas quedan cubiertas por preparación, construcción, decoración/acabado, mantenimiento y retiro, conservando además etapas finas de extensión, adhesión y perfeccionamiento. Las referencias AcryLove de deshidratador y removedor demuestran cobertura externa sin adopción comercial, precio, stock ni publicación.

## Reporte, MCP y grafo

`get_catalog_stage4a_report_v1()` devuelve alcance, cobertura, estado epistemológico, embudo semántico, guardas comerciales y el checkpoint histórico. MCP expone la misma lectura mediante `stage4a_system_class_report`; la herramienta es local, STDIO y de solo lectura.

Graph Projector `v2.7.0` añade requisitos y aristas de rol–clase, clase–requisito y secuencia. PostgreSQL sigue decidiendo. El rebuild certificado proyectó 5.290 nodos y 7.545 aristas con fingerprint `bd81735d87fa3dd63c04a2f40c9e3680785a1698fbae8b3aaee1d215b6e7382e` idéntico en ambos motores y cero diferencias.

## Evidencia de cierre

- reset completo: migraciones `0001`–`0113` y seeds aplicados;
- pgTAP: 50 archivos, 1.186 pruebas, todas verdes sobre el checkpoint restaurado;
- pruebas nuevas `0113`: 34, incluidas guardas adversariales de compatibilidad y estado legado;
- `npm run audit:security`: sin violaciones;
- `npm run typecheck` y `npm run lint`: verdes;
- `npm run gate:semantic-certification`: 10 arquetipos, 31 capacidades, 0 violaciones y `stage4Authorized=false`;
- `npm run graph:rebuild` + `npm run graph:verify`: cero divergencias;
- `npm run gate:stage4a`: verde;
- `npm run test:mcp:stage4a`: verde.

## Siguiente corte

Las 323 candidatas reales siguen en `needs_evidence`; `analyzedThisCut=0` y `untouched=323`. El siguiente trabajo es diseñar y ejecutar su reprocesamiento controlado para medir membresías/clases frente a relaciones genuinamente producto–producto y obtener al menos tres clases de problema humano real. Hasta entonces siguen fuera de alcance el frontend de decisiones, investigación masiva de marcas, GraphRAG, precio, inventario, publicación y cualquier cambio a `stage4Authorized=false`.
