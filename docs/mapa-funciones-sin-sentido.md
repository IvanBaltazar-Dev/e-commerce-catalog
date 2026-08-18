# Mapa de funciones que hoy no tienen sentido

Levantamiento del 18 de agosto de 2026 sobre la base local con el catálogo real
(1051 productos, 1570 variantes). Cada punto trae la evidencia que lo sostiene,
qué se hizo ya y qué queda por hacer. El criterio es uno solo: **la propietaria
solo debe revisar lo que puede decidir y lo que cambia algo.**

## 1 · El emparejador de nombres oficiales no sabe qué clase de producto compara

`official_product_name_and_code_v1` puntúa parecido de caracteres sin ninguna
guarda de tipo, categoría ni forma. Produce parejas como:

| Producto interno | Ficha oficial propuesta | Puntaje |
|---|---|---|
| Broca Bola | ACRY LOVE BOLSA BLACK CHICA | 0,52 |
| Broca Flama | BASE G3L 30ml | 0,42 |
| Polygel | Porta Esmalte | 0,40 |
| Acid Primer | Pulidor para Pies | 0,50 |
| Brush Cleaner & Restorer | Broca Cilindro Recto | 0,57 |
| Matificador | BALANCEADOR MASGLO DE PH 13,5 ML | 0,43 |

Una broca no es una bolsa; un limpiador de pinceles no es una broca. No son
dudas: son coincidencias de letras.

Peor, el mismo registro oficial es reclamado por varios productos a la vez.
`BRILLO GEL EVOLUTION MASGLO 13,5 ML` lo reclamaban seis brillos distintos
(Ajedrez, Arcoíris, Confianza, Destellos, Gel Tapa y Seda) y
`LIQUIDO ACRILICO MASGLO ULTRABOND 7 ML` lo reclamaban cuatro, entre ellos dos
polvos acrílicos: polvo y líquido son productos opuestos que comparten la
palabra «acrílico».

**Hecho:** la migración `0122` retira del trabajo humano las parejas sin ningún
término discriminante (17), las colisiones muchos-a-uno (24) y aquellas donde el
primer candidato y el segundo empatan (21). No se borran: pasan a deuda
automática.

**Pendiente:** el algoritmo sigue generando ese ruido en cada corrida. Necesita
una guarda de clase antes de puntuar —dos productos de familias distintas no
deberían llegar a compararse— y comparar a la granularidad correcta: los seis
brillos son tonos de una familia, no seis candidatos a un mismo artículo.

## 2 · La clase de trabajo se deriva del formato del registro, no de lo que pide

`default_catalog_review_handling_class()` decide si algo es decisión humana,
deuda automática, captura física o espera externa mirando **solo** `work_kind`.
Como todas las excepciones nacen con `work_kind = 'decision'`, todo aterrizaba
en la Mesa.

Resultado concreto: 156 encargos cuyo `required_action` dice literalmente
`BUSCAR_FABRICANTE_DISTRIBUIDOR_Y_CONTRASTAR_ENVASE` se le presentaban a la
propietaria como decisiones comerciales. Buscar no es decidir.

**Hecho:** `0122` los reclasifica como deuda de investigación (153; los otros 3
caen por la regla 4). Vuelven a la Mesa cuando haya un nombre concreto que
confirmar o rechazar.

**Pendiente:** el disparador sigue clasificando por formato. La regla correcta
es derivar la clase de la acción exigida, no del contenedor.

## 3 · La relevancia comercial existía y no significaba nada

`business_relevance` estaba en 0,0000 en 394 de 413 trabajos humanos. Con 153
marcados `high/high` y 241 `normal/normal`, la Mesa eran dos montones sin orden
interno: la propietaria no podía saber si la pregunta de delante afectaba a 36
productos o a uno.

**Hecho:** `0122` la llena con algo comprobable —cuántos productos del catálogo
quedan afectados— y `next_catalog_review_item_v1` ya la usaba para ordenar, así
que el efecto es inmediato. La primera pregunta de la cola afecta hoy a 86
productos.

**Pendiente:** `priority_tier` y `risk_level` siguen sin gradiente real. Si todo
es «alto», nada lo es.

## 4 · Las excepciones de identidad citaban filas de un Excel que no está

