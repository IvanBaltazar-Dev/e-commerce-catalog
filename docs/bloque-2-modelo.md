# Bloque 2 — Modelo completo de la operación comercial interna

**Plan de desarrollo de la plataforma Bellaroshé**
**Rama:** `feature/bellaroshe-platform-v2`
**Fecha:** 2026-08-06 · **Revisión 2** (decisiones cerradas y ocho correcciones aplicadas)
**Estado:** diseño cerrado, previo a la primera migración y a la revisión arquitectónica

Las migraciones se separan por coherencia técnica, no por fases: el bloque se entrega como un conjunto operativo.

---

## 1. Punto de partida verificado

| Comprobación | Resultado |
|---|---|
| `0025`, `0026`, `0027` en `origin` | Sí · local y remoto en `c7cf9f2` |
| `db:reset` + `test:db` en el commit actual | 104 aserciones pgTAP · PASS |
| Precio y disponibilidad desde columnas V1 | **No.** `evaluate_cart_v2` lee `variant_prices` y `product_variants.availability_status` |
| Existencias físicas modeladas | **No existen.** Ninguna columna de cantidad en las 46 tablas |

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

| Regla | Cómo se impone |
|---|---|
| La variante es la unidad vendible y comprable | Toda línea referencia `product_variants.id` |
| Toda operación guarda sede, usuario, fecha y hora | `branch_id not null`, `actor_id`, `occurred_at` en cada cabecera |
| La vendedora registra ventas desde el primer día | RLS por `staff_branch_ids()`, no por rol |
| La vendedora anula y devuelve sin aprobación previa | Sin estado de aprobación; motivo y auditoría obligatorios |
| Una venta confirmada nunca se elimina | Sin política `delete`; anulación es un registro nuevo |
| Una venta normal se confirma completamente pagada | Verificado en el RPC y por trigger diferido |
| Los pagos parciales son reservas o adelantos | `sales` no admite saldo; el saldo vive en `reservations` |
| Una reserva afecta disponibilidad, no existencia física | Mueve `reserved`, nunca `on_hand` |
| La existencia física cambia al confirmar venta, devolución aceptada o recepción | Únicos orígenes que escriben `on_hand`, más la carga inicial y el ajuste |
| La orden de compra no aumenta inventario; la recepción sí | La OC no genera movimiento |
| La devolución repone stock solo si vuelve vendible | `return_lines.condition = 'resellable'` |
| Precios, costos, totales y disponibilidad se resuelven en PostgreSQL | RPC atómicos; el navegador nunca calcula un importe |
| La vendedora no puede consultar costos ni márgenes | Costos y valoración en **tablas separadas**, recortadas por RLS |
| La nota de venta es independiente del comprobante tributario | `sales` y `tax_document_requests` son módulos distintos |
| No crear tablas paralelas | Una sola tabla por concepto |

---

## 3. Inventario

### `inventory_stock` — saldo y punto de bloqueo

```
(variant_id, branch_id)   clave primaria compuesta
on_hand      integer   existencia física
reserved     integer   comprometido por reservas vigentes
updated_at
```

`disponible = on_hand - reserved` como columna generada. Checks: ninguno negativo, `reserved <= on_hand`.

Es **el punto de serialización**: toda operación que toque existencias hace `select … for update` sobre estas filas, **ordenadas por `variant_id`** —el orden evita interbloqueo cuando dos ventas comparten variantes—, valida, escribe y confirma.

### `inventory_movements` — kardex de solo adición

```
variant_id · branch_id            con FK restrictiva
variant_sku · variant_label · branch_label    fotografía legible
movement_type · quantity (con signo) · balance_after
source_type · source_id           polimórfico, sin FK
actor_id · actor_label            sin FK
reason · occurred_at
```

Tipos: `initial_load`, `sale`, `sale_cancelled`, `return_restock`, `receipt`, `adjustment`, `transfer_in`, `transfer_out`.

**Política de integridad referencial** (corrección F). El defecto de `0025` demostró que una tabla que rechaza `UPDATE` no puede tener FK con `on delete set null`. Eso **no** generaliza a «ningún libro histórico lleva FK»:

- `source_id` es polimórfico → sin FK, por construcción.
- `actor_id` → sin FK, con `actor_label` al lado. Los usuarios sí se borran.
- `variant_id` y `branch_id` → **con FK restrictiva**, más su fotografía textual. La integridad se conserva y la legibilidad no depende de que la fila siga existiendo.

La regla correcta es: **ninguna entidad referenciada por un libro histórico se elimina físicamente si su eliminación rompe la historia.** Variantes y sedes se desactivan.

