# La carta de tonos pública

Sustituye el selector de variantes de la ficha pública cuando el eje de la
variante es el color. Antes: 164 fotografías de frascos con el nombre debajo.
Ahora: una carta de colores con buscador, familias cromáticas y el tono elegido
siempre visible.

Criterio de terminado, re-ejecutable:

```bash
npm run test:tone-picker
```

Comprueba escritorio (1440×900) y móvil (375×812) **con emulación de
dispositivo**, y deja capturas en `test-results/`.

---

## Por qué la foto del envase no sirve dentro de la rejilla

No es una preferencia estética: se midió. Las 157 imágenes de tonos de Masglo
son fotografías completas del frasco, 720×1086, con tapa azul, etiqueta y
reflejos del vidrio. Los 164 tonos comparten exactamente eso —lo único que NO
los distingue— y dentro de un círculo de 35px el color del esmalte queda
reducido a unos pocos píxeles.

Tampoco vale deducir el color de la foto: el promedio de esa imagen devuelve el
azul de la tapa o el blanco de la etiqueta. El color se **registra** una vez en
`color_shades.reference_color` y se reutiliza. La migración `0051` es
exactamente eso: sacar ese valor al contrato público, que hasta ahora se lo
guardaba.

La fotografía no desaparece. Pasa a donde sirve: el área grande de producto,
donde **confirma** el tono elegido. No es forma de navegar entre 164 opciones.

## Prioridad de representación

1. **Textura real** del esmalte aplicado (rol de medio `swatch`), para glitter,
   tornasol, perlado o cat-eye, que un HEX plano no representa.
2. **Color registrado** del tono (`reference_color`).
3. **Tinte de la familia cromática**, marcado en pantalla como *color
   referencial* — nunca presentado como el color real.

### Cuándo un `swatch` cuenta como textura

Hoy las ocho filas con rol `swatch` son fotografías del envase subidas como
imagen única de su variante. De ahí la regla, que no depende de corregir datos a
mano:

> Un `swatch` cuenta como textura **solo si la variante tiene además otra foto**.
> Si es su única imagen, esa imagen está haciendo de foto de producto: es el
> envase.

Resultado: hoy la rejilla es color puro. El día que se suba un recorte real
junto a la foto del frasco, la rejilla lo usa sin tocar código.

## Cuándo se usa la carta y cuándo la lista

La carta gana su sitio porque **quita los nombres**. Eso solo es una mejora si
hay color que mirar. Dos condiciones:

1. El eje es el color (≥80% de las variantes con tono o familia cromática, y al
   menos 8 variantes).
2. Hay color que mostrar: algún tono con color registrado, **o** más de una
   familia cromática.

| Producto | Variantes | Color registrado | Selector |
|---|---|---|---|
| Esmalte MASGLO | 164 | 157 | **carta** |
| Esmalte ADMISS | 75 | 0, familia única | lista |
| Gel Evolution (demo) | 3 | — | lista |

Admiss es el caso que fija la regla: 75 círculos grises idénticos sin nombre
serían peores que la lista, que al menos da nombre, código y precio. En cuanto
se registren sus colores, la carta aparece sola.

## Decisiones de interacción

- **Un toque = seleccionar.** Actualiza tono, código, foto grande, precio y
  disponibilidad a la vez. Sin modal y sin «confirmar tono». Después solo queda
  cantidad → agregar: los 3 pasos del plan maestro.
- **Elegir no mueve la carta.** Ni scroll ni reordenación. Cambiar de filtro sí
  devuelve la rejilla al principio: son resultados nuevos.
- **Al abrir, la rejilla se coloca sobre el tono elegido**, para que el tono que
  llega por enlace no quede fuera de la ventana.
- **Sin peticiones al servidor al cambiar de tono.** El enlace compartible se
  actualiza con `history.replaceState`. Antes, elegir un tono reescribía la URL,
  el efecto de carga se reejecutaba y la ficha volvía a descargar las 164
  variantes con sus precios y medios **en cada clic**.
- **Nombre sin gastar una línea.** El recuento de la cabecera cede su hueco al
  nombre del tono apuntado. En móvil no hay apuntar: tocar ya selecciona, y el
  pie muestra el nombre.
- **Teclado.** Una sola parada de tabulador entre 164 tonos; las flechas
  recorren la carta y la selección sigue al foco.
- **El color no es la única señal.** Nombre, código, familia, acabado y estado
  viajan siempre en el nombre accesible de cada casilla.

## Filtro de acabado

Se dibuja solo si el producto tiene más de un acabado cargado. Hoy **ninguna
variante del catálogo tiene `finish_type`**, así que el control no aparece: un
filtro «Acabado» que no puede filtrar nada es una pantalla que miente. Se
encenderá solo el día que se registren.

Los códigos de tono ya llevan la pista (`TRA-BRI-*` escarchados, `TRA-FOT-*`
fotocromáticos, `TRA-VISOS-*`), pero deducir el acabado de un prefijo sería
inventar dato: se carga en `finish_type` o no existe.

## Huecos de dato conocidos

| Hueco | Alcance | Efecto hoy |
|---|---|---|
| 7 tonos de Masglo sin color registrado ni familia | `Ajena`, `Audaz`, `Escarcha Dorado`, `Escarcha Plateado`, `Granizado Dorado`, `Inclusiva`, `Inconfundible` | salen con tinte referencial y rayado, y el pie lo dice |
| 75 tonos de Admiss sin ningún color | producto entero | usa la lista, no la carta |
| `finish_type` sin cargar | catálogo entero | sin filtro de acabado |
| Rol `swatch` sobre fotos de envase | 8 variantes | no se usan como textura |
