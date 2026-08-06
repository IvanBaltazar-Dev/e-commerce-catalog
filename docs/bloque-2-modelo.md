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

Es **el punto de serialización**, con tres precisiones que el panel obligó a corregir porque la redacción anterior era falsa:

1. **El primer contacto es un `upsert`, no un `for update`.** Un `select … for update` sobre un par (variante, sede) que todavía no existe bloquea **cero filas** y no serializa nada —verificado—. Toda operación abre con `insert … on conflict (variant_id, branch_id) do update set on_hand = s.on_hand + excluded.on_hand returning *`. Nunca `on conflict do nothing` sobre un acumulador de saldo. El `for update` solo es válido **después** de garantizar la existencia de la fila.
2. **El orden es `(variant_id, branch_id)`, no `variant_id`.** La clave primaria es compuesta, así que ordenar solo por variante no es orden total: dos operaciones sobre la misma variante en dos sedes se interbloquean con `40P01`.
3. **Orden global de candados:** primero `inventory_stock`, después `branch_document_counters`. Nunca al revés. Tomar el correlativo al final acorta además la retención del registro más contendido de la sede.

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
3. `availability_status = 'available'` **y** `tracks_inventory` **y** disponible ≤ 0 → **Agotado** automáticamente.
4. **En cualquier otro caso** —incluido `tracks_inventory = false` y el caso mayoritario de disponible positivo— se conserva el estado editorial tal cual.

**Al público no se le muestra la cantidad**, solo la disponibilidad.

Tres precisiones obligatorias que el panel verificó:

- **Debe vivir en un objeto `SECURITY DEFINER`.** `catalog_list_v2`, `catalog_product_detail_v2` y `evaluate_cart_v2` son `SECURITY INVOKER` (`prosecdef = f`, comprobado) y las invoca `anon`, que leería **cero filas** de `inventory_stock`. La resolución no puede inlinearse en ellas: va en `variant_effective_availability`, propiedad de `postgres`, devolviendo **únicamente** el enum `product_availability` y nunca la cantidad. Es el patrón exacto de `is_public_catalog_variant` (`prosecdef = t`). **No se abre política de lectura de `inventory_stock` a `anon`.**
- **`evaluate_cart_v2` también es consumidor.** Sin corregirlo, una variante con seguimiento y cero unidades devolvería `available` con precio firme, desactivando la única guarda de agotado que hoy existe en la base y mandando ese precio al mensaje de WhatsApp.
- **Agregación por sede:** el catálogo público no tiene sede, así que suma sobre las sedes con `branches.is_active`, y el par ausente cuenta como cero: `coalesce(sum(on_hand - reserved), 0)`.

Los puntos de sustitución en `0006` son **cuatro**, no uno: el predicado de `p_availability` en `filtered_products`, el lateral de `availabilitySummary`, `featuredVariant`, y `'availability', variant.availability_status` en el detalle. Si el filtro sigue leyendo el estado crudo, «Disponible» devuelve tarjetas agotadas y los totales de paginación mienten.

### `inventory_valuation` — costo de la mercadería vendida

Tabla **administrativa**, separada de `inventory_stock` porque la vendedora lee existencias pero nunca costos.

```
(variant_id, branch_id)
quantity_valued  integer
total_value      numeric(16,6)   <- fuente de verdad
average_unit_cost                <- columna GENERADA: total_value / quantity_valued
currency · updated_at
```

**El valor total es autoritativo; el promedio es presentación.** Acumular sobre el promedio ya redondeado produce una deriva sin cota: simulados 200 ciclos de recepción y venta, la divergencia contra el valor real llega a S/ 0,48, y a escala de 2 decimales sobre 4.000 movimientos supera los S/ 3.000. Toda operación suma o resta **valor**.

Dos invariantes:

- `(quantity_valued = 0) = (total_value = 0)` — si la existencia llega a cero y el valor conserva un residuo, la siguiente recepción nace con un promedio contaminado que se propaga indefinidamente.
- `quantity_valued` y `total_value` nunca negativos.

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

Pago mixto = varias filas, todas en la misma moneda. **La suma debe ser exactamente igual al total, no «cubrirlo».** «Cubrir» admite sobrecobro invisible: S/ 100 en Yape por una venta de S/ 90 deja S/ 10 que no son vuelto, ni adelanto, ni saldo a favor —y al anular se devuelven 90—. El exceso físico en efectivo es vuelto y se representa con `tendered_amount`; cualquier otro exceso es un error de captura.

`sale_payments` gana también `applied_at` —cuándo se aplicó a esta venta— junto a `received_at` —cuándo entró el dinero—. El arqueo diario suma por `received_at`; sin esa distinción, un adelanto de enero reaparecería en el arqueo de febrero.

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

La prohibición es **en ambas direcciones**. `sale_cancellations.sale_id` único impide la segunda anulación, y toda devolución exige la precondición `sales.status = 'confirmed'`: los dos únicos estados de la venta existen precisamente para que ese predicado sea escribible. Sin la segunda mitad, una venta de S/ 100 podía pagar S/ 190 en reembolsos.

### Devolución y reembolso

`returns` → `return_lines` (`sale_line_id`, `quantity`, `condition`) → `refunds`.

`refunds` tiene **origen excluyente entre tres**, no entre dos: `sale_cancellation_id`, `return_id` o `reservation_id`, con `num_nonnulls(...) = 1`. La versión de dos columnas dejaba **inconstruible** el reembolso del adelanto de una reserva cancelada, que no es venta ni devolución.

`refunds` declara además **método de pago y moneda**, con el mismo enumerado que `sale_payments`. Sin método, el arqueo no puede restar el efectivo que sale del cajón y el descuadre acabaría atribuido a la vendedora.

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

