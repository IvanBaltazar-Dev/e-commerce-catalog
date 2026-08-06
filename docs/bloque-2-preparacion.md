# Bloque 2 — Preparación previa a `0028`

**Rama:** `feature/bellaroshe-platform-v2`
**Fecha:** 2026-08-06
**Estado:** trabajo preparatorio mientras corre la revisión arquitectónica. **No crea tablas.**

Complementa [docs/bloque-2-modelo.md](bloque-2-modelo.md). Recoge lo que puede fijarse sin depender de los hallazgos bloqueantes del panel.

---

## 1. Casos numéricos de valoración

Aritmética del promedio móvil ponderado, para que las pruebas pgTAP comprueben números concretos y no comportamientos vagos.

### Notación

```
qty    quantity_valued
val    valor total acumulado
avg    average_unit_cost = val / qty
```

### Secuencia de referencia

| # | Operación | qty | val | avg | Nota |
|---:|---|---:|---:|---:|---|
| 1 | Recepción 100 @ 10.00 | 100 | 1 000.00 | 10.0000 | Estado inicial |
| 2 | Recepción 50 @ 13.00 | 150 | 1 650.00 | 11.0000 | Promedio sube |
| 3 | Recepción parcial 80 @ 12.00 | 230 | 2 610.00 | 11.3478 | La OC pedía 200; llegaron 80 |
| 4 | Venta 10 | 220 | 2 496.52 | 11.3478 | Vender **no** cambia el promedio. `sale_line_costs.unit_cost = 11.3478` |
| 5 | Recepción 100 @ 15.00 | 320 | 3 996.52 | 12.4891 | El promedio sube |
| 6 | Devolución vendible 3 de la venta #4 | 323 | 4 030.56 | 12.4785 | Entra al **costo capturado 11.3478**, no al promedio actual. El promedio baja: vuelve mercadería más barata |

### Casos independientes

**Bonificación.** Desde qty=0: recepción de 100 pagadas @ 10.00 más 20 bonificadas.
`val = 1 000.00` · `qty = 120` · `avg = 8.3333`. La bonificación **baja el costo efectivo**, que es exactamente su propósito económico.

**Gasto imputado después.** Sobre el estado anterior, flete de S/ 240 imputado a esa recepción:
`val = 1 240.00` · `qty = 120` (no cambia) · `avg = 10.3333`. Un gasto añade valor sin añadir unidades.

**Carga inicial con costo.** qty=0 → 300 @ 9.50 → `val = 2 850.00` · `avg = 9.5000`.

**Carga inicial sin costo conocido.** qty=0 → 300 unidades sin costo.
`on_hand = 300` pero `quantity_valued = 0` y `average_unit_cost = null`. **El promedio no se inventa.** La primera recepción con costo valoriza solo lo que entra por ella.

**Anulación completa.** Repone cada línea a su costo capturado. Idéntico a una devolución total.

---

## 2. Tres correcciones que la preparación ya obliga a hacer

Verificadas por mi cuenta antes de conocer los hallazgos del panel.

### 2.1 El promedio no puede acumularse sobre sí mismo — **corrige el modelo**

El documento define `inventory_valuation` con `quantity_valued` y `average_unit_cost`. Si el recálculo parte del promedio **ya redondeado**, el error se acumula.

Simulación de 200 ciclos de recepción de 7 unidades y venta de 3, con costos alternados:

```
acumulando sobre el promedio redondeado -> qty=800  avg=10.3683  valor implícito 8 294.6400
acumulando sobre el valor total         -> qty=800  avg=10.3689  valor real      8 295.1217
divergencia                                                                          0.4817
```

S/ 0,48 sobre S/ 8 295 parece poco, pero **no tiene cota**: crece con el número de movimientos y el sesgo es sistemático, no aleatorio.

**Corrección mínima:** `inventory_valuation` guarda `total_value numeric(14,4)` como fuente de verdad y `average_unit_cost` pasa a ser **columna generada** `total_value / quantity_valued`. Todo recálculo opera sobre `total_value`. El promedio queda como dato de presentación.

### 2.2 Al llegar a cero, el valor debe forzarse a cero — **corrige el modelo**

Si `quantity_valued` llega a 0 y `total_value` conserva un residuo de redondeo, la siguiente recepción nace con un promedio contaminado y el residuo se propaga indefinidamente.

**Corrección mínima:** cuando `quantity_valued` llega a 0, `total_value` se fija en 0 explícitamente. Un check `(quantity_valued = 0) = (total_value = 0)` lo garantiza.

### 2.3 El costo desconocido debe distinguirse del costo cero — **corrige el modelo**

Con carga inicial sin costo, `sale_line_costs.unit_cost` quedaría nulo y el margen se reportaría como si el costo fuese cero: margen del 100 %, que es falso.

**Corrección mínima:** `sale_line_costs` gana `cost_basis` con valores `weighted_average` · `unknown`. El margen se reporta **no calculable**, nunca como total.

---

## 3. Adaptación prevista de `scripts/cleanup-v2-test-data.mjs`

El script borra productos `TEST-%` y `SCALE-%` en bloque (líneas 16-37). Con FK restrictiva desde `inventory_movements` hacia `product_variants`, ese borrado fallará con `23503` en cuanto una variante de prueba tenga movimientos.

**Precedente que se aplica.** La Vertical 2 ya resolvió esta disyuntiva en `supplier_cost_agreements`: se rechaza el `UPDATE` —reescribir un importe vigente es silencioso y corrompe el histórico— pero se **permite el `DELETE`**, que es un acto destructivo explícito y queda registrado en la bitácora.

