# Bloque 2 — Registro de ejecución

**Rama:** `feature/bellaroshe-platform-v2`
**Propósito:** dejar por escrito lo que se decidió **al escribir cada migración**, cuando la base contradijo al modelo o cuando el modelo dejaba una elección abierta.

`docs/bloque-2-modelo.md` quedó congelado en su revisión 2 y no se reescribe. Este documento es su continuación operativa: cada entrada dice qué se encontró, qué se eligió y contra qué se comprobó.

---

## 0029 — ventas, pagos, correlativos y reservas

### Decisiones tomadas al escribirla

**A · El contexto de seguridad de los RPC de caja es `SECURITY DEFINER`.**

El anexo §12/0029-9 daba por verificado que `register_sale` *podía* ser `SECURITY INVOKER`. Comprobado contra la base local, **no puede**: la primera sentencia de `apply_inventory_movement` es un `insert` sobre `inventory_stock`, cuya única política de escritura es `admins manage stock`, así que una vendedora aborta con

```
ERROR: new row violates row-level security policy for table "inventory_stock"
```

antes de llegar a la venta. Las dos salidas eran abrir política de escritura de existencias a toda vendedora —lo que le permitiría alterar saldos desde PostgREST sin pasar por ningún RPC— o mover la frontera de confianza al RPC. Se eligió la segunda, que es la que §12/0029-10 ya tenía prevista:

- `register_sale`, `create_reservation`, `release_reservation`, `release_expired_reservations` y `request_tax_document` son `DEFINER` con revalidación explícita de sede en `assert_branch_access()`;
- `apply_inventory_movement` pasa a `DEFINER` y se le **revoca `EXECUTE` a `anon` y a `authenticated`**: ya no es alcanzable por su nombre, solo a través de los contratos de dominio;
- `adjust_inventory` y `load_initial_inventory` pasan a `DEFINER` conservando su guarda `is_admin()`;
- el bloque de costo de `sale_detail` se recorta **además** por rol (`case when public.is_admin()`), porque dentro de un `DEFINER` las políticas no se evalúan y la RLS sola no protegería el valor de retorno.

**Hueco heredado que esto cierra:** el `revoke … from public` de 0028 no retiraba nada a `anon` ni a `authenticated`. El ACL por defecto de Supabase concede `EXECUTE` a los tres roles sobre toda función nueva del esquema `public` —verificado con `has_function_privilege('anon', …) = true` sobre `apply_inventory_movement`, `adjust_inventory` y `load_initial_inventory`—. Un visitante anónimo del catálogo podía mover el inventario llamando al RPC por su nombre. 0029 añade los `revoke` explícitos y una aserción pgTAP que falla si alguno vuelve a quedar abierto.

**B · Lo que no se sigue, no se mueve.**

Una variante con `tracks_inventory = false` no tiene existencia que descontar: su venta **no genera asiento de kardex** y su costo queda `unknown`. Sin esta regla ninguna venta sería registrable hasta terminar la carga inicial, que §3 declara gradual por diseño. La fila de `sale_line_costs` se crea igualmente, con `cost_basis = 'unknown'`, para que el hueco sea consultable en lugar de confundirse con un margen del 100 %.

**C · La conversión de una reserva vende los precios congelados.**

§4 dice que `reservation_lines` congela el precio al reservar. Volver a evaluar el carrito al convertir haría que un cambio de tarifa alterara lo pactado y que las cantidades dejaran de cuadrar con lo ya comprometido en `reserved`. Cuando `register_sale` recibe `p_reservation_id`, las líneas salen **siempre** de `reservation_lines` y `p_lines` se ignora.

**D · `ON DELETE` distinguiendo las dos clases de referencia.**

- Referencia al **documento** (`sale_id`, `reservation_id`) → `cascade`, igual que `order_items.order_id` en 0007. Lo que el modelo prohíbe es vaciar una venta dejando la cabecera con total y cero líneas; borrar la cabecera entera no produce ese estado. Además, `restrict` volvía el borrado **imposible**: obliga a quitar los pagos primero, y entonces el trigger diferido rechaza una venta con total y cobranza cero.
- Referencia al **catálogo** (`variant_id`) → `restrict` más fotografía textual, que es la regla de §3 sobre libros históricos.

**E · Idempotencia con candado consultivo, no solo con índice único.**