> **Tensión que esto abre y hay que resolver en `0028`:** `products` cascadea a `product_variants`, y `scripts/cleanup-v2-test-data.mjs` borra productos en bloque. Con FK restrictiva desde el kardex, borrar un producto con movimientos fallará. Es el comportamiento correcto en producción, pero el script de limpieza necesita ajustarse para saltar variantes con historial o para operar solo sobre datos de prueba sin movimientos.

### `product_variants.tracks_inventory`

**Nace en `false` para todas las variantes existentes.** Es lo que impide que aplicar `0028` convierta 1.500 SKU en agotados. Se activa **únicamente** al cargar y validar la existencia inicial de esa variante.

### Disponibilidad efectiva — automática con control editorial

Resolución en este orden exacto, implementada en PostgreSQL y consumida por `catalog_list_v2` y `catalog_product_detail_v2`:

1. `availability_status = 'consult'` → **Consultar**, sin mirar el inventario.
2. `availability_status = 'sold_out'` → **Agotado**, aunque haya stock. El control editorial manda.
3. `availability_status = 'available'` **y** `tracks_inventory` **y** `on_hand - reserved <= 0` → **Agotado** automáticamente.
4. `tracks_inventory = false` → se conserva el estado editorial tal cual.

**Al público no se le muestra la cantidad**, solo la disponibilidad.

### `inventory_valuation` — costo de la mercadería vendida

Tabla **administrativa**, separada de `inventory_stock` porque la vendedora lee existencias pero nunca costos.

```
(variant_id, branch_id)
quantity_valued · average_unit_cost · currency · updated_at
```

**Promedio ponderado por variante y sede.** La cadena de costos queda así:

| Momento | Qué determina |
|---|---|
| Cotización de proveedor | Sirve para **decidir** una compra. No es costo |
| Recepción | Determina el costo real incorporado y **actualiza el promedio** |
| Valoración | Determina el costo de la mercadería **vendida** |
| Venta | Captura el promedio vigente en `sale_line_costs` |
| Devolución vendible | **Restaura el costo capturado en la línea original**, no el promedio actual |
| Carga inicial | Puede registrar costo inicial o marcarlo como desconocido |

Sin esto los márgenes serían técnicamente correctos y económicamente falsos: la mercadería comprada hace meses a otro costo se valoraría con la cotización de hoy.

### Carga inicial de existencias

No se arranca en cero simulando que la mercadería existente llegó por recepciones nuevas: eso falsearía el historial.

Importador administrativo (CSV/XLSX o script controlado) con **previsualización y confirmación**, reutilizando las guardas de ejecución local y remota de `scripts/lib/supabase-script-env.mjs`:

- identificación por SKU · sede · cantidad física · costo unitario inicial **opcional**;
- validación previa: rechaza SKU inexistente, duplicado o cantidad negativa;
- confirmación **atómica**;
- movimiento `initial_load` en el kardex;
- alimenta `inventory_valuation` cuando hay costo, o lo marca desconocido;
- **activa `tracks_inventory` solo para las variantes cargadas**.

---

## 4. Frente 1 — Operación de venta

### Venta

`sales` nace **confirmada**: una venta normal se confirma completamente pagada, así que no existe estado «pendiente». Estados: `confirmed` · `cancelled`.

```
branch_id · seller_id · seller_label · sale_number · issued_at
customer_name? · customer_phone? · customer_document?
source_channel · fulfillment_method
subtotal · discount_total · total · currency ('PEN')
client_operation_id   idempotencia
reservation_id?       origen, cuando viene de una reserva
```

**Canales** (corrección A). El origen y la entrega son ejes distintos: una venta puede originarse en Instagram y entregarse por delivery.

```
source_channel      in_store | web | whatsapp | facebook | instagram | tiktok | phone | other
fulfillment_method  in_store | pickup | delivery
```

El Bloque 2 registra el **origen mínimo**. Cuentas, conversaciones, mensajes, campañas y atribución completa siguen siendo Bloque 3.

**Moneda** (corrección H). Ventas y devoluciones en **PEN** inicialmente. Compras y proveedores admiten PEN o USD. **No se permite pago mixto entre monedas.** La columna `currency` existe para que la extensión posterior no exija migrar filas.

`sale_lines`: fotografía de lo vendido (SKU, producto, variante, marca), `quantity`, `unit_price`, `discount_amount`, `subtotal`, `purchase_mode`.

