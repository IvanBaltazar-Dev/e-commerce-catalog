# Checkpoint · Investigación V1 cerrada

**22 de agosto de 2026**

Huella del consolidado:

```
ddd11d4bd3ef32c562c7d2483c92e8603a5ede423a77e5dc0f20b6913b377286
```

La huella se calcula sobre **identidades, no sobre recuentos**. La distinción no es
teórica: paginando sin orden estable llegamos a leer 18.836 filas con solo 10.808
identidades distintas, y ningún recuento lo detectó. Reproducible con
`npm run congelar:consolidado`.

---

## Qué queda capturado

| | |
|---|---|
| Fuentes | 6 · 5 Shopify + 1 WooCommerce, todas cerradas `COMPLETE` |
| Productos de referencia | 3.415 |
| Variantes vigentes | 2.391 |
| Con SKU de fabricante | 2.386 · 99,8% |
| Con GTIN | 283 |
| Precios externos | 5.512 · en 5 monedas con su mercado |
| Imágenes | 6.453 · 331 atadas a variante |
| Hechos de enriquecimiento | 295 |
| URLs con desenlace explicado | 7.791 |

Reconciliación contra Bellaroshé, sobre 1.570 variantes internas:

| Veredicto | Códigos |
|---|---|
| MATCH por GTIN | 86 |
| MATCH por SKU | 98 |
| Contradicción | **0** |
| Referencia nueva | 2.201 |

Los 86 GTIN sin una sola contradicción son el resultado más sólido del cierre:
los códigos de barras que ya teníamos quedan corroborados por una fuente
independiente.

---

## Invariantes, con su prueba

Los ocho pasan a fecha del checkpoint. Cada uno bloquea un error que ya ocurrió,
no un riesgo imaginado.

| Prueba | Qué impide |
|---|---|
| `test:gate-cierre` | Que una campaña se declare completa sin explicar cada URL descubierta |
| `test:superseded` | Que algo retirado vuelva a circular, y que retirarlo se confunda con borrarlo |
| `test:contrato-extraccion` | Que mejorar el extractor no llegue a los datos porque la web no cambió |
| `test:enriquecimiento` | Que una recaptura vacíe lo que costó conseguir ficha a ficha |
| `test:matriz-autoridad` | Que una excepción por marca repita lo que el contrato universal ya dice |
| `test:resolucion-predicados` | Que un dato observado se quede sin política que lo gobierne |
| `test:identidad-guardas` | Que dos códigos iguales de mundos distintos se lean como el mismo producto |
| `test:captura-contratos` | Que un rango de códigos se expanda inventando lo que no está escrito |

---

## Los siete errores de integridad que obligaron a reabrir

Todos se disfrazaron de éxito. Ninguno dio error.

1. **Precios ×100** — la API declaraba `currency_minor_unit: 2` y nadie lo leía.
   Un producto de S/18 figuraba como S/1.800.
2. **1.395 variantes que nunca existieron** — aplanar cada ficha en su propia
   variante. Las reales eran 281.
3. **Paginar sin `ORDER BY`** — 18.836 filas, 10.808 identidades. El 43% no salía
   nunca y el total era correcto.
4. **Superseded circulando** — marcar la fila no bastaba: la vista leía la tabla
   base y las servía igual.
5. **Datos capturados que no circulaban** — 295 códigos, 1.396 precios y 39
   productos padre existían en la base sin llegar a la capa que se lee.
6. **El extractor mejora y el dato no cambia** — la huella del snapshot solo
   miraba la web, así que el bloque que construye registros se saltaba entero.
7. **El enriquecimiento moría en cada recaptura** — los 295 códigos se cosecharon
   abriendo 304 fichas una a una y una recarga los dejó en cero.

---

## Lo que internet no puede resolver

Clasificado por **quién puede resolverlo**, no por tamaño. Un hueco que el sistema
representa correctamente como hueco no es un fallo.

### `NO_DECLARADO_POR_FUENTE`

| | |
|---|---|
| 3.399 | atributos comerciales — solo WooCommerce los publica estructurados |
| 2.316 | presentación — no viene como campo |
| 2.113 | descripción — o no hay texto, o es comercial |
| 2.060 | imagen de variante **no demostrada** — la fuente sirve la del producto para todos los tonos |
| 1.985 | eje de variante — en 4 de 6 tiendas cada tono es un producto suelto |
| 36 | imagen de producto · 5 SKU de variante |

### `REQUIERE_CAPTURA_FISICA` — 2.108 GTIN

| Fuente | Faltan |
|---|---|
| mc-nails-mx | 1.035 |
| acrylove | 514 |
| cherimoya-pe | 281 |
| bigen-usa | 136 |
| admiss-co | 121 |
| masglo-es | 21 |

Solo Masglo expone código de barras por API, y no en el listado: hay que abrir
ficha a ficha. Cherimoya y Bigen devuelven `null`, Admiss bloquea la ficha
individual, Acrylove y MC Nails traen el campo vacío.

### `REQUIERE_DECISION_HUMANA` — 2.201 referencias nuevas

Existen en una fuente oficial y no en nuestro catálogo. Que existan no significa
que debamos venderlas.

### `ENRIQUECIMIENTO_OPCIONAL` — 2.021 precios externos

Observaciones de mercado ajeno. Por regla no pueden tocar el precio de
Bellaroshé, así que su ausencia no bloquea nada.

---

## Lo que queda montado para los próximos miles

No es el volumen capturado: son las decisiones tomadas y escritas como datos.

- **Contrato de cierre** — descubiertas = intentadas = capturadas + ausencias +
  errores. Sin eso, no hay `COMPLETE`.
- **Autoridad por dato** — ninguna fuente manda sobre todo. Cero políticas por
  marca: el contrato universal lo explica entero.
- **Clase epistémica** — una inferencia del parser nunca llega con la autoridad
  literal de la fuente.
- **Enriquecimiento por identidad** — sobrevive a las recapturas con su
  procedencia.
- **Dos conectores genéricos** — Shopify y WooCommerce. Una marca nueva no es un
  proyecto nuevo.
- **Lectura masiva** — orden estable obligatorio y verificación de que filas =
  identidades, por página y al final.

Vocabulario de atributos, medido y **sin decidir**: 77 nombres crudos → 41
conceptos, de los cuales 11 están escritos de varias formas (`COLORES/Colores`,
`TONOS/Tonos`, `CONTENIDO/Contenido`). Son mayúsculas, no conceptos distintos.

---

## Condición de parada

> Si una nueva pasada no aporta identidad, descripción, atributo comercial útil,
> precio o imagen verificable, dejamos de investigar ese producto.

Se cumple. La última pasada no encontró ninguna vía nueva.

**A partir de aquí no se tocan crawlers ni adaptadores salvo bug de integridad
demostrado.** «Falta una foto» no lo es.

---

## Pendiente declarado

- **Descarga de imágenes incompleta**: 4.337 de 6.307 ficheros, 2,9 GB. Siguen
  siendo `remote_reference`; tenerlas en disco no las convierte en material
  publicable de Bellaroshé.
- **Cola física para la dueña**: 2.108 GTIN por capturar, fotografía propia donde
  la fuente no la da, y decisión comercial sobre las 2.201 referencias nuevas.

## Siguiente etapa

Terminar Bellaroshé como producto: catálogo y ficha, variantes y tonos, imágenes,
precios, proveedores y compras, inventario, venta y caja, filtros y búsqueda,
publicación. Y sobre el frontend, la completitud real de cada producto: qué
sabemos, qué falta y por qué.
