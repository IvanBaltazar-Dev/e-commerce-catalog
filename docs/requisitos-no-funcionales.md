# Requisitos no funcionales — Bellaroshé

Reglas que **no** dependen de qué pantalla se esté haciendo. Nada se aprueba sin
cumplirlas, igual que ninguna migración se cierra sin `audit:security` en verde.

## RNF-1 · Ninguna búsqueda pasa de 3 segundos

**Regla.** Toda superficie de búsqueda responde en **menos de 3 000 ms en el peor
caso**, con un catálogo de **100 000 productos**. No la mediana: el peor caso.

**Por qué el peor caso y no la mediana.** Una búsqueda que va a 200 ms nueve
veces y a 6 segundos la décima es, para quien vende, una búsqueda que se cuelga.
La clienta está delante y no le importa la mediana.

**Qué superficies cubre.** Inventariadas una a una el 2026-08-10; el documento
anterior se dejaba tres.

| Superficie | Contrato |
|---|---|
| Buscador del POS | `pos_variant_search` |
| Carta de tonos de un producto | `pos_product_tones` |
| Buscador de clientas | `pos_search_persons` |
| Catálogo público, listado | `catalog_list_v2` |
| Catálogo público, búsqueda | `catalog_list_v2` con término |
| Tablero de existencias | `inventory_board` |
| Lista de productos del admin | `/api/admin/products` — **sin contrato**, va por PostgREST |
| Buscador de relaciones | `/api/admin/catalog-v2/relations` — **sin contrato** |

Las dos últimas hacen `.or(name.ilike, code.ilike, …)` desde la aplicación, sin
pasar por ninguna función de la base. Eso es deuda aparte: una superficie de
búsqueda sin contrato no puede cumplir una regla que vive en el contrato.

**El patrón, desde 0072.** Un **documento de búsqueda** por fila con todo lo
buscable ya normalizado (minúsculas, sin tildes), y **un índice GIN trigrama**
sobre él. Diez comparaciones sobre cinco tablas pasan a ser una comparación
sobre una columna indexada. La normalización es una sola función,
`search_normalize`, y la usan tanto el documento como el término: si solo uno de
los dos pasara por ella, «lámpara» no encontraría «lampara».

Lo que entra en el documento de una variante: producto (código, nombre,
presentación, tipo), marca, línea, tono (nombre y código), variante (nombre,
SKU, código de barras) y **los valores de los atributos marcados
`is_searchable`** — que es lo que permite buscar por color, talla o tipo. Antes
ninguna superficie lo hacía.

**No se añade un sistema por atributo.** Cuando mañana haya que buscar por curva
de pestaña o por grosor, se marca `is_searchable` en su definición y entra
solo. No se toca código ni se añade otro `ILIKE`. El modelo ya declaraba los
atributos como datos; esto hace que esa declaración signifique algo.

### Las cuatro decisiones que sostienen el patrón

**1. Encontrar es barato; lo caro es lo que se calcula después.** Encontrar
«esmalte» entre 100 000 productos cuesta 53 ms y devuelve 20 278 variantes. La
búsqueda entera costaba 7 191 ms porque, por cada una de esas 20 278, el POS
volvía a leer la disponibilidad —que ya tenía unida— y calculaba el precio —que
solo necesitan las 24 que se muestran—. **Lo que interviene en el orden se
calcula para todas; lo que no, después del corte.**

**2. El orden del POS no se negocia.** Lo disponible va primero y lo agotado al
final. Bajar de 7 s quitando ese criterio sería arreglar un problema técnico
rompiendo la pantalla: quien vende necesita ver antes lo que puede vender. Como
ordenar así exige conocer la disponibilidad de todas las coincidencias, la
disponibilidad se lee de `inventory_stock` —cuya clave es
`(variant_id, branch_id)`, o sea que la fila del join ES la posición— en vez de
volver a consultarla por fila. **La fuente de verdad sigue siendo el
inventario**; aquí no se guarda ninguna copia.

**3. Lo que no cambia entre peticiones se precalcula.** Las facetas del catálogo
—qué opciones existen— son la misma respuesta en todas las visitas mientras no
haya un filtro que estreche el conjunto. Viven en `catalog_facet_presence`,
mantenida por disparador y reconstruida **solo para las definiciones afectadas**:
reconstruirla entera cuesta ~1 s con 100 000 productos, y hacerlo en cada
edición de un producto habría movido el segundo de la lectura a la escritura.
Con filtros puestos se calculan al vuelo, porque entonces el conjunto es pequeño
—filtrar por marca deja el listado en 163 ms—.

**4. Una o dos letras no son una búsqueda difusa.** Por debajo de tres
caracteres no se busca por subcadena en nombres ni descripciones: se busca por
**prefijo de SKU, código de barras, código interno y código de tono, más
coincidencia exacta de marca**. Teclear «R4» y ver el tono R4 es lo que se
espera; teclear «ml» y ver 60 000 filas porque las presentaciones dicen
«Frasco 8 ml», no. A partir de tres caracteres entra el trigrama normal. Es
mejor búsqueda, no una limitación.

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

**Estado medido el 2026-08-10** con 100 000 productos publicados, 201 578
variantes y 500 930 valores de atributo. Peor caso de 5 corridas:

| Superficie | Antes | Ahora | |
|---|---|---|---|
| POS · buscador de clientas | sin índice | **14 ms** | ✓ |
| Existencias · tablero con término | — | **28 ms** | ✓ |
| POS · carta de tonos | — | **77 ms** | ✓ |
| POS · término muy selectivo (SKU) | — | **550 ms** | ✓ |
| POS · por talla | no existía | **502 ms** | ✓ |
| POS · por color | no existía | **1 959 ms** | ✓ |
| Catálogo · búsqueda muy selectiva | — | **1 646 ms** | ✓ |
| Catálogo · búsqueda con tilde | no encontraba | **1 970 ms** | ✓ |
| Catálogo · búsqueda poco selectiva | 12 933 ms | **2 111 ms** | ✓ |
| Catálogo · búsqueda por color | 11 642 ms | **2 476 ms** | ✓ |
| Catálogo · listado sin término | 41 582 ms | **3 966 ms** | ✗ |
| Catálogo · término de dos letras | — | **5 096 ms** | ✗ |
| POS · término poco selectivo | — | **7 191 ms** | ✗ |
| POS · término poco selectivo con tilde | no encontraba | **7 055 ms** | ✗ |

Diez de catorce cumplen. Las cuatro que faltan y **por qué no es un problema de
índice en ninguna**:

- **POS con término poco selectivo.** «esmalte» casa con 20 278 variantes. El
  buscador calcula el precio y la disponibilidad de CADA una —dos funciones por
  fila— y solo después corta a 24. Es el mismo error que tenía el catálogo:
  construir caro antes de cortar. No se arregla moviendo código: el orden pone
  lo agotado al final, así que hay que conocer la disponibilidad de las 20 278
  antes de poder ordenar. **O se desnormaliza la disponibilidad, o cambia el
  criterio de orden. Es una decisión de producto.**
- **Listado del catálogo sin término.** Quedan las facetas, que preguntan qué
  opciones existen recorriendo el catálogo entero. Sin ningún filtro puesto, esa
  respuesta es global y no cambia entre peticiones: **cabe cachearla**.
- **Términos de una o dos letras.** El trigrama no puede indexarlos —no hay
  trigramas que buscar— y además «ml» casa con casi todo. Hay que decidir si por
  debajo de tres caracteres se busca solo por prefijo de SKU y código.

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