`sale_line_costs` — **tabla aparte**, con el costo unitario capturado de `inventory_valuation` al confirmar. Separada por la misma razón que en proveedores: la RLS por tabla basta para que la vendedora no vea márgenes, sin permisos por columna.

### Descuentos — una sola fuente de verdad

La pantalla admite descuento por línea **y** sobre el total. La base guarda **solo descuento por línea**:

- `sale_lines.discount_amount` es el descuento real de cada línea.
- `sales.discount_total` se **valida** como la suma exacta de las líneas, no como un dato independiente que pueda contradecirlas.
- Un descuento ingresado sobre el total lo **prorratea PostgreSQL** entre las líneas de forma determinista, con el residuo de redondeo asignado por una regla fija (a la línea de mayor subtotal, y a igualdad de subtotal por `id`) para que el resultado sea reproducible.

Así la devolución parcial calcula correctamente cuánto devolver, y márgenes y tributos quedan sin ambigüedad.

**Límite de descuento.** Restricción automática, no flujo de aprobación:

- administración puede autorizar descuentos extraordinarios;
- la vendedora tiene un límite configurable por porcentaje o monto;
- **nunca** un total negativo ni por debajo del mínimo que se defina más adelante.

### Pagos y vuelto

`sale_payments`: método (`cash` · `yape` · `plin` · `transfer` · `card` · `reservation_advance`), `amount`, `tendered_amount` (solo efectivo), `reference`, `evidence_path`, `received_at`.

El vuelto **no se guarda como pago negativo**: se deriva de `tendered_amount - amount` en las líneas de efectivo. Un pago negativo contaminaría toda suma de cobranza.

Pago mixto = varias filas, todas en la misma moneda. La suma debe cubrir el total.

### Correlativo bajo concurrencia

`branch_document_counters` (branch_id, document_kind) con `next_number`, bloqueada con `select … for update` en la misma transacción. Numeración **contigua por sede**, que es lo que el negocio espera de una nota de venta. Una `identity` global dejaría huecos por transacción abortada.

### Nota de venta y comprobante tributario

La **nota de venta** es la propia venta con su correlativo, para impresora térmica de 80 mm o PDF, con leyenda de documento interno. No es un documento fiscal.

`tax_document_requests` (corrección G): **la ausencia de fila significa «no solicitado»**. No se crea una fila vacía por venta. Estados:

```
requested · pending_issue · issued_externally · declined · cancelled
```

Nunca bloquea la venta; la solicitud puede llegar después.

### Anulación — existencias **y** dinero

`sale_cancellations`: `sale_id` **único** (impide una segunda anulación), `reason_code`, `explanation` obligatoria, actor, sede, momento, evidencia opcional.

Una anulación (corrección C):

1. conserva la venta original —nunca se borra ni se modifican sus pagos para fingir que no existieron—;
2. registra la cancelación;
3. revierte inventario con movimiento `sale_cancelled`;
4. **registra la devolución del dinero o la reversión del pago**;
5. queda impedida si ya existe una devolución sobre esa venta, salvo regla explícita que lo autorice.

### Devolución y reembolso

`returns` → `return_lines` (`sale_line_id`, `quantity`, `condition`) → `refunds`.

`refunds` tiene **origen excluyente**: `sale_cancellation_id` **XOR** `return_id`, con `num_nonnulls(...) = 1`, el patrón de `wholesale_rules`. Así el dinero devuelto tiene una sola causa identificable, venga de una anulación o de una devolución.

Solo `condition = 'resellable'` genera `return_restock` y **restaura el costo capturado en la línea original**. Lo dañado se registra sin volver al stock vendible.

### Reserva y traslado del adelanto

`reservations` con cliente **obligatorio**, `expires_at`, estados `active` · `expired` · `released` · `converted` · `cancelled`.
`reservation_lines` con precio congelado al reservar.
`reservation_payments` para los adelantos.

Existencias: al crear, `reserved += cantidad`. Al vencer o liberar, `reserved -= cantidad`. Al convertir, `reserved -= cantidad` **y** `on_hand -= cantidad` en la misma transacción.

**Traslado del adelanto** (corrección D). El adelanto no puede contarse dos veces como ingreso. Al convertir:

- cada `reservation_payments` aplicado genera una fila en `sale_payments` con método `reservation_advance` y `applied_from_reservation_payment_id` apuntando al pago original;
- esa fila conserva el `received_at` **original**, no el de la conversión, de modo que el arqueo diario cuenta el dinero el día que entró;
- el saldo por cobrar es `total - adelantos aplicados`, y se cobra con pagos nuevos en el momento de la venta;
- la venta solo se confirma cuando adelantos más pagos nuevos cubren el total.

