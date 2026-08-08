# Prototipos aprobados — especificación para implementar

Complementa a [rediseno-frontend-plan.md](rediseno-frontend-plan.md). Ese documento decide **cómo**
se ejecuta el rediseño; este fija **qué** se aprobó, con valores exactos y las reglas transversales
que salieron de revisar los prototipos con Ivan.

Donde ambos se contradigan, manda lo de aquí: son decisiones tomadas mirando pantallas, no supuestos.
Al final hay tres puntos que **necesitan confirmación de Ivan** antes de codificar.

## Prototipos vivos

Ivan tiene los enlaces; son artifacts navegables y funcionales, no maquetas.

| Prototipo | Qué fija |
|---|---|
| **Inicio de la propietaria** | Jerarquía de centro de decisión, KPI, atención priorizada, accesos rápidos, hallazgos |
| **Ventas → Nueva venta** | POS completo: búsqueda, selector de 200 tonos, carrito, cobro, limpieza y guardas |
| **Nota de venta 80 mm** | Ticket térmico, agrupación por producto, niveles de información |

Los tres comparten paleta, tipografía y densidad. **El POS es el más completo**: tiene lógica real
(mayoreo, vuelto, stock, estados) y sirve de referencia de comportamiento, no solo de aspecto.

---

## 1. Paleta aprobada — valores exactos

Ivan rechazó dos veces desviarse de aquí. La historia importa para no repetirlo:
primero propuse otra paleta (ciruela/champán oscura) → *«muy oscuros y nada estéticos»*;
después rosa+blanco a secas → *«no quiero que solo sea rosa con blanco, busca un balance»*.

Lo aprobado es **porcelana, tinta y rosa**, con color por función:

```
Superficie   --ground   #F3EFEB   porcelana cálida (fondo de página)
             --surface  #FFFFFF   tarjetas y paneles
             --surface-2 #F8F4F1  hundido / campos
             --hover    #FBF6F8

Texto        --ink      #241621   ciruela casi negro  ← alto contraste, NO mauve apagado
             --ink-2    #4A3A43   secundario
             --ink-3    #6B5A64   terciario (mínimo legible)

Línea        --line     #E8E0E3   hairline por defecto
             --line-2   #DBD0D5   énfasis

Acento       --rose      #D3348A  ← rosa Bellaroshé, intacto
             --rose-deep #B02470  hover / texto sobre claro
             --rose-wash #FBE9F2  tinte y anillo de foco

Por función  --plum  #7A3768 / wash #F5E9F1     analítica
             --gold  #A9762E · deep #8A5F22 / wash #F8F0DF   inventario, fechas
             --green #3E7150 / wash #EBF3ED · line #CBE0D3   dinero a favor, éxito
             --teal  #3C6E86 / wash #E8F0F3     clientes y conversaciones
             --clay  #9A6242 / wash #F4ECE5     catálogo

Severidad    --crit #C0392B (urgente) · --imp #CF7C2A (importante) · --low #CFA22B (atención)
```

**Reglas de color:**
- El rosa es **acento**, no inundación. Manda en la acción principal y poco más.
- El color por función distingue dominios de un vistazo; siempre **apagado**, nunca neón.
- Los semánticos no son variantes del rosa.
- `--gold-deep` existe porque `--gold` no contrastaba en texto pequeño sobre fondo claro.

## 2. Tipografía — Manrope, con el pase de refinamiento aplicado

Aprobada tras un pase que Ivan pidió explícitamente. **Los valores de ese pase son parte de lo
aprobado**, no un detalle:

| Elemento | Peso | Tamaño | Tracking |
|---|---|---|---|
| Título de pantalla | **500** | 30–40px | −0.012em |
| Cifra protagonista (una por pantalla) | **700** | 32–42px | −0.02em |
| Número KPI | **600** | 22–26px | −0.01em |
| Título de sección (versalitas) | **600** | 11.5px | **+0.075em** |
| Etiqueta (versalitas) | **500** | 11px | **+0.07em** |
| Botón / acción | **600** | 13.5–14px | normal |
| Cuerpo y secundarios | **400** | 12.5–16px | normal |
| Fecha destacada | **500** | 13.5px | ~0 · **sin versalitas** |

**Reglas del pase de refinamiento (obligatorias):**
1. **Tracking contenido** en versalitas: ~.07–.10em. El .16–.20em inicial fue rechazado.
2. **Contraste real en secundarios**: nada de grises claros. Los `--ink-2` / `--ink-3` de arriba son
   el mínimo, y los secundarios van a **12.5–13px**, no a 11–12.
3. **Títulos ligeros**: el título de pantalla en 500, no 600. *«Quiero elegancia, no que domine.»*
4. `font-variant-numeric: tabular-nums` en **todo** número: KPI, importes, cantidades, tablas.
5. Un solo 700 grande por pantalla. Evitar el exceso de negritas: la interfaz debe sentirse fina.