`unique (branch_id, client_operation_id)` no basta: sin serializar antes, dos peticiones simultáneas del mismo botón **ya han descontado inventario** cuando la segunda muere contra el índice. `register_sale` y `create_reservation` abren con `pg_advisory_xact_lock` sobre la operación y reconsultan. Reproducido y verificado en `scripts/test-sales-concurrency.mjs`.

**F · `orders` retirada.**

Cero filas, nunca desplegada. `sales` la sustituye con más alcance. Se retiran la tabla, `order_items` y `create_admin_order`; la aserción de 0024 sobre `orders.branch_id` pasa a `sales.branch_id`, que es donde vive hoy el concepto.

### Defecto encontrado por las pruebas

`assert_sale_fully_paid()` y `assert_sale_discount_matches_lines()` resolvían la venta afectada con un `coalesce` de dos ramas:

```sql
coalesce(
  case tg_table_name when 'sales' then coalesce(new.id, old.id) end,
  case tg_table_name when 'sale_payments' then coalesce(new.sale_id, old.sale_id) end
)
```

PL/pgSQL resuelve **todos** los operandos de una misma expresión contra el registro real, así que el trigger colgado de `sales` abortaba con `record "new" has no field "sale_id"` y **ninguna venta podía confirmarse**.

Lo importante es *por qué* no lo vio la suite pgTAP: los triggers `DEFERRABLE INITIALLY DEFERRED` disparan al `COMMIT`, y todo archivo pgTAP termina en `ROLLBACK`. El defecto era estructuralmente invisible para esa suite. Lo encontró `scripts/test-sales-concurrency.mjs`, que usa sesiones reales que sí confirman.

Se corrigió con ramas explícitas y se cerró el hueco en las dos direcciones: la suite pgTAP ahora fuerza `set constraints all immediate` (aserciones 49 y 50), de modo que la validación diferida queda cubierta también ahí.

### Cómo se verifica

| Comprobación | Cómo |
|---|---|
| Estructura, RLS, costos, prorrateo, reservas | `npm run test:db` · 50 aserciones en `0029_sales.test.sql` |
| Doble confirmación, última unidad, numeración, reserva concurrente | `npm run test:sales-concurrency` · sesiones reales |
| La vendedora cobra desde la pantalla y no ve costos | `npm run test:sales-ui` |
| Flujo administrativo completo | `npm run test:admin-flow` |

`npm run seed:demo-operation` deja el entorno local con propietaria, vendedora, sede asignada y existencia inicial cargada por el contrato oficial —no por `INSERT` directo—, que es lo que permite que la verificación visual signifique algo.

---

## Nota sobre la numeración

§9 del modelo asignaba `0030` a las anulaciones y `0031` a las compras. Se aplicaron al revés —`0030_purchasing_core`, `0031_returns_and_cancellations`— porque las dos se escribieron en paralelo y dos migraciones con el mismo número rompen el reset con `duplicate key` sobre `schema_migrations_pkey`. El orden no importa funcionalmente: las devoluciones dependen de las ventas (`0029`) y las compras de proveedores (`0027`) e inventario (`0028`), y ninguna de las dos depende de la otra.

---

## 0030 — compras, recepciones, obligaciones y pagos a proveedor

### Defecto encontrado y corregido

Los tres contratos —`issue_purchase_order`, `register_goods_receipt`, `register_supplier_payment`— nacieron `SECURITY INVOKER`, escritos contra el estado del repositorio anterior a `0029`. Desde `0029` el punto único de escritura de inventario dejó de ser alcanzable por `authenticated`, así que una recepción invocada desde PostgREST abortaba con:

```
ERROR: permission denied for function apply_inventory_movement
CONTEXT: SQL statement "SELECT public.apply_inventory_movement(…)" 
         PL/pgSQL function public.register_goods_receipt(…) line 118 at PERFORM
```

Ninguna recepción podía entrar al sistema. Se corrigió pasando los tres a `DEFINER` —su guarda `is_admin()` ya era explícita, así que el cambio no amplía a quién alcanzan— y revocándolos también a `anon`, por el mismo agujero del ACL por defecto de Supabase que `0029` cerró para el inventario.

La aserción 8 de `0030_purchasing.test.sql` recorre `pg_proc` y falla si alguno vuelve a quedar `INVOKER`.

### Cómo se verifica