Recorte por sede con `staff_branch_ids()`.

**Auditoría.** Decir «por el bucle de `0025`» es inexacto: aquel bucle es un `do $$` de una sola ejecución sobre un arreglo literal, no un *event trigger*. **Cada migración cuelga sus propios triggers.** Se añade `attach_audit(regclass)` idempotente y una prueba pgTAP que declare la lista de tablas de dinero y existencias y falle si a alguna le falta, para que olvidar una deje de ser silencioso.

Se aprovecha para cerrar un hueco de `0027`: **`exchange_rates` no tiene ningún trigger de auditoría** —comprobado—, y una tasa cambia la deuda reportada. La RLS sí la protege (`admins manage exchange rates`; verifiqué que una vendedora modifica cero filas), pero un cambio hecho por administración no deja rastro.

Se excluyen del bucle `inventory_stock` —saldo derivado cuyo histórico es el kardex, y auditarlo alargaría la sección crítica del candado más contendido— e `inventory_movements`, que ya es de solo adición por diseño.

**Ninguna política de `update` ni `delete`** sobre las tablas de dinero: `sale_payments`, `reservation_payments`, `refunds`, `supplier_payments`, `expenses`. Toda corrección se hace por reversión registrada. El precedente está en `0025`/`0026`.

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

---

## 12. Anexo — registro de correcciones de la revisión arquitectónica

**Panel del 2026-08-06 sobre el commit `8895981`.** Seis lentes intentaron romper el modelo; un escéptico por lente trató de refutar sus bloqueantes.

**54 hallazgos · 16 propuestos como bloqueantes · 0 sobrevivieron la refutación.**

> **Veredicto: el modelo aguanta.** Ninguno de los 16 bloqueantes propuestos sobrevivió: todos fueron degradados porque su remedio cabe íntegramente dentro de una migración aún no escrita, sobre tablas que aún no existen, sin una sola fila que migrar.
>
> **Pero «sin bloqueantes» no significa «se implementa el texto literal».** Las correcciones de este anexo son obligatorias. Las que corregían una afirmación falsa de la especificación ya están aplicadas en el cuerpo del documento; el resto se resuelve al escribir cada migración.

### 0028 — inventario, valoración y disponibilidad efectiva

1. PUNTO DE SERIALIZACIÓN (hallado por dos lentes). `select … for update` sobre un par (variante, sede) inexistente devuelve cero filas y no bloquea nada. La primera sentencia de todo RPC que toque existencias debe ser un upsert: `insert into inventory_stock as s (variant_id, branch_id, on_hand) values (…) on conflict (variant_id, branch_id) do update set on_hand = s.on_hand + excluded.on_hand returning *`. Con esa forma la carrera se serializa correctamente sobre la fila ausente (saldo 20 = kardex 20, verificado). Reescribir la frase de §3: el FOR UPDATE solo es válido después de garantizar la existencia. NUNCA `on conflict do nothing` sobre un acumulador de saldo.

2. ORDEN DE BLOQUEO. `order by variant_id` no es orden total: la PK es (variant_id, branch_id). Dos operaciones sobre la misma variante en dos sedes producen deadlock 40P01 (reproducido). Cambiar §3 y la implementación a `order by variant_id, branch_id for update`.

3. ORDEN GLOBAL DE CANDADOS. Declarar en §3: primero inventory_stock (ordenado por variant_id, branch_id), después branch_document_counters, nunca al revés. Una venta y una devolución simultáneas en la misma sede se interbloquean hoy (reproducido). Tomar el correlativo al final acorta además la retención del registro más contendido de la sede.

4. record_audit() (hallado por tres lentes). Antes de colgar ningún trigger: (a) `affected_record_id := (new_json->>'id')::uuid` aborta con 22P02 si el kardex usa `bigint generated always as identity` — TODO insert del kardex fallaría; (b) inventory_stock e inventory_valuation tienen PK compuesta y ninguna columna `id`, así que record_id queda NULL y el índice audit_log_record_idx no sirve para ellas; (c) la sede sale de `default_branch_id(actor)`, no de la fila, así que una operación multi-sede se atribuye a la sede principal y con actor NULL (service_role en la carga inicial) inventa la predeterminada. Decidir: uuid en toda tabla auditada, o `record_key text` + cast tolerante, o excluir inventory_movements del bucle por ser ya libro de solo adición. Y preferir `coalesce((new_json->>'branch_id')::uuid, (old_json->>'branch_id')::uuid, default_branch_id(actor))`. Exigir actor explícito en load_initial_inventory cuando auth.uid() sea NULL.

5. AUDITORÍA COMO MECANISMO. El «bucle de 0025» es un `do $$` de una sola ejecución sobre un array literal, sin event trigger: cada migración debe colgar su propio trigger. Añadir `attach_audit(regclass)` idempotente y una prueba pgTAP que declare la lista de tablas de dinero/existencias y falle si a alguna le falta. Aprovechar para colgar el que falta a `exchange_rates` (hoy sin auditoría, y `authenticated` tiene UPDATE y DELETE sobre ella: cambiar una tasa reescribe la deuda reportada sin rastro).

6. DISPONIBILIDAD PÚBLICA (hallado por tres lentes). catalog_list_v2, catalog_product_detail_v2 y evaluate_cart_v2 son SECURITY INVOKER (prosecdef=f, verificado) y las invoca `anon`, que no tiene rolbypassrls. La resolución de cuatro reglas NO puede inlinearse en ellas. Implementarla en `variant_availability` como SECURITY DEFINER propiedad de postgres, devolviendo ÚNICAMENTE el enum public.product_availability y nunca la cantidad (§3: «al público no se le muestra la cantidad»), con execute a anon — el patrón de is_public_catalog_variant (prosecdef=t). No abrir política de lectura de inventory_stock a anon.