Referencia de sensación: **kokoistusa.com** — limpieza, aire, elegancia tipográfica. **No** copiar su
decoración: un sistema que se opera todo el día necesita más claridad que una tienda.

## 3. Forma — radios y elevación

⚠️ **Discrepancia con el plan de Fase 0.** Ese documento propone `--r-md 12 / --r-lg 16 / --r-xl 20`.
Los prototipos aprobados usan **7px (controles) y 10px (tarjetas)**, y llegaron ahí porque Ivan pidió
literalmente *«no quiero que exista exceso de curva en todas las tarjetas, algo más sobrio, refinado,
corporativo»*. Un 16–20px devuelve el problema.

```
--r-sm  6–7px   controles, campos, chips, botones
--r     10px    tarjetas y paneles
--r-pill 999px  solo píldoras deliberadas (chips de tono, badges)
```

**Elevación**: la profundidad sale de fondo → superficie → borde. Las tarjetas **no flotan**: borde
de 1px y, como mucho, `0 6px 20px rgba(36,22,33,.06)` en hover. Sombra fuerte solo en overlays.

---

## 4. Reglas transversales — aplican a TODAS las pantallas

### 4.1 Un dato = un único dueño visual
Ningún número aparece en dos bloques de la misma pantalla. Inicio **resume**; el módulo dueño
**explica y permite resolver**. Profundizar **no** significa crear otra pantalla: se abre el módulo
dueño **prefiltrado**.

**Excepción consciente:** las *acciones* críticas sí pueden repetirse. «Nueva venta» vive a la vez en
el header global y en los accesos rápidos — eso es accesibilidad, no duplicación de información.

### 4.2 Regla temporal
- **Una semana = lunes a domingo, 7 días completos.** Nunca una ventana móvil de 7 días bajo ese nombre.
- **Inicio usa la última semana CERRADA** contra la anterior completa. Título en pasado: *«Lo que
  funcionó la semana pasada»*. Ejemplo para sábado 08/08/2026: muestra 27/07–02/08 vs. 20/07–26/07.
- KPI superiores: **hoy vs. ayer**. Analítica: histórico configurable.
- **Mostrar fechas concretas** siempre que se pueda.
- Al comparar **dinero**, la variación va en **soles** (`▲ S/ 68 vs. ayer`), nunca en «pp».
- Implementación: exige **dos rangos de fechas explícitos** en las consultas, jamás `interval '7 days'`.

### 4.3 Lenguaje
Sin jerga en superficies de decisión. `margen` → **«Ganancia bruta»** (importe primero, porcentaje
debajo). `bajo mínimo` → **«por agotarse»**. El concepto técnico vive en Analítica → Rentabilidad.

**Verbos, cada uno con un significado único** (nunca «Eliminar» para todo):

| Verbo | Alcance |
|---|---|
| Limpiar selección | selección temporal del selector de tonos |
| Quitar | una línea o un tono |
| Vaciar venta | todo el carrito **en preparación** |
| Quitar clienta | desvincular |
| Cancelar reserva | operación de negocio distinta |
| Anular venta | venta ya confirmada, con trazabilidad |

### 4.4 Confirmación inteligente
**Sin confirmar** (inmediato): bajar cantidad, quitar una línea, quitar un tono.
**Confirmando**: limpiar toda la selección, vaciar la venta, abandonar una venta con productos.
La confirmación **dice qué se pierde y qué NO** (p. ej. *«la reserva #R-018 no se cancela: solo se
quita de esta venta, y su adelanto sigue registrado»*).

Una venta **cobrada** nunca tiene «Vaciar»: a partir de ahí solo cabe anular o devolver.

### 4.5 Precio mayorista — cómo se muestra
El umbral **no es 3**: es `products.wholesale_min_quantity`, **por producto y configurable por la
dueña**. Prohibido escribir «desde 3» como constante, en código o en textos.

Se gana **por producto sumando sus variantes**. Como una línea de 2 unidades puede llevar precio
mayorista (porque otro tono del mismo producto suma), **nunca marcar la línea con «MAYORISTA» a
secas**: parece un precio mal puesto. Agrupar por producto y mostrar las unidades reales.

### 4.6 Niveles de información (impresos y pantallas densas)
- **Nivel 1, siempre**: producto · marca · presentación / cantidades × variantes / cantidad × precio → importe.
- **Nivel 2, cuando aplica**: mayorista, descuento, promoción.
- **Nivel 3, nunca por defecto**: SKU, código interno, id de variante, precio anterior, atributos
  técnicos. Vive en la venta digital. Configurable, apagado por omisión.

