# Checkpoint Semántico Universal

Estado: **cerrado técnicamente; Etapa 4 no autorizada**.

Este checkpoint se apoya en la guarda de escala humana de `0110`, que permanece activa y sin ampliaciones funcionales. El motor puede detectar más problemas, pero una causa compartida sigue agregándose antes de llegar a Mesa.

## Contrato epistemológico

`catalog_semantic_claims.epistemic_class` separa cuatro capas que nunca se colapsan:

1. `OBSERVATION_LITERAL`: declaración literal con observación, snapshot, registro, campo, URL, excerpt, RAW y fingerprint.
2. `NORMALIZED_SOURCE_CLAIM`: la misma declaración normalizada por una regla `NORMALIZATION`; conserva procedencia y exige entailment sin inferencia.
3. `DERIVED_INFERRED`: una conclusión producida por una ejecución versionada y entradas persistidas. Nunca se presenta como declaración literal.
4. `CANONICAL_FACT`: un nodo nuevo producido únicamente por una promoción `RULE` o `HUMAN_GATE` explícita.

Los estados `UNKNOWN`, `NOT_STATED` y `NOT_APPLICABLE` no admiten valor fabricado y no crean trabajo humano por sí mismos. También se conservan `CONTRADICTED`, `NEEDS_EVIDENCE`, `REJECTED` y `SUPERSEDED`.

## Modelo dirigido por datos

- `catalog_semantic_dimensions`: registro extensible. Las 22 dimensiones iniciales son filas, no un `CHECK` cerrado; la cobertura se genera desde este registro.
- `catalog_technical_type_profiles`: perfiles heredables vinculados por código a `attribute_templates`. Toda plantilla nueva obtiene un perfil y el restaurador resincroniza UUID por código.
- `catalog_technical_type_dimension_policies`: declara `required`, `optional`, `conditional`, `not_applicable` o `forbidden` por dimensión.
- `catalog_semantic_rules`: nueve reglas iniciales que cubren ocho familias: `NORMALIZATION`, `DERIVATION`, `APPLICABILITY`, `EXCLUSION`, `CONTRADICTION`, `UNIT`, `RELATION` y `AUTHORITY`.
- `catalog_source_predicate_authority`: matriz por fuente o clase de fuente, rol, predicado, campo y dimensión. Una fuente no tiene autoridad global.

Los constraints rechazan reglas con alcance por marca, SKU o producto. Cada ejecución conserva `rule_code`, `rule_version`, inputs, output, confianza y explicación.

## Entailment, incompatibilidad y promoción

Un claim fuente sólo pasa a `ASSERTED` si `catalog_claim_entailments` demuestra que el texto respaldatorio está en el excerpt y `inference_required=false`. Si hace falta inferir, la salida debe ser `DERIVED_INFERRED`.

`catalog_semantic_claim_relations` registra `EXCLUDES`, `CONTRADICTS`, `BROADER_THAN`, `NARROWER_THAN`, `EQUIVALENT_TO` y `RELATED_TO`. Una contradicción conserva ambos valores y cadenas de evidencia, marca ambos claims y bloquea promoción canónica. La unicidad parcial impide dos hechos canónicos afirmados para el mismo sujeto y predicado.

## Certificación universal

`catalog_semantic_archetypes` contiene diez arquetipos sintéticos, sin marcas, nombres comerciales ni SKU:

- cosmético/químico;
- consumible dimensional;
- producto con variantes;
- equipo eléctrico;
- herramienta;
- repuesto;
- kit/bundle;
- multipropósito;
- múltiples fuentes contradictorias;
- datos incompletos.

`npm run gate:semantic-certification` revierte todos los fixtures y persiste sólo el certificado agregado. Ejercita 31 capacidades y 15 escenarios: dimensión añadida por datos, regla individual rechazada, autoridad fuente×predicado, literal con entailment, excerpt inválido, normalización, derivación, contradicción, bloqueo canónico, promoción válida, tres ausencias sin Mesa, proyección explicable, arquetipos, familias y golden set.

`catalog_semantic_golden_invariants` contiene diez invariantes generales. Su definición prohíbe claves por marca, nombre, SKU o producto.

`0112_universal_semantic_ingestion_bridge.sql` conecta la ingesta 0109 con el contrato nuevo. Cada `catalog_observation_semantic_terms` activo materializa automáticamente una observación literal y un claim normalizado, cada uno con entailment, procedencia y regla versionada. En la campaña ADMISS esto representa 1.587 + 1.587 claims explicables, 72 reglas activas de la familia `NORMALIZATION` —80 reglas semánticas totales—, cero violaciones, cero hechos canónicos y cero trabajo de Mesa.

Las baterías `0111` y `0112` contienen 85 + 30 pruebas adversariales. El conjunto completo queda en 49 archivos y 1.152 pruebas.

## Lecturas operativas

- `catalog_semantic_claim_explanations_v1`: claim, evidencia, regla, entailment y promoción.
- `catalog_semantic_contract_violations_v1`: violaciones fail-closed consumidas por certificación.
- `catalog_semantic_certification_summary_v1`: cobertura y resultado de certificados.
- `get_catalog_semantic_checkpoint_report_v1()`: resumen único; devuelve `stage4Authorized=false`.
- MCP `semantic_checkpoint_report`: la misma lectura local y sólo lectura.

Graph Projector `v2.6.0` proyecta dimensiones, reglas, tipos, claims, derivaciones, contradicciones y promociones. PostgreSQL es la única autoridad y el grafo continúa siendo reconstruible.

## Barrera de salida

La certificación verde demuestra calidad semántica universal, no autoriza conocimiento masivo. La decisión de iniciar Etapa 4 permanece fuera del motor y requiere autorización posterior.
