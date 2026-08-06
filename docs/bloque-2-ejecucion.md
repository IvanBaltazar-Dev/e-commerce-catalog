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