7. AGREGACIÓN POR SEDE. §3 escribe «on_hand - reserved <= 0» sin decir sobre qué filas, y el catálogo público no tiene ni puede tener sede (auth.uid() es nulo para anon; default_branch_id y staff_branch_ids son inservibles ahí). Fijar por escrito: se suma sobre las sedes con branches.is_active y el par ausente cuenta como 0 (`coalesce(sum(on_hand - reserved), 0)`). Sin esa frase la respuesta pública queda decidida por accidente de implementación el día que se abra la segunda sede.

8. CUATRO PUNTOS DE SUSTITUCIÓN EN 0006, NO DOS. Además del resumen: el predicado de `p_availability` en filtered_products (L62-71), el lateral que construye availabilitySummary (L181-189), featuredVariant (L195) y `'availability', variant.availability_status` en el detalle (L403). Si el filtro sigue leyendo el estado crudo, «Disponible» devuelve tarjetas agotadas y totalItems/totalPages mienten — y lo mismo el generador de PDF, que usa el mismo p_availability.

9. evaluate_cart_v2 ES CONSUMIDOR. §3 no lo lista. Sin corregirlo, una variante con seguimiento y cero unidades devuelve `availability: available`, unitPrice firme y unresolvedLines 0, lo que desactiva la única guarda de agotado que hoy existe en la base (create_admin_order rechaza `sold_out`) y manda precio firme al mensaje de WhatsApp.

10. REGLA 4 DE §3. Redactarla como cierre del CASE: el caso mayoritario (available + tracks_inventory + saldo positivo) no satisface ninguna de las cuatro condiciones tal como están escritas.

11. ESCALA Y VALOR DE inventory_valuation. §3 no declara tipo para ninguna columna. La deriva del promedio redondeado es función exclusiva de la escala: -3.002,78 sobre 1,34 M a 2 decimales en 4.000 movimientos frente a +0,94 (0,00007%) a 6 decimales. Fijar la escala en el DDL y, preferentemente, añadir `total_value numeric(16,6)` como número autoritativo con average_unit_cost derivado; toda operación suma o resta VALOR y el redondeo es solo de presentación.

12. CARGA INICIAL SIN COSTO. Decidir el marcador explícito antes de escribir el DDL: ausencia de fila en inventory_valuation (el idioma que §4/§11 ya usan para tax_document_requests, verificado correcto: 100 unidades sin costo + recepción de 50 @ 20,00 → 50 unidades a 20,000000 exacto) o `quantity_unvalued integer not null default 0` con el invariante quantity_valued + quantity_unvalued = on_hand. NUNCA cero: fabrica un costo inexistente (6,6667 en lugar de 20,00). Añadir checks de no negatividad a inventory_valuation — impiden por sí solos el estado corrupto de promedio negativo y el division_by_zero posterior.

13. KARDEX CON MONTOS. inventory_movements no guarda ningún dato monetario, así que no puede producir un kardex valorizado ni reconstruir el promedio. Añadir unit_cost, value_delta y value_after numeric(16,6). Al ser tabla de solo adición, convierten el kardex en la fuente reconstruible y hacen total_value verificable como suma de value_delta.

14. CANDADO DE LA VALORACIÓN. inventory_valuation queda fuera del punto de serialización declarado y tiene escritores que no tocan existencias (imputación de gasto, correcciones de costo). Regla del bloque: toda escritura a inventory_valuation adquiere primero el for update de la fila (variant_id, branch_id) de inventory_stock.

15. adjust_inventory CON RESERVAS. Con on_hand 10 y reserved 8, un ajuste de -5 por rotura es imposible de registrar: el check `reserved <= on_hand` lo aborta con un 23514 crudo y el sistema queda obligado a mentir. Definir el comportamiento: liberar reservas en orden determinista (expires_at asc) con su movimiento y motivo `stock_perdido` hasta restablecer el invariante, o fallar con error de negocio explícito. Es el comportamiento faltante de un contrato ya listado en §7, no una función nueva.

16. adjust_inventory Y LA VALORACIÓN. §3 no define qué hace el ajuste con el promedio. Si solo toca on_hand, quantity_valued y on_hand divergen de forma permanente y la recepción siguiente calcula 15,0000 donde lo correcto es 16,6667 (error del 10% en todo el COGS posterior). El ajuste consume o incorpora valor al promedio vigente y nunca deja quantity_valued distinto de on_hand.

17. occurred_at. `now()` es transaction_timestamp(): con el candado retenido durante todo el RPC, el kardex leído en orden cronológico muestra balance_after 10 → 8 → 9 (reproducido). Usar clock_timestamp() y ordenar inventory_ledger por la identidad monótona del asiento; documentar que occurred_at es informativo y la secuencia es la autoridad.

18. source_label. El kardex da fotografía al actor (actor_label) pero no al origen polimórfico, que puede apuntar a seis tablas sin FK. Añadir `source_label text` poblado al insertar (NV-001-000042, REC-2026-0007, o el motivo cuando no hay documento). Aprovechar para añadir `branch_label` a audit_log, asimetría heredada de 0026.

19. VISTAS. Una vista sin `with (security_invoker = true)` corre como su propietario (postgres) y publica la tabla entera a cualquier authenticated (reproducido: 2 filas de valoración con el costo). §7 no dice cuáles de las cinco lecturas son vistas. Declararlo, y añadir una aserción pgTAP que recorra pg_class (relkind='v') en public y falle si alguna no tiene security_invoker=true.

