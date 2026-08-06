# Vertical 2 — Proveedores, costos y escalas

**Bloque 1 del Plan de desarrollo de la plataforma Bellaroshé**
**Rama:** `feature/bellaroshe-platform-v2`
**Fecha:** 2026-08-06
**Migración:** `0027_supplier_domain.sql` · **Pruebas:** `0027_supplier_domain.test.sql`

---

## 1. Qué cierra

La pregunta 9 de la auditoría —*«¿Puede un mismo producto relacionarse con varios proveedores?»*— tenía por respuesta **No**: cero ocurrencias de `supplier` o `proveedor` en las 26 migraciones. Ahora la respuesta es **sí**, y es demostrable con una consulta.

Las nueve viñetas del plan tienen lugar explícito:

| Viñeta del plan | Dónde vive |
|---|---|
| Proveedores | `suppliers` |
| Contactos | `supplier_contacts` |
| Producto-proveedor | `product_suppliers` |
| Costos por proveedor | `supplier_cost_agreements` |
| Escalas por cantidad | `supplier_cost_tiers` |
| Pedidos mínimos | `suppliers.minimum_order_amount` (pedido) · `supplier_branch_terms.minimum_order_amount` (sede) · `product_suppliers.minimum_order_quantity` (ítem) |
| Bonificaciones | `supplier_bonuses` |
| Tiempo de entrega | `suppliers.default_lead_time_days` · `supplier_branch_terms.lead_time_days` · `product_suppliers.lead_time_days` |
| Historial de costos | Sucesión de vigencias de `supplier_cost_agreements`, mantenida por `set_supplier_cost_agreement()` |

Dos tablas no salen del plan sino del modelo: `supplier_branch_terms`, porque `branch_id` es obligatorio en toda tabla de operación, y `exchange_rates`, porque el negocio compra en soles y en dólares.

---

## 2. Cómo se llegó a este diseño

Se contrastaron **tres diseños independientes** —uno fiel al plan al pie de la letra, otro partiendo de la realidad operativa de una importadora peruana, otro maximizando la coherencia con los patrones del catálogo V2— evaluados por **tres jueces** con lentes distintas (integridad SQL, fidelidad y alcance, utilidad real). El diseño aplicado es la síntesis: parte del ganador, injerta lo rescatable de los perdedores y corrige todos los defectos graves detectados, incluidos los del ganador.

El proceso encontró además **un defecto real en `0025`**, ajeno a esta vertical: las claves foráneas `on delete set null` de la bitácora chocaban con su propio trigger de solo-adición e impedían borrar cualquier usuario con historial. Se corrigió por separado en `0026`.

---

## 3. Las decisiones que dan forma al modelo

### El costo se parte en cabecera y escalera

`supplier_cost_agreements` lleva la vigencia, la moneda y el régimen de IGV. `supplier_cost_tiers` lleva los tramos. La exclusión GiST de la cabecera es deliberadamente simple:

```sql
exclude using gist (product_supplier_id with =, validity with &&) where (is_active)
```

**Ni la moneda ni el tipo de costo entran en la clave.** Fue el defecto que los tres jueces marcaron como el más grave del conjunto: meterlos permite dos costos vigentes simultáneos para el mismo par proveedor-variante, y entonces el costo queda indeterminado. Con la moneda fuera, en cualquier instante hay exactamente un acuerdo vigente por oferta, y con él una sola moneda, un solo régimen tributario y una sola escalera.

### La escalera está obligada a ser completa, no solo a no solaparse

Una exclusión GiST impide solapamientos; **no impide huecos**. Con `[1,12)` y `[24,∞)` conviviendo, una compra de 15 unidades no resuelve ningún costo. `assert_supplier_cost_ladder_is_complete` —trigger de constraint diferido— exige que la escalera empiece en 1, que cada tramo arranque donde termina el anterior y que el último sea abierto.

Y la unidad de reemplazo es **la escalera entera**: `set_supplier_cost_agreement()` cierra el acuerdo vigente y abre otro con todos sus tramos. Nunca se cierra un tramo suelto, así el hueco silencioso es imposible por construcción.