30 aserciones: la orden de compra no mueve inventario ni deja asiento; la recepción parcial aumenta solo lo recibido y deja la orden en `partially_received`; el promedio ponderado se recalcula con el costo real; la bonificación del mismo artículo baja el costo efectivo a 8,0000 en lugar de fabricar un promedio falso; una recepción en moneda extranjera sin tipo de cambio falla con error explícito y con él se incorpora convertida a soles; la deuda se reporta por moneda; el pago sin asignar queda como anticipo; la sobre-asignación se rechaza; y la vendedora obtiene cero filas de todo el frente.

---

## 0031 — anulaciones, devoluciones y reembolsos

### Decisiones tomadas al escribirla

**A · La reversión del costo vive en el kardex, no en una tabla nueva.**

§12/0030-5 exige reponer valor con el costo capturado en `sale_line_costs` y «revertir esas filas de COGS». Revertirlas reescribiendo `sale_line_costs` destruiría la captura, que es justo lo que esa tabla existe para conservar. El asiento contrario se escribe donde `0028` puso las columnas monetarias precisamente para esto: `inventory_movements`, con `unit_cost` y `value_delta`. El COGS neto es una resta —la calcula `sale_margin()`—, no una segunda fuente de verdad.

**B · Lo devuelto se repone valorado primero.**

Una salida consume antes las unidades sin valorar (regla de `0028`). Al volver, se restituyen antes las valoradas, hasta agotar las que esa línea llevaba. Es la única forma de que devolver todo lo vendido deje la valoración exactamente como estaba.

**C · Una línea mixta genera dos asientos.**

`apply_inventory_movement` valora una entrada entera o ninguna. Reponer 10 unidades de las que 6 tenían costo y 4 no, con un solo asiento, obligaría a inventar un costo medio para las 4 o a perder el de las 6.

**D · Una reserva vencida o liberada sí puede cancelarse.**

No tiene nada comprometido que devolver, pero su adelanto sigue en caja: `cancel_reservation` conserva el estado y registra la salida de dinero. Solo se rechaza sobre una reserva ya convertida, donde lo que corresponde es anular la venta.

### Verificación numérica que da sentido a todo esto

Recibir 10 @ 10,00 · vender 10 · recibir 10 @ 30,00 · anular:

| | Al promedio vigente | Al costo capturado |
|---|---|---|
| Valor del inventario tras anular | 600,00 | **400,00** |
| Dinero realmente desembolsado | 400,00 | 400,00 |

La aserción 13 fija el resultado correcto y falla con 200,00 de diferencia si alguien vuelve a leer el promedio del día.

### Cómo se verifica

32 aserciones: la venta anulada sobrevive con sus líneas; el stock y el valor vuelven al costo capturado; el dinero se registra devuelto por el importe exacto cobrado; la segunda anulación se rechaza; lo vendible vuelve al stock y lo dañado no; devolver todo reparte el subtotal al céntimo sin residuo; no se devuelve más de lo vendido; el reintento de una devolución no repone de más; las dos direcciones prohibidas —anular lo devuelto y devolver lo anulado— se rechazan; el adelanto de una reserva cancelada se reembolsa con origen propio; y la vendedora no puede calcular márgenes.

---

## 0032 — gastos, arqueo, traslados y lote de carga inicial

28 aserciones. Lo que la suite fija por escrito:

- **La caja no bloquea la venta.** `record_cash_movement` devuelve nulo cuando no hay sesión abierta en lugar de abortar. Obligar a abrir caja para poder vender rompería la operación, y el arqueo del día no depende de que alguien recordara abrirla.
- **El gasto en efectivo sale del cajón, y su anulación lo devuelve.** Un gasto se corrige anulándolo con motivo, nunca con un `UPDATE`.
- **El traslado entre sedes conserva el valor.** Es la única operación que toca dos filas del mismo `variant_id`, y por eso el orden de candados es `(variant_id, branch_id)` y no solo la variante: 40 unidades a 9,00 repartidas entre dos sedes siguen valiendo 360,00, porque la entrada al destino usa el costo con el que salió del origen.
- **El lote de carga inicial es idempotente** y activa `tracks_inventory` solo de lo cargado, con asiento `initial_load` —no simulando una recepción, que falsearía el historial—.

## 0033 — las dos lecturas operativas que faltaban