### 4.7 Entrada por rol
No hay pantalla inicial universal. **Propietaria → Inicio. Vendedora → Ventas / Nueva venta**, con el
buscador **enfocado** para teclear al instante. «Nueva venta» es acción global desde cualquier
pantalla (en móvil, solo el icono).

---

## 5. Especificación por pantalla

### 5.1 Inicio de la propietaria — centro de decisión, NO menú de módulos

Cuatro bloques, en este orden, sin añadir más:

1. **¿Cómo va?** — saludo cálido + fecha legible + **4 KPI**: Venta hoy · Ganancia bruta hoy ·
   Cobrado hoy · Atención. *Cobrado ≠ saldo de caja*: no mezclar.
2. **Dos paneles lado a lado**:
   - **Meta de hoy** — % alcanzado, barra, cuánto falta y para cuánto, **evolución horaria**, ticket
     promedio, mejor categoría, mejor canal. **No repite** venta, ganancia ni comparación con ayer.
   - **Necesita tu atención** — priorizado en **3 niveles** (🔴 urgente / 🟠 importante / 🟡 atención),
     ordenado por severidad, **cada ítem con su acción** (Emitir → / Responder → / Revisar → / Reponer →).
3. **¿Qué quieres hacer?** — 6 accesos compactos. «Nueva venta» aquí es **acceso rápido**, no la
   tarjeta gigante: eso era pensar como vendedora, no como dueña.
4. **Lo que funcionó la semana pasada** — hallazgos positivos, semana cerrada, con fechas.

Sin gráficas de más: **una sparkline y una barra de meta bastan**.

### 5.2 Ventas → Nueva venta — tres velocidades

El POS debe resolver los tres caminos, y **la búsqueda es el principal**:

1. **Sé qué quiere** → el buscador indexa producto, marca, línea, **nombre y código de tono, SKU y
   barcode**, y devuelve **la variante directa** (fila con swatch, tono, código, stock, Agregar).
   Escribir *«Abrumadora»* NO debe obligar a abrir el producto y sus 200 tonos.
2. **Lo tengo en la mano** → escanear barcode → variante exacta → al carrito, **sin abrir el selector**.
3. **La clienta quiere elegir** → tarjeta con `200 tonos · 152 disponibles` + **3 tonos relevantes**
   (recientes de esa vendedora, luego más vendidos) + `+197 tonos →`.

**Selector de tonos** (para 200+, y debe aguantar 400): buscador interno, pestañas
**Recientes (personales) / Más vendidos (tienda) / Todos**, filtros por familia de color, «Solo
disponibles», cuadrícula con **color + nombre + código + acabado + stock de esa variante**. Agotados
atenuados y no vendibles.

⚠️ **Regla de interacción crítica**: con 200 tonos la cuadrícula **no se cierra ni se reordena** al
seleccionar. La lista **se congela** al abrir o filtrar; cada toque **repinta solo esa casilla y el
pie**, nunca re-renderiza la rejilla; un render completo (cambio de filtro) **restaura el scroll**.
Existe **modo selección múltiple** con contadores y cierre en lote («Agregar 14 unidades»), pensado
para mayoristas que llevan 10–30 colores.

**Swatches**: se priorizan **fotos reales por variante** (un círculo plano no representa glitter,
cat-eye ni translúcido). Mientras no exista foto: **círculo + nombre + código + acabado**.

**Recientes**: persistente **por vendedora**, ventana **30 días**, máx. 12–20, orden por uso más
reciente. **Verificado: no hace falta tabla nueva** — se deriva de `sale_lines` + `sales`
(`seller_id`, `issued_at`, `variant_id`, `status='confirmed'`); los índices `sales_seller_idx` y
`sale_lines_variant_idx` ya existen.

**Carrito** fijo a la derecha, total siempre visible. **Cliente opcional** («Venta rápida / Sin
identificar» + «Asociar»); si la clienta viene de un canal, **el origen ya registrado se conserva** y
la vendedora no lo reescribe. Debe poder **cargar reservas y carritos pendientes**.

**Cobro — no preguntar lo que el sistema ya sabe:**
- **Un solo medio (Yape/Plin/transferencia/tarjeta)**: se asigna el 100% del total. Sin campo de
  monto, sin «los pagos cuadran», sin pendiente. Solo `✓ Yape · S/ 19.00` + **Confirmar**.
  Elegir el medio **nunca confirma solo**: siempre queda el último clic consciente.
- **Efectivo**: «Recibido» **precargado con el total** → entrega exacta también son dos toques.
  Botones rápidos calculados desde el total (Exacto · S/ 20 · S/ 50), sin saturar. Vuelto automático.
- **Dividir pago**: acción **explícita**. Al añadir un medio, **propone lo que falta**. Ahí sí se
  muestran asignado, restante, exceso y vuelto.
- **Exceso solo en efectivo** (se convierte en vuelto). Yape+Tarjeta por encima del total se bloquea:
  no hay forma de devolver por esos medios. *(Pendiente de confirmar por Ivan.)*