### El costo vive en tablas propias, separado del vínculo

Es lo que hace que la RLS por tabla baste. Una vendedora lee `suppliers` y `product_suppliers` —sabe quién provee y en cuántos días llega, que es lo que necesita para responder «¿cuándo tienen el tono 12?»— y obtiene **cero filas** de `supplier_cost_agreements`. Sin la separación haría falta seguridad por columna, que este repositorio no usa en ningún sitio.

Por eso `resolve_variant_supply` **no** es `security definer`: al ejecutarse con los privilegios de quien llama, una sola función sirve a los dos roles y el recorte lo hace la RLS, no un `if`.

### Solo los vínculos de alcance variante admiten costo

`product_suppliers` conserva el alcance excluyente producto|variante de `wholesale_rules` —el distribuidor local trae toda la línea; la importación se negocia por SKU—. Pero un importe no puede quedar adherido a algo que no es la unidad comprable: dos variantes del mismo producto con presentaciones distintas compartirían un costo correcto solo para una.

Se impone de forma declarativa, con una clave foránea compuesta contra `(id, scope_type)` más un check. No depende del código de resolución.

### El crédito fiscal se normaliza al comparar

Un distribuidor formal que cotiza S/ 118 con factura cuesta S/ 100. Un informal que cotiza S/ 110 sin comprobante cuesta S/ 110. **Comparando importes nominales el informal gana siempre**, y ese criterio humano no sobrevive a quince proveedores y 1.500 SKU.

`suppliers.tax_document_kind` + `tax_credit_eligible` + `prices_include_tax` describen el régimen; la normalización se aplica al leer, solo cuando el importe incluye IGV y el comprobante da crédito. Un check impide declarar crédito con un comprobante que no lo otorga.

### El tipo de cambio es una tabla de referencia, no una operación

Sin ella, ordenar por importe nominal pone USD 2,85 por debajo de PEN 10,50. `exchange_rate()` **no** es `security definer` —respeta la política de su propia tabla— y devuelve `null` cuando la tasa tiene más de 30 días: se prefiere un bloqueo visible a una tasa de hace tres años aplicada en silencio.

### La presentación de compra entra en la identidad de la oferta

`purchase_unit_label` + `pack_units`, con clave única `(supplier_id, variant_id, pack_units)`. Así un proveedor puede vender el mismo esmalte suelto a S/ 12 y en caja de 12 a S/ 108: son dos ofertas. Y `pack_units` queda **congelado** una vez que la oferta tiene acuerdos, porque cambiarlo reescribiría en silencio el significado de todo el historial.

**Convenio de unidades** (debe replicarse literalmente en la interfaz): `pack_units` son unidades vendibles por unidad de compra; `minimum_order_quantity`, `quantity_range`, `unit_cost`, `buy_quantity` y `free_quantity` van **todos en unidades de compra**. `resolve_variant_supply` recibe la cantidad en unidades **vendibles** y devuelve `purchase_units`, que es lo que hay que pedirle al proveedor.

### Las opciones no viables se devuelven con su motivo

*«El proveedor más barato no aparece»* destruye la confianza en un comparador, y el motivo es justamente con lo que se negocia. Las opciones inviables salen con un arreglo `blockers` en español en vez de filtrarse.

Con una corrección sobre el aporte original: **el mínimo por monto de pedido no es un bloqueo**, solo un dato. No se puede juzgar un mínimo de pedido contra el importe de una sola variante; hacerlo marcaba como inviable a casi todo proveedor con mínimo declarado. Solo el mínimo por cantidad del ítem, que sí es propio de la línea, bloquea.

### Un costo ya vigente no se reescribe

Un trigger `BEFORE UPDATE` rechaza con `42501` cualquier cambio de importe, rango, moneda, régimen o inicio de vigencia sobre acuerdos cuya vigencia ya empezó. Es el valor histórico impuesto por la base y no por disciplina.

El **borrado sí se permite**: prohibirlo habría roto el `on delete cascade` de productos, del que depende `scripts/cleanup-v2-test-data.mjs`. Borrar es un acto destructivo explícito y queda en la bitácora; reescribir era silencioso.