Al cancelar una reserva, el adelanto se **reembolsa o se retiene** según política comercial, registrándolo explícitamente. No desaparece.

`release_expired_reservations()` aplica el vencimiento; invocable a mano y luego por tarea programada.

---

## 5. Frente 2 — Abastecimiento y egresos

### Orden de compra

`purchase_orders`: proveedor, **sede de destino**, estado (`draft` · `sent` · `partially_received` · `received` · `cancelled`), moneda (PEN o USD), tipo de cambio de referencia, fecha esperada, totales.

`purchase_order_lines`: `product_supplier_id` **resuelto y congelado**, `variant_id`, `purchase_units`, `pack_units`, `unit_cost` y moneda, todos fotografiados. Es la advertencia de la Vertical 2: si la línea reresolviera el costo, el histórico de la compra cambiaría al registrarse un acuerdo nuevo.

**La OC no genera ningún movimiento de inventario.**

### Recepción

`goods_receipts`: `purchase_order_id` **opcional** —existe la compra directa—, proveedor, sede, actor, momento.

`goods_receipt_lines`: `variant_id`, `expected_units`, `received_units`, `bonus_units`, `condition`, `unit_cost` real.

- Faltantes y diferencias son **derivados** de esperado contra recibido, con nota de discrepancia. No son tabla.
- Las bonificaciones entran como unidades con costo cero y **bajan el costo efectivo por unidad recibida**.
- Genera el movimiento `receipt` y **actualiza `inventory_valuation`** recalculando el promedio ponderado.

### Cuentas por pagar con asignación

Una vista «recibido menos pagado» no sobrevive a adelantos, varias recepciones, pagos que cubren varias compras, pagos parciales y monedas distintas (corrección E).

```
supplier_obligations
  supplier_id · origen (recepción o documento) · currency
  amount_due · due_date · estado derivado

supplier_payment_allocations
  supplier_payment_id · supplier_obligation_id · amount
```

`supplier_payments` registra el desembolso; las asignaciones lo reparten entre obligaciones. **Un pago sin asignar queda como anticipo o crédito a favor del negocio.**

La deuda se calcula **por moneda**. No se suman PEN y USD sin conversión explícita mediante `exchange_rate()`.

### Gastos

`expenses`: sede, categoría, importe, moneda, fecha, actor, descripción, evidencia, recurrencia (`one_off` · `recurring`).

`expense_allocations`: imputa a una compra, una recepción, una venta o a nada. Alcance excluyente con `num_nonnulls(...) = 1`.

### Costo efectivo recibido

Con recepciones reales más gastos imputados se calcula el costo puesto en almacén y se refleja en la valoración. La Vertical 2 lo dejó fuera porque sin recepciones era una estimación presentada como hecho. Ahora hay de dónde sacarlo.

---

## 6. Los tres problemas difíciles

**Concurrencia sobre la última unidad.** Bloqueo `for update` sobre `inventory_stock` ordenado por `variant_id`. La segunda vendedora espera y recibe un error explícito, no un stock negativo.

**Doble confirmación.** `sales.client_operation_id` con índice único por sede. Un botón pulsado dos veces devuelve la venta ya creada.

**Fallo a mitad de camino.** Toda operación de dinero o existencias es **un solo RPC**. No hay secuencias desde la aplicación que puedan quedar a medias.

---

## 7. Contratos SQL

```
register_sale(...)                    venta + líneas + descuentos prorrateados + pagos
                                      + costos capturados + movimientos + correlativo
cancel_sale(sale_id, motivo, ...)     anulación + reposición + reembolso
register_return(...)                  devolución + reembolso + reposición condicional
create_reservation(...)               reserva + adelanto + reserved
release_reservation(id, motivo)       liberación
convert_reservation_to_sale(id, ...)  conversión con traslado de adelanto, sin doble descuento
release_expired_reservations()        vencimiento masivo
issue_purchase_order(...)             OC con costos congelados
register_goods_receipt(...)           recepción + bonificaciones + movimientos + valoración
register_supplier_payment(...)        pago + asignación a obligaciones
register_expense(...)                 gasto + imputación
adjust_inventory(...)                 ajuste con motivo obligatorio
load_initial_inventory(...)           carga inicial atómica + activación de tracks_inventory
```

Lecturas: `variant_availability(variant, branch)`, `sale_detail(id)`, `supplier_balances_by_currency`, `daily_cash_summary(branch, fecha)`, `inventory_ledger(variant, branch, rango)`.