20. BORRADO DE PRODUCTOS. Trigger `before delete on product_variants` que levante excepción de dominio con el SKU en el mensaje cuando existan movimientos, para que las seis rutas de borrado fallen legiblemente en vez de con 23503 crudo nombrando product_variants. Ajustar `scripts/cleanup-v2-test-data.mjs` (excluir del select las variantes con movimientos y reportarlas al final) y el rollback compensatorio del importador en `src/lib/admin/catalog-import-service.ts:885 y :888`, que hoy quedaría sin poder revertir una importación fallida.

21. COLUMNAS V1 DEL PANEL. products.unit_price, wholesale_price y availability se siguen leyendo en /admin/productos (PRODUCT_SELECT → ProductListView.tsx:283) y se reescriben en cada guardado V2 (catalog-v2-service.ts:507-510). Tras 0028 un producto será «Disponible» en el panel y «Agotado» en el público a la vez. Decidir: que la lista muestre la disponibilidad efectiva, o `comment on column` declarándolas legado no autoritativo y quitarlas de la pantalla como estado. Corregir además la fila de §1, que afirma más de lo que es cierto.

22. PRUEBAS. La prueba 14 pasa trivialmente (tracks_inventory nace en false) y da confianza falsa: no cubre el instante en que se carga la primera sede. Añadir: (a) resolver disponibilidad bajo `set role anon` con stock positivo → available; (b) activar tracks_inventory en una sola sede no cambia la disponibilidad pública de las demás; (c) filtrar por «Disponible» un producto con todas sus variantes automáticamente agotadas → 0 items y totalItems=0.

### 0029 — ventas, pagos, correlativos y reservas

1. ON DELETE EXPLÍCITO en sale_lines y sale_line_costs. No confiar en el defecto: escribir la cláusula. El precedente correcto en este repo para un libro de líneas es order_items (`on delete set null` + fotografía textual, verificado), que preserva sku, nombres, subtotal y costo capturado al borrar el producto y deja el arqueo cuadrado; la alternativa es `restrict`, que aborta. Lo que no puede quedar es `cascade`, que sí vacía una venta confirmada dejando la cabecera con total y cero líneas.

2. CONVERSIÓN DE RESERVA (hallado por dos lentes). Escribir la transición como guarda: `update reservations set status='converted' where id=$1 and status='active'` con aborto si ROW_COUNT=0, ANTES de tocar inventario. Bajo READ COMMITTED PostgreSQL reevalúa el predicado tras liberar el candado (EvalPlanQual) y serializa gratis: con guarda → 1 venta, on_hand 5→4, reserved 3→2, status converted; sin guarda → 2 ventas, el mismo adelanto contado dos veces y `reserved` robado a otra clienta. Mismo patrón en release_reservation y release_expired_reservations.

3. CINTURÓN Y TIRANTES DE LA RESERVA. `unique (reservation_id) where reservation_id is not null` sobre sales, y `unique (applied_from_reservation_payment_id) where not null` sobre sale_payments — sin este último el mismo adelanto puede aplicarse a dos ventas, que es exactamente lo que la corrección D dice evitar y lo que la prueba 9 declara probar sin constraint que lo garantice.

4. IDEMPOTENCIA EN reservations. client_operation_id + `unique (branch_id, client_operation_id)`, con el RPC intentando el INSERT de la cabecera primero y devolviendo la fila existente ante unique_violation. §11 no cierra ninguna decisión que restrinja la idempotencia a las ventas.

5. CONFIRMACIÓN DE PAGO. «La suma debe cubrir el total» permite sobrecobro invisible (S/100 por una venta de S/90 en Yape: los S/10 no son vuelto, ni adelanto, ni saldo a favor, y al anular se devuelven 90). Validar `sum(amount) = total` exacto; el exceso físico solo vive en tendered_amount. Añadir checks `tendered_amount is null or tendered_amount >= amount` y `tendered_amount is null or method = 'cash'` para que el vuelto derivado no salga negativo.

6. ARQUEO Y ADELANTOS. Conservar el received_at original hace que el arqueo del 05-ene devuelva 80,00 en febrero si daily_cash_summary no filtra, y ese filtro no está escrito en ninguna parte. Añadir `applied_at timestamptz not null default now()` a sale_payments y fijar por escrito la regla de lectura: el efectivo del día sale de reservation_payments más sale_payments con method <> 'reservation_advance'; los traslados se listan aparte por applied_at como conciliación.

7. LÍMITE DE DESCUENTO. §4 lo exige «configurable» y no hay dónde vivir: admin_profiles no tiene ninguna columna de límite y §9 no lista tabla de configuración. Añadir max_discount_percent / max_discount_amount (nullable) a admin_profiles. Es una columna, no un módulo de configuración.

8. sale_line_costs SIEMPRE. Entre 0029 y el fin de la carga inicial (gradual por diseño) se venden variantes sin fila de valoración. register_sale debe crear siempre la fila con `cost_status ('valued'|'unvalued')` y unit_cost nulo cuando no hay valoración, para que el hueco sea consultable («cuántas ventas no tienen costo») en vez de confundirse con margen del 100%. Ni cero, ni fallo de la venta, ni NULL silencioso.

9. CONTEXTO DE SEGURIDAD DE CADA RPC. El documento no contiene la palabra «definer» en sus 406 líneas. Declarar en §7 el contexto de las trece RPC. Verificado que register_sale PUEDE ser SECURITY INVOKER: con lectura admin-only (FOR SELECT USING is_admin()) y escritura de staff (FOR INSERT WITH CHECK is_staff()) la vendedora inserta el costo y sigue leyendo cero filas —un INSERT sin RETURNING no requiere SELECT—, y la lectura de la valoración puede vivir en un trigger AFTER INSERT definer, que PostgreSQL prohíbe invocar como función.

