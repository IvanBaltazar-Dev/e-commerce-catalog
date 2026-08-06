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
