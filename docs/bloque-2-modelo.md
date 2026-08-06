# Bloque 2 — Modelo completo de la operación comercial interna

**Plan de desarrollo de la plataforma Bellaroshé**
**Rama:** `feature/bellaroshe-platform-v2`
**Fecha:** 2026-08-06
**Estado:** diseño previo a la primera migración

Este documento define el modelo íntegro de los dos frentes antes de escribir SQL. Las migraciones se separan por coherencia técnica, no por fases: el bloque se entrega como un conjunto operativo.

---

## 1. Punto de partida verificado

| Comprobación | Resultado |
|---|---|
| `0025`, `0026`, `0027` en `origin` | Sí · local y remoto en `c7cf9f2` |
| `db:reset` + `test:db` en el commit actual | 104 aserciones pgTAP · PASS |
| Precio y disponibilidad desde columnas V1 | **No.** `evaluate_cart_v2` lee `variant_prices` y `product_variants.availability_status` |
| Existencias físicas modeladas | **No existen.** Ninguna columna de cantidad en las 46 tablas |

**Consecuencia:** el inventario no se «reutiliza», se crea. Es la única pieza del Bloque 2 que no tiene precedente, y la comparten los dos frentes.

### Lo que se reutiliza sin duplicar

```
Organización   companies · branches · staff_branches · admin_profiles
Auditoría      audit_log  (trigger public.record_audit)
Proveedores    suppliers · supplier_contacts · supplier_branch_terms
               product_suppliers · supplier_cost_agreements · supplier_cost_tiers
               supplier_bonuses · exchange_rates
Catálogo       products · product_variants · variant_prices · price_lists · wholesale_rules
Predicados     is_admin · is_staff · is_seller · staff_branch_ids · default_branch_id
Contratos      evaluate_cart_v2 · resolve_variant_supply · exchange_rate
```

---

## 2. Reglas que gobiernan el diseño

Fijadas antes de modelar. Cada una tiene su mecanismo:

| Regla | Cómo se impone |
|---|---|
| La variante es la unidad vendible y comprable | Toda línea referencia `product_variants.id` |
| Toda operación guarda sede, usuario, fecha y hora | `branch_id not null`, `actor_id`, `occurred_at` en cada cabecera |
| La vendedora registra ventas desde el primer día | RLS por `staff_branch_ids()`, no por rol |
| La vendedora anula y devuelve sin aprobación previa | Sin estado de aprobación; motivo y auditoría obligatorios |
| Una venta confirmada nunca se elimina | Sin política `delete`; anulación es un registro nuevo |
| Una venta normal se confirma completamente pagada | Verificado dentro del RPC y por trigger diferido |
| Los pagos parciales son reservas o adelantos | `sales` no admite saldo; el saldo vive en `reservations` |
| Una reserva afecta disponibilidad, no existencia física | Mueve `reserved`, nunca `on_hand` |
| La existencia física cambia al confirmar venta, devolución aceptada o recepción | Únicos tres orígenes que escriben `on_hand` |
| La orden de compra no aumenta inventario; la recepción sí | La OC no genera movimiento |
| La devolución repone stock solo si vuelve vendible | `return_lines.condition = 'resellable'` |
| Precios, costos, totales y disponibilidad se resuelven en PostgreSQL | RPC atómicos; el navegador nunca calcula un importe |
| La vendedora no puede consultar costos ni márgenes | Los costos viven en **tablas separadas**, recortadas por RLS |
| La nota de venta es independiente del comprobante tributario | `sales` y `tax_document_requests` son módulos distintos |
| No crear tablas paralelas de inventario, auditoría, proveedores, sedes o usuarios | Una sola tabla por concepto |

---

## 3. Inventario — la pieza compartida

Dos tablas, con responsabilidades distintas y deliberadamente no fusionadas.

### `inventory_stock` — el saldo y el punto de bloqueo

```
(variant_id, branch_id)   clave primaria compuesta
on_hand      integer   existencia física
reserved     integer   comprometido por reservas vigentes
updated_at
```

`disponible = on_hand - reserved`, como columna generada. Un check impide `reserved > on_hand` y ambos negativos.

Es también **el punto de serialización**: toda operación que toque existencias hace `select … for update` sobre estas filas, ordenadas por `variant_id`, antes de decidir. Ahí se resuelve la carrera de dos vendedoras por la última unidad.