---

## 8. RLS y roles

| | Vendedora | Administración |
|---|---|---|
| Ventas, devoluciones, reservas de **sus** sedes | Leer y registrar | Todo, todas las sedes |
| `sale_line_costs`, `inventory_valuation`, márgenes | **Cero filas** | Completo |
| Existencias y kardex de sus sedes | Leer | Completo |
| Ajustes de inventario y carga inicial | No | Sí |
| Compras, recepciones, obligaciones, pagos a proveedor, gastos | **Cero filas** | Completo |
| Anular y devolver | Sí, sin aprobación, con motivo | Sí |

Recorte por sede con `staff_branch_ids()`. Todas las tablas con dinero o existencias entran en `audit_log` por el bucle de `0025`.

---

## 9. Migraciones propuestas

| # | Contenido | Por qué va sola |
|---|---|---|
| `0028` | `inventory_stock`, `inventory_movements`, `inventory_valuation`, `tracks_inventory`, resolución de disponibilidad efectiva, carga inicial, ajuste de `cleanup-v2-test-data` | Base de los dos frentes. Toca el catálogo público: riesgo propio, reversible por separado |
| `0029` | Ventas, líneas, costos por línea, descuentos prorrateados, pagos, correlativos, nota de venta, solicitud tributaria, reservas y traslado de adelantos | El núcleo de caja |
| `0030` | Anulaciones, devoluciones y reembolsos con origen excluyente | Depende de que exista la venta |
| `0031` | Compras, recepciones, obligaciones, pagos y asignaciones | Frente 2; se apoya en proveedores y en inventario |
| `0032` | Gastos, imputación, costo efectivo y consultas operativas | Cierra el circuito económico |

---

## 10. Pruebas críticas

1. Doble confirmación de una venta → una sola venta, un solo descuento.
2. Dos vendedoras contra la última unidad → una vende, la otra recibe error explícito.
3. Pago incompleto → la venta no se confirma.
4. Pago mixto con vuelto → total cuadra, el vuelto no ensucia la cobranza.
5. Fallo a mitad de operación → no queda venta, ni movimiento, ni correlativo consumido.
6. Anulación → el original sobrevive, el stock vuelve, el dinero se registra devuelto, la segunda anulación se rechaza.
7. Devolución parcial → repone solo lo vendible y restaura el costo de la línea original.
8. Reserva vencida → libera `reserved`, no toca `on_hand`.
9. Conversión de reserva a venta → sin doble descuento de stock **y sin doble conteo del adelanto**.
10. Recepción parcial → aumenta solo lo recibido; la OC queda parcial; el promedio ponderado se recalcula.
11. Compra a crédito → obligación visible, pago parcial la reduce, pago sin asignar queda como anticipo.
12. Vendedora consultando costos, valoración o márgenes → cero filas.
13. Numeración bajo concurrencia → sin duplicados ni huecos por sede.
14. Aplicar `0028` sobre el catálogo actual → **ninguna variante pasa a agotada** (`tracks_inventory` nace en `false`).
15. Descuento sobre el total → prorrateo determinista; `discount_total` igual a la suma de líneas al céntimo.
16. Deuda con dos monedas → se reporta por moneda, sin sumar PEN y USD.

---

## 11. Decisiones cerradas

| Tema | Decisión |
|---|---|
| Disponibilidad pública | Automática **con** control editorial, en el orden de cuatro reglas de §3. Sin mostrar cantidad |
| `tracks_inventory` | Nace en `false`; se activa solo tras cargar y validar la existencia inicial |
| Carga inicial | Toma física masiva con `initial_load`, no simulación de recepciones |
| Descuentos | Una sola fuente de verdad: por línea. El total se prorratea en PostgreSQL |
| Límite de descuento | Restricción automática por rol, sin flujo de aprobación |
| Canales | `source_channel` y `fulfillment_method` separados |
| Costo de lo vendido | Promedio ponderado por variante y sede en `inventory_valuation` |
| Reembolsos | Origen excluyente: anulación **o** devolución |
| Adelantos | Se trasladan a la venta conservando su fecha original; nunca se cuentan dos veces |
| Cuentas por pagar | Obligaciones más asignaciones; deuda por moneda |
| Integridad del kardex | FK restrictiva a variante y sede, con fotografía textual; sin FK a actor ni a origen polimórfico |
| Solicitud tributaria | Sin estado `not_requested`: la ausencia de fila lo representa |
| Moneda de venta | PEN inicialmente, sin pago mixto entre monedas, diseño extensible |
