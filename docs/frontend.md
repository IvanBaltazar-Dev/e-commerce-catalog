# Frontend aprobado y reglas de experiencia

Este documento reúne las decisiones visuales y de interacción vigentes. No describe una maqueta histórica: fija el contrato que cualquier implementación nueva debe respetar.

## Sistema visual

### Paleta

```text
Superficie  --ground #F3EFEB   --surface #FFFFFF
            --surface-2 #F8F4F1   --hover #FBF6F8
Texto       --ink #241621   --ink-2 #4A3A43   --ink-3 #6B5A64
Línea       --line #E8E0E3  --line-2 #DBD0D5
Acento      --rose #D3348A  --rose-deep #B02470  --rose-wash #FBE9F2
Dominios    --plum #7A3768   --gold #A9762E   --green #3E7150
            --teal #3C6E86   --clay #9A6242
Severidad   --crit #C0392B   --imp #CF7C2A   --low #CFA22B
```

El rosa es acento, no fondo dominante. Los colores de dominio son apagados y los estados semánticos no se expresan como variantes del rosa.

### Tipografía y forma

- Familia: Manrope.
- Título de pantalla: 30–40 px, peso 500.
- Cifra protagonista: 32–42 px, peso 700; una sola por pantalla.
- KPI: 22–26 px, peso 600.
- Secciones y etiquetas: 11–11,5 px, tracking `0.07–0.10em`.
- Cuerpo: 12,5–16 px, peso 400.
- Todo número usa `font-variant-numeric: tabular-nums`.
- Radio de controles: 6–7 px; tarjetas: 10 px; píldora solo para chips/badges.
- La profundidad se logra con superficie y borde. Sombra fuerte solo en overlays.

## Reglas transversales

1. Un dato tiene un solo dueño visual por pantalla; una acción crítica sí puede repetirse.
2. Una semana es lunes a domingo. Inicio compara la última semana cerrada contra la anterior y muestra fechas concretas.
3. Comparaciones de dinero se expresan en soles, no en puntos porcentuales.
4. El lenguaje es comercial: “Ganancia bruta”, “por agotarse”, “Quitar”, “Vaciar venta”, “Cancelar reserva” y “Anular venta” no son sinónimos.
5. Quitar una línea no pide confirmación; vaciar o abandonar trabajo sí explica qué se pierde y qué se conserva.
6. El mayorista se calcula por producto sumando variantes y usa `products.wholesale_min_quantity`; nunca se codifica “desde 3”.
7. Nivel 1 muestra producto, marca, presentación, cantidades, precio e importe; SKU e IDs son nivel 3 y permanecen ocultos por defecto.
8. Propietaria entra a Inicio; vendedora entra a Nueva venta con el buscador enfocado.
9. La navegación se agrupa en ocho áreas sin mover las URL existentes.

## Inicio de propietaria

Orden fijo:

1. saludo, fecha y cuatro KPI: Venta hoy, Ganancia bruta hoy, Cobrado hoy y Atención;
2. Meta de hoy y Necesita tu atención, con cada alerta enlazada a su acción;
3. seis accesos rápidos;
4. Lo que funcionó la semana pasada.

Una sparkline y una barra de meta bastan. Inicio resume; el módulo dueño explica.

## Ventas y POS

La búsqueda es el camino principal y resuelve tres velocidades:

- buscar producto, marca, línea, tono, código, SKU o barcode y devolver la variante directa;
- escanear el artículo físico y agregar la variante exacta;
- explorar un producto con muchos tonos.

El selector debe soportar al menos 400 tonos, con Recientes, Más vendidos, Todos, familia de color y Solo disponibles. La cuadrícula se congela mientras se selecciona: no se cierra, reordena ni pierde scroll. La selección múltiple agrega en lote.

Las fotos reales de variante son el swatch preferido. Sin foto, mostrar color de referencia junto con nombre, código y acabado; nunca sustituir con otra variante.

El carrito permanece visible en escritorio y se resume en una barra fija móvil. La clienta es opcional y el origen previamente atribuido no se reescribe.

### Cobro

- Un solo medio no pide monto: asigna el total y espera un último clic consciente.
- Efectivo precarga el total, ofrece montos rápidos y calcula vuelto.
- Dividir pago es una acción explícita y propone el saldo faltante.
- El exceso solo se acepta en efectivo; Yape, tarjeta o transferencia por encima del total se bloquean.
- Los importes usan texto con `inputmode="decimal"` y aceptan coma decimal.
- El botón se bloquea al confirmar y el backend responde de forma idempotente.

Venta, analítica, campañas y compras no se mezclan en la misma superficie.

## Nota de venta térmica

- Es nota interna, no boleta ni factura.
- Papel 80 mm, contenido de 72 mm, alto automático, negro puro sobre blanco y tipografía monoespaciada.
- Agrupar por producto + precio aplicado; 50 variantes deben ocupar aproximadamente 21 líneas de cuerpo.
- Mostrar ahorro mayorista una sola vez en el resumen.
- Logo convertido a 1 bit; QR generado sin dependencia externa.
- RUC y dirección salen de Organización; nunca se inventan.
- Toda cifra se deriva de la venta, pagos y líneas canónicas.

## Rendimiento e interacción

- Todas las búsquedas cumplen [el gate de menos de tres segundos](calidad-y-riesgos.md).
- El foco vuelve al buscador después de agregar; `Enter` agrega un resultado inequívoco y `Esc` cierra paneles.
- Evitar modales y rerenders de rejillas grandes.
- Desarrollo usa Turbopack; la revisión de experiencia se hace también en el build aislado de prototipo.
- `npm run test:admin-nav` recorre las rutas autenticadas y evita cargas iniciales duplicadas.

## Decisión abierta localizada

El origen de una reserva ya se conserva desde `0047_conversion_attribution.sql`, pero su lectura para vendedoras requiere un contrato estrecho o una política adicional. La recomendación es mostrarlo en Reservas porque ayuda a atender y no revela costo o margen; debe cerrarse junto con esa pantalla.