10. SI ALGUNA RPC ES DEFINER. Dentro de definer las políticas no se evalúan (aunque staff_branch_ids() y auth.uid() sí siguen resolviendo correctamente): repetir la revalidación explícita que create_admin_order ya trae de 0024 (`if not exists (select 1 from staff_branch_ids() …) then raise 42501`), que además cubre el caso del perfil sin asignaciones al que `coalesce(p_branch_id, default_branch_id())` le entregaría la sede principal. Y: RETURNS con columnas nombradas una a una, prohibido to_jsonb(fila) y select *, más una aserción pgTAP que recorra pg_proc y falle si un tipo de retorno alcanzable por una vendedora contiene unit_cost, average_unit_cost, quantity_valued o cualquier columna de margen.

11. MENSAJES DE ERROR. Un 23514 sobre inventory_valuation imprime la fila completa en el DETAIL, incluido average_unit_cost, y `src/lib/api/http.ts:41-42` más `catalog-v2-service.ts:16` lo reenvían literalmente al navegador. Validar antes de escribir y envolver el cuerpo de esas RPC para no reemitir el DETAIL original.

12. DESTINO DE orders/order_items. 0029 no puede quedar silenciosa con los dos caminos vivos (create_admin_order escribe pedidos sin tocar el kardex, y §2 prohíbe tablas paralelas). orders tiene 0 filas: no hay historial que migrar. Opción de menor riesgo: reescribir create_admin_order como envoltorio delgado sobre register_sale conservando su firma de 7 argumentos para no romper `src/app/api/admin/orders/route.ts:101`. Si se retiran las tablas, sacarlas también del arreglo de auditoría de 0025 (líneas 134-153).

13. INMUTABILIDAD DEL DINERO. No crear políticas de update ni delete sobre sale_payments ni reservation_payments; declarar el trigger diferido de validación también para update y delete. Hoy la única declaración de inmutabilidad del documento es para la venta.

14. PRUEBAS NUEVAS: reintento de una operación ya confirmada → misma fila devuelta y ningún movimiento nuevo; conversión de reserva concurrente con su vencimiento; venta sin valoración vigente → fila de costo con cost_status='unvalued'.

### 0030 — anulaciones, devoluciones y reembolsos

1. BLOQUEO DE LA LÍNEA EN register_return (hallado por dos lentes). Dos devoluciones simultáneas de la misma sale_line (2 unidades a 100,00) reponen 4 unidades y reembolsan 400,00 con COMMIT limpio (write skew reproducido). `select … from sale_lines where id = any($1) order by id for update` como primera sentencia, antes de calcular el saldo devolvible. Una línea, cero cambios de tabla. Nota: el doble clic real (secuencial) ya se rechaza solo; lo que se escapa es la simultaneidad literal.

2. TOPE ACUMULADO. Validar `sum(return_lines.quantity) <= sale_lines.quantity` por sale_line_id, y `sum(refunds.amount) <= sum(sale_payments.amount)` de la venta. Sin ello, dos devoluciones de 5 y 4 sobre una línea de 7 pasan sin obstáculo: 9 unidades repuestas y 9 reembolsadas.

3. DEVOLUCIÓN TRAS ANULACIÓN. §4 solo prohíbe la dirección contraria. Cerrarla con la precondición `sales.status = 'confirmed'` (el modelo da a sales exactamente dos estados para que ese predicado exista). Sin ella, una venta de 100 puede pagar 190 en reembolsos.

4. REPARTO DEL REEMBOLSO PARCIAL. Calcularlo por diferencia acumulada, no como unitario × cantidad: `round(subtotal * (devuelto_acumulado / quantity), 2) − ya_reembolsado_de_esa_línea`, de modo que la última devolución absorba el residuo. Con el prorrateo de descuento de §4, 7 × 14,32 = 100,24 sobre 100,23 cobrados, y el céntimo sale siempre a favor de la clienta.

5. cancel_sale Y LA CADENA DE COSTOS. §3 enumera seis momentos y deja fuera la anulación y el ajuste. cancel_sale debe reponer valor con el costo capturado en sale_line_costs, no con el promedio vigente: con la secuencia comprar 10@10 / vender 10 / comprar 10@30 / anular, al promedio vigente el saldo queda en 600,00 (200,00 inventados) y al costo capturado en 400,00 = 400,00 realmente desembolsados. Revertir además esas filas de COGS. Añadir las dos filas faltantes a la tabla de §3.

6. refunds Y LA RESERVA CANCELADA. El reembolso del adelanto es inconstruible: `num_nonnulls(sale_cancellation_id, return_id) = 1` no admite un origen que no es venta ni devolución. Añadir la tercera columna `reservation_id` y pasar el check a tres columnas — coste cero, la tabla se crea aquí (verificado que las tres procedencias conviven bajo un único check excluyente). Y declarar en §7 el contrato `cancel_reservation(id, motivo, reembolso|retención)`: hoy el estado 'cancelled' de reservations no lo produce ningún contrato. (La retención no mueve dinero físico —el arqueo ya contó el adelanto el día que entró— así que solo falta el vehículo del reembolso.)

7. MÉTODO DE PAGO Y MONEDA EN refunds. Ninguna salida de dinero del modelo declara método, así que daily_cash_summary no puede restar el efectivo que sale y el arqueo será estructuralmente incompleto —y el descuadre se atribuirá a la vendedora—. Reutilizar el enum de sale_payments.

8. IDEMPOTENCIA. client_operation_id + unique (branch_id, client_operation_id) en la cabecera de returns, con retorno de la fila existente ante unique_violation.