### Se eliminó el guardián que bloqueaba la ingesta

Se conserva «todo alcance con vínculos activos debe tener uno preferido». Se **elimina** «el preferido debe tener costo vigente»: componiendo ambos, era imposible registrar el primer proveedor de una variante sin cotizarlo en la misma transacción, y *«este distribuidor lo tiene, falta cotizar»* es el estado más común al construir un catálogo de abastecimiento de 1.500 SKU. La falta de costo pasa a reportarse como bloqueo en la resolución, donde se ve sin impedir la carga.

---

## 4. Verificación

`npm run db:reset:local` reconstruye de `0001` a `0027` con ambos seeds. `npm run test:db` → **104 aserciones pgTAP · PASS**. `typecheck` y `lint` sin errores. Catálogo, detalle y guardas administrativas respondiendo.

Comprobado además de forma independiente, con tres proveedores reales del mismo esmalte:

| Escenario | Resultado |
|---|---|
| Importador (USD 2,60, DUA) · Distribuidor (S/ 11,80 con IGV) · Informal (S/ 12,00 sin crédito), 20 unidades | Neto en soles **9,75 · 10,00 · 12,00**, ordenado correctamente |
| Formal S/ 11,80 nominal vs informal S/ 11,00 nominal | Neto **10,00 vs 11,00** — el crédito fiscal **invierte** el orden nominal |
| Escalera con hueco `[1,12)` + `[24,∞)` | Rechazada: *«debe empezar en 1 … y cubrir toda cantidad sin huecos»* |
| Escalera contigua `[1,12)` + `[12,∞)` | Aceptada |
| Escalera que empieza en 6 | Rechazada |
| Vendedora consultando el comparador | Ve proveedor y plazo; costo **oculto por RLS** |
| Escala aplicada a 20 unidades | Toma el tramo `[12,∞)`, no el `[1,12)` |

---

## 5. Fuera de alcance

Órdenes de compra, recepciones y devoluciones a proveedor (Bloque 2). Costo puesto en almacén y prorrateo de flete, seguro y aduana: modelarlo aquí produciría una estimación presentada como hecho; el costo real saldrá del prorrateo de la DUA cuando existan recepciones. Inventario y stock por sede. Evaluación del mínimo por monto. Puntuación de fiabilidad del proveedor. Importación masiva de ofertas. Carga automática del tipo de cambio. Endpoints, tipos de `contracts.ts` y pantallas: esta entrega es capa de datos y contratos SQL.

---

## 6. Notas para quien construya la interfaz

- **No insertar** en `supplier_cost_agreements` ni `supplier_cost_tiers` directamente: usar `set_supplier_cost_agreement()`, que recibe la escalera completa como `jsonb` y cierra la vigencia anterior. Insertar a mano pierde el cierre y choca con el guardián de continuidad.
- Marcar `is_preferred = true` al dar de alta el **primer** proveedor de una variante, o la transacción falla al confirmar con `23514`. Para cambiar de preferido, llamar a `set_preferred_supplier()`.
- `exchange_rates` **nace vacía a propósito**. Mientras no se cargue una tasa USD→PEN reciente, toda oferta en dólares sale con costo neto nulo y el bloqueo «sin tipo de cambio vigente». Es un fallo visible y deliberado, pero convierte la carga del tipo de cambio en una dependencia operativa.
- El dominio nace sin datos: hasta cargar el primer proveedor, el comparador devuelve cero filas. Conviene que la interfaz lo distinga de un fallo.
- Errores a traducir: `23P01` sobre acuerdos = «ya hay un costo vigente para esa oferta»; `42501` sobre costos = «un costo ya vigente no se reescribe»; `42501` sobre ofertas = «no se puede cambiar el empaque de una oferta con costos»; `23514` sobre la escalera = «debe empezar en 1 y no tener huecos».

**Pendiente para el Bloque 2:** la línea de la orden de compra debe guardar el `product_supplier_id` y el importe **resueltos en el momento de comprar**, sin volver a resolverlos. Si los reresuelve, el costo histórico de una compra cambiará el día que alguien registre un acuerdo nuevo.