### `inventory_movements` — el kardex, de solo adición

```
variant_id · branch_id · movement_type · quantity (con signo)
balance_after · source_type · source_id · actor_id · actor_label
reason · occurred_at
```

Tipos: `sale`, `sale_cancelled`, `return_restock`, `receipt`, `adjustment`, `transfer_in`, `transfer_out`, `initial_load`.

Sin claves foráneas a `auth.users` ni a la operación de origen, aplicando la regla derivada de `0026`: **ninguna tabla de solo adición lleva claves foráneas**. El kardex debe sobrevivir al borrado de todo lo que menciona.

**Por qué dos tablas y no derivar el saldo del kardex:** derivar obliga a un `sum()` sobre todo el historial en cada lectura de catálogo, y no da una fila que bloquear. El saldo es el dato caliente; el kardex es la verdad histórica. `balance_after` permite auditarlos entre sí.

### `product_variants.tracks_inventory`

Se añade una columna: no todo lo vendible lleva existencias. Una variante en modalidad `consult`, un servicio o un pedido bajo encargo no descuentan stock.

**Punto de integración que hay que decidir explícitamente:** hoy `availability_status` es editorial. Con existencias reales, para variantes con `tracks_inventory = true` la disponibilidad efectiva pasa a ser función del stock. Eso obliga a tocar `catalog_list_v2` y `catalog_product_detail_v2`. Se hace en la migración de inventario, con pruebas de que el catálogo público sigue respondiendo igual cuando no hay stock cargado.

---

## 4. Frente 1 — Operación de venta

### Venta

`sales` — cabecera. Nace **confirmada**: la regla dice que una venta normal se confirma completamente pagada, así que no existe estado «pendiente». Estados: `confirmed` · `cancelled`.

```
branch_id · seller_id · seller_label · sale_number · issued_at
customer_name? · customer_phone? · customer_document?
channel (in_store | whatsapp | phone)      — las redes sociales son Bloque 3
subtotal · discount_total · total · currency
client_operation_id   idempotencia
```

`sale_lines` — con fotografía de lo vendido (SKU, nombre de producto, variante y marca, como ya hace `order_items`), `quantity`, `unit_price`, `discount`, `subtotal`, `purchase_mode`.

`sale_line_costs` — **tabla aparte**, con el costo unitario del momento y el margen. Separada por la misma razón que en proveedores: así la RLS por tabla basta para que la vendedora no vea márgenes, sin permisos por columna, que este repositorio no usa en ningún sitio.

### Pagos y vuelto

`sale_payments`: método (`cash` · `yape` · `plin` · `transfer` · `card`), `amount`, `tendered_amount` (solo efectivo), `reference`, `evidence_path`, `received_at`.

El vuelto **no se guarda como pago negativo**: se deriva de `tendered_amount - amount` en las líneas de efectivo. Un pago negativo contaminaría toda suma de cobranza.

Pago mixto = varias filas. La suma debe cubrir el total; lo verifica el RPC y lo garantiza un trigger diferido.

### Nota de venta y comprobante tributario

Son dos cosas distintas y el plan lo exige (regla 18).

La **nota de venta** es la propia venta con su correlativo, renderizada para impresora térmica de 80 mm o PDF. No es un documento fiscal y lleva su leyenda de documento interno.

`tax_document_requests`: `sale_id`, `kind` (`boleta` · `factura`), `status` (`not_requested` · `requested` · `pending_issue` · `issued_externally` · `declined`), datos del receptor, `requested_at`, `resolved_at`. **Nunca bloquea la venta.** La solicitud puede llegar después.

### Correlativo bajo concurrencia

`branch_document_counters` (branch_id, document_kind) con `next_number`, bloqueada con `select … for update` dentro de la misma transacción. Da numeración **contigua por sede**, que es lo que el negocio espera de una nota de venta, y es lo único que sobrevive a dos cajas simultáneas. Una `identity` global daría huecos por transacción abortada.

### Anulación

`sale_cancellations`: `sale_id` único, `reason_code`, `explanation` obligatoria, actor, sede, momento, evidencia opcional. La venta pasa a `cancelled` y **nunca se borra**. Genera movimiento `sale_cancelled` que repone existencias.

### Devolución y reembolso

`returns` (parcial o total) → `return_lines` (referencia a `sale_line_id`, `quantity`, `condition`) → `refunds` (método, importe, evidencia).