9. ON DELETE explícito en return_lines. Sin políticas de update ni delete sobre refunds: toda corrección se hace por reversión registrada.

10. PRUEBAS NUEVAS: doble devolución concurrente de la misma línea; devolución que excede lo vendido; devolución posterior a una anulación; anulación que repone al costo capturado y cuadra contra lo desembolsado.

### 0031 — compras, recepciones, obligaciones y pagos a proveedor

1. MONEDA FUNCIONAL. goods_receipt_lines declara `unit_cost real` sin ninguna columna de moneda, y la compra directa (purchase_order_id opcional) no la tiene en ninguna parte del modelo. Una recepción en USD produce un promedio en USD contra una venta en PEN: margen reportado 22,00 cuando el real es 13,74 (60% de error). Declarar PEN como moneda funcional de inventory_valuation y sale_line_costs con `check (currency='PEN')`, y añadir `currency` + `exchange_rate_used` a goods_receipt_lines: la recepción convierte con exchange_rate() y CONGELA la tasa en la línea; si devuelve NULL, la recepción falla con error explícito (exchange_rates tiene 0 filas hoy, así que devolvería NULL). Verificado que añadir el check sobre 50.000 filas ya en PEN cuesta 16 ms sin migrar ninguna fila: la decisión no era urgente en 0028, pero sí obligatoria aquí.

2. BONIFICACIÓN CRUZADA. 0027 permite supplier_bonuses.bonus_variant_id no nulo, pero goods_receipt_lines lleva variant_id y bonus_units en la misma línea, así que la bonificación de otra variante solo puede entrar como línea propia a costo cero: promedio 0,0000 y 100% de margen en toda venta suya. Añadir `bonus_of_receipt_line_id` para que el costo lo absorba la línea comprada (elevando su promedio en lugar de hundir el de la bonificada), o hacerlas entrar como unidades no valorizadas. Nunca a costo cero, que además es indistinguible de «costo desconocido».

3. supplier_payment_allocations. Sin tope ni moneda se asignan 1.600 habiendo desembolsado 1.000 (600 de deuda desaparecen sin que salga dinero) y un pago en PEN cancela una obligación en USD dejando saldo -500, exactamente lo que §5 prohíbe. Imponer `sum(allocations.amount) <= supplier_payments.amount` por pago y `<= supplier_obligations.amount_due` por obligación, más igualdad de moneda entre pago y obligación (denormalizar currency o validarlo en el RPC). El anticipo se deriva como amount − asignado y con sobre-asignación sale negativo.

4. MÉTODO DE PAGO en supplier_payments (mismo enum que sale_payments), sin el cual el arqueo no puede restar una transferencia de un pago en efectivo del cajón.

5. IDEMPOTENCIA en goods_receipts y supplier_payments: client_operation_id + unique por sede. Una recepción reintentada duplica stock, promedio y obligación con el proveedor (24 unidades cuando llegaron 12, reproducido); un pago reintentado duplica el desembolso.

6. ON DELETE explícito en purchase_order_lines y goods_receipt_lines. Sin políticas de update ni delete sobre supplier_payments.

7. PRUEBA NUEVA: doble recepción y doble pago a proveedor → una sola fila, ningún movimiento nuevo.

### 0032 — gastos, imputación y costo efectivo

1. GASTO POSTERIOR A LA VENTA DEL LOTE. Recibir 100 @ 10,00, vender 60 y luego imputar 500,00 de flete: repartirlo solo entre las 40 vivas da promedio 22,50 mientras el COGS registrado se queda subvaluado en 300,00 (un tercio del correcto); si el lote se vendió entero, quantity_valued = 0 y la imputación lanza division_by_zero (reproducido). register_expense debe repartir solo sobre las unidades de esa recepción que siguen valorizadas, enviar la porción de lo ya vendido a gasto del periodo y no dividir nunca con quantity_valued = 0. Documentar en §5 que el «costo puesto en almacén» es exacto solo si el gasto se imputa antes de la primera venta del lote.

2. CANDADO. La imputación de un gasto escribe inventory_valuation sin tocar existencias: debe tomar primero el for update de la fila de inventory_stock, o una recepción concurrente y la imputación pierden una de las dos actualizaciones del promedio bajo READ COMMITTED, sin error visible.

3. MÉTODO DE PAGO en expenses (mismo enum), sin el cual daily_cash_summary no puede cuadrar el efectivo que sale del cajón.

4. IDEMPOTENCIA en expenses: client_operation_id + unique por sede.

5. Sin políticas de update ni delete sobre expenses.

### transversal (0028–0032) — reglas a aplicar en las cinco

1. IDEMPOTENCIA COMO PATRÓN, NO COMO EXCEPCIÓN (hallado por dos lentes). `client_operation_id uuid not null` + `unique (branch_id, client_operation_id)` en las cabeceras de goods_receipts, inventory_adjustments, returns, reservations, supplier_payments y expenses, con el RPC intentando el INSERT primero y devolviendo la fila existente ante unique_violation. §11 no cierra ninguna decisión en contra; la ausencia en §7 es elisión de parámetros, no decisión. Excepción verificada: load_initial_inventory NO necesita columna nueva — la invariante de §3 basta como guarda (`update product_variants set tracks_inventory = true where id=$1 and tracks_inventory = false` con aborto si ROW_COUNT=0 rechaza la segunda pasada de forma determinista).