§7 lista cinco lecturas. Tres ya existían: `variant_effective_availability` (0028), `sale_detail` (0029) y `supplier_balances` (0030). Faltaban `daily_cash_summary` e `inventory_ledger`, y no eran cosméticas: sin ellas el arqueo diario y el kardex consultable solo existían como texto.

### Hueco de seguridad que esta migración cierra

`0028` concede a `authenticated` `select` de **tabla completa** sobre `inventory_movements` —el personal necesita ver el historial de su propio stock—, y esa tabla lleva `unit_cost`, `value_delta` y `value_after`. Una vendedora podía leer el costo de cada asiento con una sola consulta a PostgREST: exactamente lo que §8 declara en cero filas para ella.

La RLS no recorta columnas, y un `GRANT` por columna tampoco sirve porque no distingue a la administradora de la vendedora —las dos son `authenticated`—. La única forma correcta es cerrar las columnas monetarias a la tabla y servirlas por un objeto `DEFINER` que sí sabe quién pregunta. Eso hace `inventory_ledger`, y la ruta `/api/admin/inventory/kardex` pasa a consumirlo en lugar de leer la tabla.

### El arqueo se deriva de los documentos, no del cajón

`cash_movements` solo se escribe cuando hay caja abierta. Un arqueo construido sobre esa tabla reportaría cero en cualquier día en que nadie la abrió, con el dinero realmente cobrado. `daily_cash_summary` se deriva de los documentos de dinero y **reconcilia** contra el cajón, que es lo que vuelve visible el descuadre en lugar de esconderlo.

Y el adelanto se cuenta una sola vez: el efectivo del día sale de `reservation_payments` más `sale_payments` con `method <> 'reservation_advance'`; las filas de adelanto trasladado se listan aparte por `applied_at`. Las aserciones 8, 9 y 10 fijan las tres mitades: hoy entran 20,00 de saldo, el adelanto de 10,00 se lista como conciliación y no como ingreso, y el arqueo de ayer sí lo cuenta.

## Interferencia entre pruebas, corregida

`test-sales-concurrency` apagaba `tracks_inventory` de su variante en la teardown en lugar de restaurar el valor previo. Tras `seed:demo-operation` esa variante llega con seguimiento activo, así que la prueba siguiente vendía una presentación sin existencias que descontar y su fallo parecía un defecto del producto. Ahora la teardown restaura el estado que encontró.

En la misma línea, `0029_sales.test.sql` usa una sede propia en vez de la principal: sus aserciones declaran números de nota absolutos («la primera de la sede es `NV-000001`») y sobre la sede compartida dependían de cuántas ventas dejara antes cualquier otra prueba. La numeración es contigua **por sede**, así que aislarla es la forma correcta de comprobarla.

---

## 0034 — el cajón se alimenta del dinero

### Defecto encontrado por la prueba integral

`record_cash_movement` (0032) declara en su propio comentario que «se invoca desde los contratos de venta, reembolso, pago a proveedor y gasto», y el enumerado `cash_movement_kind` ya reservaba los cuatro valores. Pero solo `register_expense` y `void_expense` lo llamaban: **ninguna venta, ningún reembolso y ningún pago a proveedor llegaba nunca al cajón**.

No es cosmético. `close_cash_session` calcula el efectivo esperado sumando `cash_movements` de la sesión, así que cerraba una caja con 60,00 esperados cuando el cajón tenía 131,25 de ventas reales, y declaraba una diferencia de **71,25**. Ese descuadre se atribuye a quien atendió, que es exactamente lo que el modelo repite que no puede pasar.

### Por qué un trigger y no una llamada en cada contrato

Colgar el aviso de cada RPC lo deja a merced de que nadie lo olvide en el siguiente, y ya se olvidó en tres. El cajón se alimenta de las **tablas** de dinero —`sale_payments`, `reservation_payments`, `refunds`, `supplier_payments`—, que están cerradas a escritura directa: cualquier contrato futuro que cobre o pague queda registrado sin hacer nada.

Dos exclusiones explícitas: el adelanto **trasladado** a una venta (`method = 'reservation_advance'`), porque ese dinero entró el día de la reserva y ya se contó entonces; y el dinero cuya fecha propia es anterior a la apertura de la sesión, que es captura de una operación pasada y no un billete que entre hoy al cajón.

---

## Prueba integral del Bloque 2