- **Sin flechas**: nada de `input type="number"` — los spinners estorban al teclear. `type="text"` +
  `inputmode="decimal"`, y aceptar **coma decimal** (`12,50`).
- **Doble cobro**: al confirmar, el botón se bloquea al instante y pasa a «Registrando venta…».
  El backend debe responder **idempotente** a la misma clave de venta.

**No mostrar aquí**: ventas del día, margen, gráficos, analítica, campañas, compras, tendencias.

**Teclado**: buscador enfocado al entrar · `Enter` agrega si el resultado es inequívoco · `Esc`
cierra paneles · el foco vuelve al buscador tras agregar · evitar modales innecesarios.

**Responsive**: escritorio = buscador izquierda + carrito fijo derecha. Móvil = productos primero y
barra fija `3 productos · S/ 56 → Ver venta`.

### 5.3 Nota de venta 80 mm

**Es una NOTA DE VENTA (`sale_document_kind = sale_note`), no una boleta.** El comprobante fiscal es
un módulo aparte (`tax_document_kind` + `tax_document_status`), como exigen las reglas 17 y 18 del
plan maestro. Lleva la **leyenda de documento interno** y el estado tributario
(«BOLETA SOLICITADA / Pendiente de emisión»). No imprimir nada que aparente ser un comprobante
autorizado por SUNAT.

**Formato**: 80 mm × alto automático (`@page { size: 80mm auto; margin: 0 }`), contenido a 72 mm,
**monoespaciado** para alinear importes, **negro puro sobre blanco** — sin grises, degradados,
bordes redondeados ni sombras: la térmica imprime un punto o nada.

**Compactación (criterio de aceptación)**: agrupar **por producto + precio aplicado**. Un esmalte con
25 tonos ocupa **un bloque**, no 25. Tres líneas por producto:

```
Esmalte Tradicional · Masglo · 13.5 ml
2× Abrumadora · 1× Bella
3 × S/ 7.80                       S/ 23.40
```

Los tonos fluyen con `·` y saltan solos. Probar con **1, 5, 20 y 50 variantes**: 50 deben caber en
~21 líneas de cuerpo. Sin SKU (Nivel 3, configurable y apagado). Sin acabado, salvo que dos tonos del
mismo producto se llamen igual. Ahorro mayorista **solo en el resumen final**, no por producto.

**Logo**: convertido a **1 bit** (gris → contraste → umbral ~190), 384 px de ancho. El logo original
con degradados y flores se convierte en barro en térmica.

**QR** de consulta real y funcional, generado desde el folio, **sin dependencias externas** (la nota
debe imprimir sin internet).

**RUC y dirección son marcadores** («por configurar»): salen de Administración → Organización. **No
se inventan** — un RUC falso impreso es exactamente lo que no debe pasar.

**Regla de datos**: **ninguna cifra se escribe a mano.** Importe = unidades × precio aplicado;
subtotal = suma de bloques; vuelto = efectivo − lo que faltaba cubrir. Escribirlas a mano ya produjo
dos errores reales (un vuelto de S/ 6.60 que eran S/ 4.60, y un Yape que cobraba S/ 4.20 de más).

---

## 6. Pendiente de confirmar con Ivan

1. **Radios.** El plan de Fase 0 propone 12/16/20; los prototipos aprobados usan 7/10. Ivan pidió
   *«sin exceso de curva»*. **Recomendación: 7/10**, y que él lo confirme mirando una pantalla.
2. **Rutas.** El plan dice «no se mueven rutas; Caja sigue en `/admin/caja`». La arquitectura que
   Ivan aprobó agrupa en **8 áreas** (Caja dentro de Ventas, Marketing fusionando campañas + canales
   + atribución). Se puede **agrupar en la navegación sin mover URLs** — pero hay que decidirlo
   explícitamente, no por omisión.
3. **Exceso en pago dividido**: hoy se bloquea si Yape/Tarjeta superan el total. ¿Hay casos reales
   donde acepten de más por Yape y devuelvan en efectivo?

## 7. Dato recién arreglado que afecta al POS

El **origen de una reserva** no se guardaba: el carrito sabía de dónde venía y lo soltaba al
convertirse. Arreglado en `0047_conversion_attribution.sql` (trigger sobre `public_carts`, 13
aserciones pgTAP). **Ya se almacena; todavía no se expone**: `reservation_detail` no lo devuelve y la
política RLS es *«admins read attributions»* — solo la dueña, no las vendedoras.

**Decisión necesaria al construir Ventas → Reservas**: ¿la vendedora ve de dónde llegó la clienta?
Recomendación: **sí** (le sirve para atender bien y no es dato sensible como costo o margen), lo que
exige ampliar la política o exponerlo por un contrato estrecho.