2. ON DELETE EXPLÍCITO en todo libro histórico: sale_lines, sale_line_costs, return_lines, reservation_lines, purchase_order_lines, goods_receipt_lines. Elegir conscientemente entre `restrict` (aborta, lo que hace el kardex) y `set null` + fotografía (precedente order_items). El principio ya está escrito en §3 línea 92 («ninguna entidad referenciada por un libro histórico se elimina físicamente si su eliminación rompe la historia») — solo hay que aplicarlo tabla por tabla en lugar de dejarlo al defecto.

3. revoke truncate on <tabla> from anon, authenticated, service_role en toda tabla de dinero, existencias o bitácora, más un parche para audit_log (el ACL por defecto de Supabase concede TRUNCATE a los tres, verificado). Es defensa en profundidad, no un agujero alcanzable: los tres roles tienen rolcanlogin=f y PostgREST no emite TRUNCATE.

4. CADA MIGRACIÓN CUELGA SU PROPIO TRIGGER DE AUDITORÍA, y corregir la frase de §8 («por el bucle de 0025» es inexacto: es un DO de una sola ejecución sobre un array literal). Con la prueba pgTAP de cobertura, olvidar una tabla deja de ser silencioso.

5. NINGUNA POLÍTICA DE UPDATE NI DELETE sobre las tablas de dinero (sale_payments, reservation_payments, refunds, supplier_payments, expenses); trigger diferido declarado también para update y delete. El precedente ya existe en 0025/0026.

6. CONTEXTO DE SEGURIDAD DECLARADO POR RPC en §7, revalidación explícita de p_branch_id contra staff_branch_ids() en toda RPC definer (con 42501 cuando esté vacío, en lugar de caer a default_branch_id), y retornos que nunca contengan unit_cost, average_unit_cost, quantity_valued ni márgenes.

### Mejoras posteriores

- Traslados entre sedes: el kardex declara `transfer_in`/`transfer_out` pero §7 no incluye ningún contrato de traslado y §10 ninguna prueba. Decidir en 0028: o se retiran los dos tipos del enum hasta que exista el contrato, o se añade `register_transfer(variante, sede_origen, sede_destino, cantidad, motivo)` con el ordenamiento (variant_id, branch_id) y su prueba. Es la única operación que toca dos filas de inventario con el mismo variant_id.
- Prueba de conciliación en §10: tras N movimientos mixtos, total_value = suma de value_delta del kardex = dinero desembolsado − COGS registrado, al céntimo. Con las columnas monetarias propuestas es una sola aserción y cubre a la vez redondeo, ajuste, anulación y bonificación. Ninguna de las 16 pruebas actuales compara el valor del inventario contra el dinero realmente gastado.
- `currency char(3) not null default 'PEN'` en sale_payments y refunds con check contra sales.currency, coherente con el patrón de 0027 (suppliers.default_currency, checks ~ '^[A-Z]{3}$'). Hoy no cuesta nada y evita tocar filas históricas el día que se habiliten ventas en USD — justo lo que la decisión de §4 quería evitar.
- resolve_variant_supply: cuando `caller_reads_cost` es false, emitir un motivo neutro y sin importe («sin condiciones comerciales vigentes») en lugar de omitir el motivo, para que `viable` signifique lo mismo para los dos roles sin revelar el costo. Hoy la vendedora ve viable=t una oferta que la propietaria ve bloqueada por falta de costo vigente.
- Precisar en §8 que el bucle de auditoría cubre cabeceras de dinero y decisiones, y excluir inventory_stock (saldo derivado cuyo histórico es el kardex) e inventory_movements (solo adición por diseño). Auditar inventory_stock alarga la sección crítica del candado más contendido con dos copias de un saldo que balance_after ya registra.

### Afirmaciones del modelo que el panel comprobó y confirmó

No hace falta volver a revisarlas.