Solo `condition = 'resellable'` genera movimiento `return_restock`. Lo dañado se registra pero no vuelve al stock vendible.

### Reserva

`reservations` con cliente **obligatorio**, `expires_at`, estados `active` · `expired` · `released` · `converted` · `cancelled`.
`reservation_lines` con precio congelado al reservar.
`reservation_payments` para los adelantos; el saldo es derivado.

Al crear: `reserved += cantidad`. Al vencer o liberar: `reserved -= cantidad`. Al convertir en venta: `reserved -= cantidad` **y** `on_hand -= cantidad` en la misma transacción, con la venta apuntando a la reserva de origen. Ese es el «sin doble descuento» de la prueba crítica.

El vencimiento lo aplica `release_expired_reservations()`, invocable a mano y luego por tarea programada.

---

## 5. Frente 2 — Abastecimiento y egresos

### Orden de compra

`purchase_orders`: proveedor, **sede de destino**, estado (`draft` · `sent` · `partially_received` · `received` · `cancelled`), moneda, tipo de cambio de referencia, fecha esperada, totales.

`purchase_order_lines`: `product_supplier_id` **resuelto y congelado**, más `variant_id`, `purchase_units`, `pack_units`, `unit_cost` y moneda, todos fotografiados. Es la advertencia que dejó la Vertical 2: si la línea vuelve a resolver el costo después, el histórico de la compra cambiará el día que alguien registre un acuerdo nuevo.

**La OC no genera ningún movimiento de inventario.**

### Recepción

`goods_receipts`: `purchase_order_id` **opcional** —existe la compra directa sin OC—, proveedor, sede, actor, momento.

`goods_receipt_lines`: `variant_id`, `expected_units`, `received_units`, `bonus_units`, `condition`, `unit_cost` real.

- **Faltantes y diferencias** son derivados de `expected` contra `received`, más una nota de discrepancia. No son una tabla.
- **Bonificaciones recibidas** entran como unidades que suman existencias con costo cero, y bajan el costo efectivo por unidad recibida.
- Genera el movimiento `receipt`. **Es el único origen que aumenta existencias por compra.**

### Cuentas por pagar

`supplier_payments`: proveedor, referencia opcional a OC o recepción, importe, moneda, método, fecha, evidencia.

La **deuda** es una vista derivada (`supplier_balances`): recibido valorizado menos pagado. No se guarda un saldo desnormalizado que pueda divergir.

### Gastos

`expenses`: sede, categoría, importe, moneda, fecha, actor, descripción, evidencia, y recurrencia (`one_off` · `recurring`).

`expense_allocations`: imputa un gasto a una compra, a una recepción, a una venta o a nada (gasto general). Alcance excluyente con `num_nonnulls(...) = 1`, el mismo patrón de `wholesale_rules`.

### Costo efectivo recibido

Cuando existan importes reales —recepción más gastos imputados— se calcula el costo puesto en almacén. La Vertical 2 lo dejó deliberadamente fuera porque sin recepciones era una estimación presentada como hecho. Ahora hay de dónde sacarlo.

---

## 6. Los tres problemas difíciles

Todo lo demás es tabla y constraint. Esto es lo que decide si el bloque sirve.

**Concurrencia sobre la última unidad.** Toda operación que toca existencias abre transacción, bloquea las filas de `inventory_stock` con `for update` **ordenadas por `variant_id`** —el orden evita el interbloqueo cuando dos ventas comparten variantes—, valida, escribe y confirma. La segunda vendedora espera y recibe un error explícito, no un stock negativo.

**Doble confirmación.** `sales.client_operation_id` con índice único por sede. Un botón pulsado dos veces, o un reintento de red, devuelve la venta ya creada en lugar de duplicarla.

**Fallo a mitad de camino.** Toda operación de dinero o existencias es **un solo RPC**. No hay secuencias de llamadas desde la aplicación que puedan quedar a medias. Si algo falla, no queda nada.

---

## 7. Contratos SQL

Uno por operación completa, todos atómicos:

```
register_sale(...)                    venta + líneas + pagos + movimientos + correlativo
cancel_sale(sale_id, motivo, ...)     anulación + reposición
register_return(...)                  devolución + reembolso + reposición condicional
create_reservation(...)               reserva + adelanto + reserved
release_reservation(id, motivo)       liberación
convert_reservation_to_sale(id, ...)  conversión sin doble descuento
release_expired_reservations()        vencimiento masivo
issue_purchase_order(...)             OC con costos congelados
register_goods_receipt(...)           recepción + bonificaciones + movimientos
register_supplier_payment(...)        pago a proveedor
register_expense(...)                 gasto + imputación
adjust_inventory(...)                 ajuste con motivo obligatorio
```