`npm run test:block2` ejecuta el circuito económico completo por los **contratos reales**, con una sesión de administración autenticada —no con `service_role`, que se salta las guardas—:

orden de compra → recepción parcial → recepción con bonificación → obligación → pago parcial al proveedor → apertura de caja → venta con descuento y pago mixto → reserva con adelanto → conversión → venta anulada → devolución parcial → gasto → traslado entre sedes → arqueo → cierre de caja.

Y después **concilia**, que es lo que el modelo pedía en «Mejoras posteriores» y ninguna prueba anterior hacía:

| Invariante | Qué descarta |
|---|---|
| `on_hand` y `total_value` de toda fila reconstruidos desde el kardex | Que la valoración derive de la existencia sin dejar rastro |
| Costo capturado en las ventas = valor que salió del kardex | Un COGS inventado o perdido |
| Valor de la sede = suma de su kardex | Valor creado o destruido por una operación |
| Ninguna venta descuadrada, ningún descuento inventado, ninguna línea sobre-devuelta | Que una sola operación rompa una invariante que las demás mantienen |

La prueba **limpia lo que dejó la ejecución anterior** antes de empezar: declara importes absolutos, y acumular ejecuciones producía tres obligaciones idénticas y una asignación que superaba lo exigible.

## Las pruebas ya no dependen del estado que encuentran

Toda la batería corre ahora sobre una base recién reiniciada **o** sobre una base ya operada, y dos veces seguidas, con el mismo resultado. Las suites que fallaban al segundo intento lo hacían por tres motivos, todos corregidos:

- **Sede compartida.** Las aserciones declaran existencias y correlativos absolutos («la primera nota de la sede es `NV-000001`»). Cada suite usa ahora su propia sede: la numeración es contigua *por sede*, así que aislarla es la forma correcta de comprobarla.
- **Precondición heredada.** Varias suites daban por hecho que una variante llegaba sin seguimiento de inventario, cosa que deja de ser cierta en cuanto alguien carga su existencia inicial. Ahora cada fixture **declara** la precondición que necesita.
- **Recuento global.** `0028` comprobaba la prueba crítica 14 contando variantes con seguimiento activo, lo que solo vale sobre una base virgen. Pasa a comprobar el **defecto de la columna**, que es donde vive de verdad esa garantía.

El acceso al panel en las pruebas de navegador se reintenta en lugar de esperar un tiempo fijo: el formulario es un componente cliente y, si se pulsa Enviar antes de que React hidrate, el navegador envía el `form` de forma nativa —`GET /admin/login?` en el log— y la redirección no ocurre. Con el servidor de desarrollo frío ninguna espera fija es suficiente; el segundo intento corre sobre una ruta ya compilada.

---

## La aplicación web del Bloque 2

Cinco secciones del panel, recortadas por rol:

| Sección | Quién entra | Qué resuelve |
|---|---|---|
| **Ventas** `/admin/ventas` | vendedora y administración | Venta con descuento, pago mixto y vuelto derivado; reserva con adelanto; conversión y liberación |
| **Caja** `/admin/caja` | vendedora y administración | Apertura, movimientos y cierre con arqueo |
| **Inventario** `/admin/inventario` | vendedora y administración | Existencias por sede y kardex; la vendedora lo ve **sin una sola cifra de costo** |
| **Compras** `/admin/compras` | solo administración | Orden de compra, recepción con bonificación y dañadas, deuda por moneda y pago a obligaciones |
| **Gastos** `/admin/gastos` | solo administración | Gasto con imputación y anulación registrada |

La vendedora entra al panel desde el Bloque 2 —la caja es suya— y la barra le ofrece solo lo que puede operar. Las pantallas administrativas se cortan además en el servidor con `requirePanelRole`, para que escribir la URL a mano lleve a su sección y no a un error.

**Ningún importe se calcula en el navegador.** Precio, modalidad mayorista, descuento prorrateado, costo capturado, promedio ponderado, deuda y arqueo los resuelve PostgreSQL; la pantalla declara qué pasó y muestra lo que la base decidió.

Verificado sobre el build de producción con sesión real: las cinco secciones renderizan y cargan sus datos, la vendedora ve su kardex sin costos, y la pantalla de compras emite una orden real (`OC-2026-00001`, S/ 90,00, estado `sent`) que queda en la base.