`inventory_movements` sigue el mismo criterio: trigger que rechaza `UPDATE`, sin política RLS de borrado para `authenticated`, y borrado posible solo con `service_role`. Así el kardex es inmutable en operación y el entorno de prueba sigue siendo limpiable.

**Cambios concretos, en este orden dentro de `deleteProducts()`:**

1. antes de borrar productos, resolver `variantIds` (ya lo hace, línea 22);
2. borrar `inventory_movements` de esas variantes;
3. borrar `inventory_valuation` de esas variantes;
4. borrar `inventory_stock` de esas variantes;
5. borrar líneas de venta, reserva, OC y recepción de prueba que las referencien;
6. recién entonces borrar los productos.

**Restricción que no se negocia:** el script ya exige `isLocal` (línea 8) y aborta contra cualquier host que no sea loopback. Eso se conserva intacto.

---

## 4. Nombres y contratos previstos de `0028`

Sujeto a los bloqueantes del panel. Se fija ahora para que las pruebas puedan escribirse en paralelo.

### Tablas

```
public.inventory_stock        (variant_id, branch_id) PK
                              on_hand · reserved · available (generada) · updated_at
public.inventory_movements    kardex de solo adición
                              variant_id · branch_id            FK restrictiva
                              variant_sku · variant_label · branch_label   fotografía
                              movement_type · quantity · balance_after
                              source_type · source_id           polimórfico, sin FK
                              actor_id · actor_label            sin FK
                              reason · occurred_at
public.inventory_valuation    (variant_id, branch_id) PK
                              quantity_valued · total_value
                              average_unit_cost (generada) · currency · updated_at
```

### Enumerado

```
public.inventory_movement_type
  initial_load · sale · sale_cancelled · return_restock
  receipt · adjustment · transfer_in · transfer_out
```

### Columna nueva

```
public.product_variants.tracks_inventory boolean not null default false
```

**Nace en `false`.** Es lo que impide que aplicar `0028` convierta el catálogo actual en agotado.

### Funciones

```
public.variant_effective_availability(variant_id, branch_id)
    Resolución de cuatro reglas: consult > sold_out editorial >
    agotado por stock > estado editorial. Consumida por los contratos del catálogo.

public.apply_inventory_movement(variant, branch, tipo, cantidad, origen, motivo)
    Punto único de escritura del kardex y del saldo. Bloquea con for update,
    recalcula balance_after y mantiene la valoración coherente.

public.load_initial_inventory(lote jsonb, modo)
    modo = 'preview' | 'commit'. Valida SKU inexistente, duplicado y cantidad
    negativa; en 'commit' escribe initial_load y activa tracks_inventory solo
    para las variantes cargadas.

public.adjust_inventory(variant, branch, cantidad, motivo)
    Ajuste con motivo obligatorio. Solo administración.
```

### Cambios sobre lo existente

- `catalog_list_v2` y `catalog_product_detail_v2` incorporan la disponibilidad efectiva.
- El bucle de auditoría de `0025` suma las tres tablas nuevas.
- `scripts/cleanup-v2-test-data.mjs`, según §3.

---

## 5. Esqueleto de pruebas pgTAP de `0028`

Archivo `supabase/tests/database/0028_inventory.test.sql`, en el estilo de `0024`.

**Estructura y disponibilidad**
1. Existen las tres tablas y el enumerado.
2. `tracks_inventory` existe y su valor por defecto es `false`.
3. **Ninguna de las variantes actuales queda con `tracks_inventory = true`** tras la migración.
4. `consult` prevalece sobre cualquier existencia.
5. `sold_out` editorial prevalece aunque haya stock.
6. `available` + seguimiento + disponible ≤ 0 → agotado automático.
7. `tracks_inventory = false` conserva el estado editorial exacto.
8. El catálogo público devuelve el mismo resultado que antes de la migración cuando nadie tiene seguimiento activo.

**Saldos e integridad**
9. `on_hand` negativo → rechazado.
10. `reserved > on_hand` → rechazado.
11. `quantity_valued = 0` obliga a `total_value = 0`.
12. El kardex rechaza `UPDATE`.
13. Una variante con movimientos no puede borrarse físicamente (`23503`).
14. El snapshot del kardex sobrevive al cambio de nombre y de SKU de la variante.

**Valoración**
15-20. Los seis pasos de la secuencia de referencia de §1, comprobando `qty`, `total_value` y `average_unit_cost` al céntimo.
21. Bonificación: baja el costo efectivo.
22. Gasto imputado: sube el valor sin cambiar la cantidad.
23. Carga inicial sin costo: `quantity_valued = 0` y promedio nulo, con `on_hand` correcto.
24. Devolución al costo histórico con el promedio ya cambiado.
25. Ciclo completo hasta existencia cero: `total_value` exactamente 0.
26. **Sin divergencia acumulada** tras 200 movimientos entre saldo y kardex.

**Concurrencia** — con dos sesiones, fuera de pgTAP si hace falta.
27. Dos ventas simultáneas de la última unidad: una gana, la otra recibe error explícito.
28. Reintento idempotente: no duplica movimiento.

**RLS**
29. Vendedora lee existencias de sus sedes.
30. Vendedora obtiene **cero filas** de `inventory_valuation`.
31. Vendedora no puede ajustar inventario.
32. Vendedora de otra sede no ve existencias ajenas.

---

## 6. Fixtures aislados

Prefijo `INV-TEST-` para no colisionar con `TEST-` y `SCALE-` del script de limpieza, y para poder borrarlos por separado.

- Dos sedes: la principal existente más `INV-TEST-SEDE2`.
- Tres variantes: una con seguimiento y stock, una con seguimiento y stock cero, una sin seguimiento.
- Tres perfiles: administradora, vendedora de una sede, vendedora de dos sedes.
- Todo dentro de la transacción de la prueba, con `rollback`.
