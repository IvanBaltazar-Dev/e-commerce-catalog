# Requisitos no funcionales — Bellaroshé

Reglas que **no** dependen de qué pantalla se esté haciendo. Nada se aprueba sin
cumplirlas, igual que ninguna migración se cierra sin `audit:security` en verde.

## RNF-1 · Ninguna búsqueda pasa de 3 segundos

**Regla.** Toda superficie de búsqueda responde en **menos de 3 000 ms en el peor
caso**, con un catálogo de **100 000 productos**. No la mediana: el peor caso.

**Por qué el peor caso y no la mediana.** Una búsqueda que va a 200 ms nueve
veces y a 6 segundos la décima es, para quien vende, una búsqueda que se cuelga.
La clienta está delante y no le importa la mediana.

**Qué superficies cubre.**

| Superficie | Contrato |
|---|---|
| Buscador del POS | `pos_variant_search` |
| Carta de tonos de un producto | `pos_product_tones` |
| Buscador de clientas | `pos_search_persons` |
| Catálogo público, listado | `catalog_list_v2` |
| Catálogo público, búsqueda | `catalog_list_v2` con término |

**Cómo se comprueba.**

```bash
npm run gate:busqueda
```

Siembra el volumen, mide cada superficie **N veces** y falla si el peor caso de
cualquiera supera el umbral. Lo que falla imprime su `EXPLAIN (ANALYZE, BUFFERS)`
— la única base admitida para tocar un índice.

**Qué NO cuenta como cumplirlo.** Medir con 1 500 productos y extrapolar. El
catálogo real ya tiene 1 578 variantes y todo responde en milisegundos; el
problema aparece con dos órdenes de magnitud más, y es ahí donde hay que medir.

**Deuda conocida, contada columna a columna el 2026-08-10.**
`pos_variant_search` hace **diez comparaciones `lower(columna) LIKE '%término%'`
sobre diez columnas de cinco tablas**. De las diez, **solo una** tiene un índice
que el planificador pueda usar:

| Columna comparada | Índice trigrama | ¿Sirve? |
|---|---|---|
| `products.name` | `gin (name gin_trgm_ops)` | **No** — es sobre la columna cruda |
| `products.code` | ninguno | **No** |
| `products.presentation` | ninguno | **No** |
| `brands.name` | ninguno | **No** |
| `product_lines.name` | ninguno | **No** |
| `color_shades.name` | `gin (lower(name) gin_trgm_ops)` | **Sí** |
| `color_shades.code` | ninguno | **No** |
| `product_variants.name` | ninguno | **No** |
| `product_variants.sku` | ninguno | **No** |
| `product_variants.barcode` | ninguno | **No** |

`color_shades.name` es la prueba de que el patrón correcto ya se conoce en este
repositorio: el índice se declara sobre **la misma expresión** que se compara. En
las otras nueve no se hizo, así que el planificador recorre la tabla entera.

Siete de las diez van envueltas en `coalesce(columna, '')`, que es otra razón
para no confiar en un índice sobre la columna cruda.

A 1 578 variantes son 2 ms y no se nota. A 100 000 sí.

## RNF-2 · Disponibilidad: lo cargado tiene que poder tocarse

**Regla.** Una pantalla que ya muestra datos responde a la interacción. Si una
lista está pintada, sus filtros, su búsqueda y sus acciones funcionan sin
recargar y sin bloquear el hilo.

**Por qué.** Tener todo el catálogo cargado no sirve de nada si al escribir en el
buscador la pantalla se congela: es peor que no haberlo cargado, porque promete
algo que no cumple.

## RNF-3 · Una sola sede

**Regla.** El negocio opera en **una sede**. Ninguna pantalla ofrece elegirla, ni
la nombra, ni la pide.

**Por qué.** El modelo soporta varias —y debe seguir soportándolas, porque el
negocio puede crecer— pero ofrecerlo hoy es preguntar por algo que no existe. En
el peor momento: al registrar una venta desde una reserva o un carrito.

**Trampa conocida.** Las pruebas integrales crean sedes propias. Si las dejan
activas, aparecen en el panel de la dueña como si fueran suyas. Toda prueba que
cree una sede la **desactiva al terminar** (`test:block2` lo hace desde esta
regla).

## RNF-4 · Las reglas críticas viven en PostgreSQL

**Regla.** Toda validación que proteja dinero, existencias o identidad existe en
la base, no solo en la pantalla. La pantalla puede adelantarla para avisar antes,
pero nunca es la única.

**Por qué.** Un script, el asistente o una pantalla futura no pasan por la
pantalla actual. Ver `sale_payment_problem`, `sale_fulfillment_gaps`,
`payment_requires_reference` y `tax_document_problem`: cada una es la definición
única de su regla y la consultan tanto el contrato como el disparador.