263 excepciones `identity_ambiguous` referían filas `Excel:NNN`. Esa fila no
existe en ninguna tabla:

- `import_rows`, `import_batches`, `import_issues`: 0 filas;
- la fuente `bellaroshe-workbook-v2` tiene **un** registro, de tipo `document`.

Ninguna de las 263 tenía `product_id` ni `variant_id`. La propietaria veía
«SOURCE_ROW: PEINE CARBON WAHL NEGRO» y nada más: una pregunta sin sujeto que
pudiera abrir.

El enlace nunca se perdió. Está en
`research/catalog-master/data/source_row_reconciliation.csv`, columnas
`internal_product_id` e `internal_variant_id`, **en la misma fila que generó la
excepción**. El generador (`research/catalog-master/build-master-tables.py`,
línea 178) se quedó con `entity_key` y descartó el destino que él mismo había
calculado.

**Hecho:** la migración `0123` restituye el enlace exacto de las 107
excepciones de fila fuente vivas. 106 apuntan ya a su producto y variante
reales; la 107 (`Excel:477`) apuntaba a un artículo DEMO retirado y se queda
como deuda, que es lo correcto. Las 156 restantes son de alcance marca, no de
fila.

**Pendiente:** el pipeline de investigación vuelve a producir el registro sin
el enlace. Hay que arreglarlo en origen o el problema regresa en la próxima
carga.

## 5 · La regla objetiva de tono era más estricta que el algoritmo que la alimenta

`objective_tone_identity` exigía que el tono interno y el oficial fueran la
misma cadena tras normalizar. Pero `exact_normalized_tone_or_official_code_v1`
puntúa 1 **por código**, no por título. Con «N.º 26» contra «26 Golden Brown»,
la regla no disparaba y la identidad —ya resuelta por la fuente oficial— volvía
a la propietaria. Eran 11 tonos de Bigen Permanent Powder, todos con URL
oficial y código idéntico.

**Hecho:** `0122` añade `objective_tone_code_identity`. Las 11 se resolvieron
solas, sin efecto comercial.

## 6 · La compuerta solo sabe bajar

El reprocesamiento degrada trabajos cuando la evidencia es insuficiente, pero no
los devuelve cuando mejora: un trabajo en deuda automática queda fuera de la
vista de necesidad y ninguna regla lo vuelve a subir.

Se notó al restituir los enlaces de la regla 4: 44 preguntas ya tenían sujeto
verificable y seguían ocultas.

**Hecho:** `0123` las repone a mano, con su evento de auditoría, y deja el
límite anotado en el propio archivo.

**Pendiente:** una regla de reposición dentro del plan de reprocesamiento, para
que la mejora de evidencia sea simétrica a su deterioro.

## 7 · Dos pantallas del panel son solo redirecciones

- `/admin/estructura` → redirige a `/admin/productos/nuevo`.
- `/admin/importaciones` → redirige a `/admin/catalogo/revisar`.

Ninguna aparece en la barra —la barra ya lo evita a propósito y lo documenta—,
pero siguen siendo rutas alcanzables que prometen una pantalla y dejan al
usuario en otra sin explicación.

**Pendiente:** al rehacer la navegación, decidir si desaparecen o si la
redirección se vuelve explícita.

---

## Efecto medido

| | Antes | Después |
|---|---|---|
| Preguntas atendibles por la propietaria | 402 | 182 |
| Peso humano sobre el trabajo activo | 27,65 % | 12,61 % |
| Preguntas de identidad sin producto ni variante detrás | 263 | 1 |
| Trabajos humanos con relevancia comercial en cero | 394 | 3 |
| Productos, variantes, precios, stock y publicación | 1051 / 1570 | sin cambios |

Las 182 se reparten en 162 de identidad —161 con su producto detrás—, 18
decisiones de relaciones, 2 vacíos de atributo y 1 de clasificación. Los tres
que siguen en relevancia cero son dos vacíos de conocimiento sobre atributos y
una identidad cuyo sujeto no es un producto: ninguno tiene huella comercial que
contar todavía.

Nada se borró. Todo lo retirado sigue abierto como deuda del sistema, con su
regla anotada y su evento en el historial.