Lecturas: `variant_availability(variant, branch)`, `sale_detail(id)`, `supplier_balances`, `daily_cash_summary(branch, fecha)`, `inventory_ledger(variant, branch, rango)`.

---

## 8. RLS y roles

| | Vendedora | Administración |
|---|---|---|
| Ventas, devoluciones, reservas de **sus** sedes | Leer y registrar | Todo, todas las sedes |
| `sale_line_costs`, márgenes | **Cero filas** | Completo |
| Existencias y kardex de sus sedes | Leer | Completo |
| Ajustes de inventario | No | Sí |
| Compras, recepciones, pagos a proveedor, gastos | **Cero filas** | Completo |
| Anular y devolver | Sí, sin aprobación, con motivo | Sí |

El recorte por sede usa `staff_branch_ids()`, estrenado en la Vertical 2. Las siete u ocho tablas con dinero o existencias entran en `audit_log` por el mismo bucle de `0025`.

---

## 9. Migraciones propuestas

Separadas por coherencia técnica; se desarrollan como un solo bloque.

| # | Contenido | Por qué va sola |
|---|---|---|
| `0028` | Inventario: `inventory_stock`, `inventory_movements`, `tracks_inventory`, integración con el catálogo público | Es la base de los dos frentes. Nada puede escribirse antes |
| `0029` | Ventas, líneas, costos por línea, pagos, correlativos, nota de venta, solicitud tributaria, reservas | El núcleo de caja |
| `0030` | Anulaciones, devoluciones y reembolsos | Depende de que exista la venta |
| `0031` | Compras, recepciones, cuentas por pagar | Frente 2; se apoya en proveedores y en inventario |
| `0032` | Gastos, imputación, costo efectivo y consultas operativas | Cierra el circuito económico |

La `0028` no estaba en tu agrupación de cuatro. Va separada porque tocar el catálogo público —`catalog_list_v2` y la disponibilidad— es un cambio de riesgo propio que conviene poder revertir sin arrastrar la caja.

---

## 10. Pruebas críticas

Sin batería por pantalla. Solo riesgo económico y de integridad:

1. Doble confirmación de una venta → una sola venta, un solo descuento.
2. Dos vendedoras contra la última unidad → una vende, la otra recibe error explícito.
3. Pago incompleto → la venta no se confirma.
4. Pago mixto con vuelto → total cuadra, el vuelto no ensucia la cobranza.
5. Fallo a mitad de operación → no queda venta, ni movimiento, ni correlativo consumido.
6. Anulación → el original sobrevive, el stock vuelve.
7. Devolución parcial → repone solo lo vendible.
8. Reserva vencida → libera `reserved`, no toca `on_hand`.
9. Conversión de reserva a venta → sin doble descuento.
10. Recepción parcial → aumenta solo lo recibido, la OC queda parcial.
11. Compra a crédito → deuda visible, pago parcial la reduce.
12. Vendedora consultando costos o márgenes → cero filas.
13. Numeración bajo concurrencia → sin duplicados ni huecos por sede.

---

## 11. Decisiones que necesitan tu confirmación

Tres, y cambian el modelo:

**a. Disponibilidad pública.** Al haber existencias reales, ¿el catálogo público debe mostrar `sold_out` automáticamente cuando `on_hand - reserved = 0`, o la propietaria conserva el control editorial y el stock solo se usa puertas adentro? Mi recomendación: automático para variantes con `tracks_inventory`, conservando `consult` como estado editorial intacto.

**b. Carga inicial de existencias.** Con 1.500 SKU y sin inventario previo, ¿el stock arranca en cero y se llena con recepciones, o hace falta un movimiento `initial_load` masivo desde una toma de inventario? Lo segundo exige una ruta de carga que hoy no existe.

**c. Descuento por línea o por venta.** El modelo contempla `discount` por línea y `discount_total` en la cabecera. ¿La vendedora descuenta por producto, sobre el total, o ambos? Afecta a la validación del precio mínimo permitido, que el Bloque 1 dejó anotado pero sin implementar.