- El promedio ponderado por variante y sede es la elección correcta, y la regla de §3 «la devolución vendible restaura el costo capturado en la línea original, no el promedio actual» conserva el valor exacto: 200,00 reales sobre 15 unidades tras un cambio de promedio de 10,00 a 15,00. Aplicada a la anulación, la misma regla cuadra al céntimo (400,00 contra 400,00 desembolsados).
- La cotización del proveedor no tiene ningún camino hacia el costo de una venta: la separación cotización / recepción / valoración de la cadena de costos de §3 se sostiene.
- Con la fila de inventory_stock existente, dos vendedoras contra la última unidad se serializan correctamente: la segunda espera el candado y lee on_hand = 0. La prueba crítica 2 aguanta; el defecto de concurrencia estaba acotado a la fila ausente.
- La máquina de estados de reservations (active · expired · released · converted · cancelled) de §4 YA contiene la guarda de concurrencia: escrita como UPDATE condicional, PostgreSQL reevalúa el predicado tras liberar el candado (EvalPlanQual) y la conversión concurrente con el vencimiento da 17 | 5 | 12 con status='converted' —el resultado correcto— sin bloqueos adicionales ni tablas nuevas.
- `sale_cancellations.sale_id` único impide efectivamente la segunda anulación (prueba 6).
- `sales.client_operation_id` con índice único por sede cubre correctamente el doble clic sobre la venta (prueba 1), y el reintento SECUENCIAL de una devolución —el doble clic real— ya se rechaza solo por la validación de saldo devolvible.
- `tracks_inventory` nace en false y eso conserva el comportamiento anterior exacto: aplicar 0028 no convierte ninguna variante en agotada (prueba 14 pasa; las 8 variantes actuales quedan correctamente en false). La misma invariante es además la guarda natural contra una doble carga inicial, sin necesidad de columna de idempotencia.
- La ausencia de fila como estado es un idioma ya adoptado por el modelo (tax_document_requests, §11) y funciona igual de bien para la valoración sin costo conocido: 100 unidades sin costo y cero filas de valoración, seguidas de una recepción de 50 @ 20,00, dan 50 unidades a 20,000000 y saldo 1.000,00 exacto.
- El aislamiento del costo por RLS de tabla FUNCIONA en lectura directa: los cinco perfiles reales (una sede, dos sedes, otra sede, administradora y sin asignación) obtienen cero filas de supplier_cost_agreements, supplier_cost_tiers, supplier_cost_history e inventory_valuation, y resolve_variant_supply sigue devolviendo quoted_unit_cost, net_unit_cost_pen y total_cost_pen en NULL a toda vendedora incluso con inventario ya presente.
- register_sale PUEDE ser SECURITY INVOKER y capturar el costo sin exponerlo: un INSERT sin RETURNING no requiere permiso de SELECT, y la lectura de la valoración puede vivir en un trigger AFTER INSERT definer que PostgreSQL prohíbe invocar como función («trigger functions can only be called as triggers»). La doctrina de 0027 sigue siendo aplicable al Bloque 2.
- Dentro de una función SECURITY DEFINER, `auth.uid()` y `staff_branch_ids()` siguen resolviendo correctamente (leen un GUC de sesión que definer no altera): lo que se omite es la evaluación automática de las políticas, no el predicado. La herramienta de recorte está disponible; solo hay que invocarla como ya hace create_admin_order.
- El `revoke insert, update, delete` de 0025 frena a service_role pese a rolbypassrls: verificado por mí que service_role solo tiene SELECT, REFERENCES, TRIGGER y TRUNCATE sobre audit_log. rolbypassrls exime de las políticas RLS, no de los privilegios de tabla.
- anon, authenticated y service_role tienen rolcanlogin = f (verificado): no pueden abrir una sesión de PostgreSQL, y el único rol que sí puede conectarse por PostgREST (authenticator) no tiene TRUNCATE. La ruta de vaciado por TRUNCATE no es alcanzable desde ningún cliente del sistema; no hay librería de conexión directa a Postgres ni la palabra `truncate` en src/ ni scripts/.
- El contrato TypeScript no se rompe con la disponibilidad efectiva: la resolución de cuatro reglas devuelve el mismo enum `public.product_availability` y `src/lib/catalog/contracts.ts` ya declara los tres valores. Ni catalog_list_v2 ni catalog_product_detail_v2 necesitan claves JSON nuevas.
- `consult` prevalece como decisión editorial sin mirar inventario y ya está resuelto así en evaluate_cart_v2. Ningún índice ni política existente estorba a 0028, e `is_public_catalog_variant` (SECURITY DEFINER, prosecdef=t verificado) es el patrón exacto que la corrección de disponibilidad debe imitar.
- La tensión del kardex con el borrado de productos es menor de lo que teme §3: no existe NINGUNA ruta de aplicación que borre productos, y la edición desde el panel desactiva variantes en vez de borrarlas (`catalog-v2-service.ts:485`), coherente con §3. Solo el script de limpieza y el rollback del importador necesitan ajuste.
- Omitir la cláusula ON DELETE es seguro: PostgreSQL aplica NO ACTION y el borrado del producto aborta con error explícito dejando la línea viva. Verificado además que el supuesto «patrón dominante de cascade» no es tal — wholesale_rules es NO ACTION (confdeltype='a') y order_items, el precedente real de un libro de líneas, es SET NULL ('n'); lo que cascadea son atributos derivados del catálogo (variant_prices, variant_attribute_values, product_media, product_suppliers).
- `orders` tiene 0 filas (verificado): no hay historial que migrar al unificar el concepto de venta. Y el camino antiguo es admin-only en tres capas —guarda 42501 en el cuerpo de create_admin_order, política `admins manage orders` con qual is_admin(), y cero filas legibles—, así que ninguna vendedora puede registrar por él ni antes ni después de 0029.
- La valoración SÍ es auditable y reparable con el modelo actual: los documentos de origen (goods_receipt_lines.unit_cost de §5 y sale_line_costs de §4) permiten derivar el valor real, exponer la deriva acumulada y recalcular el promedio exacto con una sola consulta. La prueba 10 de §10 puede escribirse sobre valor, no solo sobre promedio.
- Posponer la decisión de moneda funcional hasta 0031 no cuesta nada: añadir `check (currency = 'PEN')` sobre 50.000 filas ya en PEN tarda 16 ms y no migra ninguna fila. Entre 0028 y 0031 el único escritor de inventory_valuation es load_initial_inventory y la venta está fijada en PEN, así que no hay ventana en la que el modelo produzca un margen en dos monedas.
- El prorrateo determinista del descuento sobre el total funciona: la suma de discount_amount de las líneas da exactamente 5,00 sobre un descuento de 5,00 (prueba 15). El defecto está solo en el camino de vuelta, al repartir el reembolso de una devolución parcial.
- La regla de §3 «ninguna entidad referenciada por un libro histórico se elimina físicamente si su eliminación rompe la historia» está bien enunciada y es general: dice «un libro histórico», no «el kardex». El principio rector ya está escrito; lo que falta es aplicarlo tabla por tabla.
- Los checks de no negatividad que §3 ya exige bastan por sí solos para impedir los estados corruptos de la valoración: el intento de dejar quantity_valued negativo aborta y la fila queda intacta, de modo que el promedio negativo y el division_by_zero posteriores no son alcanzables.

---

## 13. Modelo congelado

Con este anexo el modelo del Bloque 2 queda **congelado**. No se convoca otro panel para `0028`, `0029`, `0030`, `0031` ni `0032`: cada migración se verifica directamente contra la base, y al conectar los dos frentes se hace una revisión crítica final de concurrencia, dinero, inventario, RLS y auditoría.
