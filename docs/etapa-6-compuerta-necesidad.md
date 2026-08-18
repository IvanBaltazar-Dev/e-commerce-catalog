# Etapa 6 · La Mesa solo pregunta lo que hace falta preguntar

**Migraciones:** `0122_catalog_review_necessity_gate.sql`,
`0123_catalog_source_row_exception_subjects.sql`

**Estado:** implementada, probada y aplicada sobre el catálogo real local

## Qué resuelve

La Mesa acumulaba 402 preguntas atendibles. Al abrirlas una por una, la mayoría
no eran decisiones comerciales: eran defectos de método presentados con forma de
pregunta. El detalle, con evidencia, está en
[el mapa de funciones sin sentido](mapa-funciones-sin-sentido.md).

Ahora quedan 182, cada una con un sujeto que se puede abrir y un número que dice
a cuántos productos del catálogo afecta.

## La compuerta

Un trabajo llega a la propietaria solo si cumple dos condiciones:

- **es respondible** — la pregunta tiene un sujeto recuperable y el sistema
  ofrece un candidato distinguible del siguiente;
- **es una decisión** — lo que pide es elegir, no buscar.

Cuando falla alguna, el trabajo no se borra ni se cierra: baja a deuda
automática. Sigue abierto, el sistema lo sigue debiendo, y deja de cobrárselo a
la dueña. Siete veredictos lo explican:

| Veredicto | Qué significa | Retirados |
|---|---|---|
| `matcher_without_discriminator` | El nombre interno y el título oficial no comparten un solo término | 17 |
| `matcher_collides_many_to_one` | Varios productos internos reclaman la misma ficha oficial | 24 |
| `matcher_candidates_indistinguishable` | El primer candidato y el segundo empatan | 21 |
| `source_row_reference_unresolvable` | La fila fuente citada no corresponde a ningún producto | 10 |
| `source_row_resemblance_too_weak` | Se le parecen productos, pero ninguno con claridad | 35 |
| `subject_without_commercial_footprint` | La marca no tiene ningún producto que desbloquear | 3 |
| `action_is_research_not_decision` | El encargo dice «buscar el fabricante», no «elegir» | 153 |

Además, once identidades de tono que la fuente oficial ya había resuelto se
cierran solas: el algoritmo puntuaba 1 por igualdad de código y la regla vieja
exigía igualdad de la cadena completa («N.º 26» contra «26 Golden Brown»).

## El orden de lo que queda

`business_relevance` estaba en cero en 394 de 413 trabajos. Ahora significa una
sola cosa comprobable: **cuántos productos del catálogo quedan afectados por esa
decisión**. Una marca con 36 productos vale 36; una con uno vale 1. El tope es
100 porque más allá ya no cambia ninguna prioridad.

`next_catalog_review_item_v1` ya ordenaba por ese campo, así que el efecto es
inmediato: la primera pregunta de la cola afecta hoy a 86 productos, no a uno
elegido al azar.

## El sujeto de cada pregunta

Las 107 excepciones de fila fuente vivas llegaron sin producto ni variante: solo
con el texto «SOURCE_ROW: PEINE CARBON WAHL NEGRO» y una clave `Excel:109` que
no existe en ninguna tabla del sistema.

El enlace estaba en `research/catalog-master/data/source_row_reconciliation.csv`,
columnas `internal_product_id` e `internal_variant_id`, en la misma fila que
generó la excepción. `0123` lo restituye: 106 de 107 apuntan ya a su producto y
su variante reales. La restante citaba un artículo DEMO retirado y se queda como
deuda, que es lo correcto.

Con el sujeto de vuelta, 44 preguntas que la compuerta había bajado por no
encontrarlo regresan a la Mesa. La compuerta solo sabe bajar: esa reposición se
hizo a mano y quedó anotada como límite conocido.

## Lo que la compuerta nunca hace

No borra trabajos, no los cierra, no publica, no crea productos, no fija precio
ni stock. Todo lo retirado queda abierto con su regla anotada y su evento en el
historial. La huella comercial antes y después es idéntica: 1051 productos,
1570 variantes, cero DEMO.

## Evidencia

- pgTAP `0122_catalog_review_necessity_gate.test.sql`: 24 aserciones.
- Suite de Mesa completa (0097, 0098, 0099, 0100, 0108, 0110, 0116, 0122) más el
  bloqueo de privilegios 0045: 280 pruebas en verde.
- Reprocesamiento real con preview y apply idempotentes: 263 reclasificados,
  11 resueltos, 0 cambios comerciales.
- Regresión de entrega de la Mesa por HTTP: opciones antes que evidencia y cero
  cargas no solicitadas desde la barra.
- `typecheck` y `lint` en verde.

## Frontera

Queda fuera: la guarda de clase dentro del propio emparejador, la derivación de
la clase de trabajo desde la acción exigida en el disparador, la regla de
reposición simétrica dentro del plan de reprocesamiento y la corrección del
pipeline de investigación para que no vuelva a producir excepciones sin enlace.
Cada uno está descrito en el mapa.

La suite pgTAP completa sigue exigiendo base vacía: doce archivos antiguos
(0025, 0027–0033, 0037, 0038, 0047) fallan por fixtures que asumen una base sin
catálogo restaurado. No los toca esta etapa; los cubre `gate:rebuild`.
