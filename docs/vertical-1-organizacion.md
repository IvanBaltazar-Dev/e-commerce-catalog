# Vertical 1 — Organización, sede y rol de vendedora

**Bloque 1 del Plan de desarrollo de la plataforma Bellaroshé**
**Rama:** `feature/bellaroshe-platform-v2`
**Fecha:** 2026-08-06
**Migraciones:** `0023`, `0024`, `0025`

---

## 1. Por qué esto va primero

El plan lo exige antes que cualquier operación:

> Aunque inicialmente exista una sede, toda venta, compra, reserva y disponibilidad debe guardar `branch_id`.

Y la auditoría del Bloque 0 encontró dos vacíos que encarecen cada día que pasan (`docs/riesgos-v2.md`, R-03 y R-04):

- **Sin dimensión organizativa.** Ninguna tabla tenía `branch_id`. Introducirlo después obligaría a migrar cada tabla transaccional y a rehacer sus políticas RLS.
- **Sin auditoría.** En 32 tablas existían tres columnas de autoría. El Bloque 2 exige que las vendedoras registren anulaciones y devoluciones sin aprobación previa y con trazabilidad completa (reglas 7 y 8). Eso es inauditable sin bitácora, y añadirla con datos reales cuesta mucho más.

---

## 2. Qué se construyó

### Empresa y sedes

| Tabla | Contenido |
|---|---|
| `companies` | Razón social, nombre comercial, RUC (once dígitos), contacto |
| `branches` | Sede por empresa: código, nombre, dirección, distrito, provincia, teléfono, WhatsApp |

Integridad de la sede predeterminada, con el mismo rigor que la variante predeterminada de producto:

- **Como máximo una**: índice único parcial sobre `(company_id) where is_default and is_active`.
- **Al menos una**: `branches_default_guard`, trigger de constraint diferido que impide dejar a una empresa con sedes activas y ninguna predeterminada.
- Una sede inactiva no puede seguir siendo la predeterminada (check constraint).

La migración deja creada la empresa `Bellaroshé` y su `Sede principal` en Lima, para que el sistema sea utilizable desde el primer arranque.

### Roles

`app_role` pasa a tener cuatro valores:

```text
admin      propietaria y personal con control total del negocio
developer  perfil técnico; además de admin, habilita el cargador de catálogo
seller     vendedora; opera en su sede, sin administrar el catálogo
```

`admin_profiles` gana `is_active` y `phone`. **Un perfil desactivado pierde el acceso pero conserva su rol y su rastro** en pedidos y bitácora: `is_admin()` e `is_developer()` ahora exigen `is_active`, y la guarda de aplicación lo comprueba antes de llegar a la base.

> La tabla sigue llamándose `admin_profiles` a propósito. Renombrarla obligaría a tocar 61 políticas RLS por un beneficio puramente nominal.

### Alcance por sede

| Tabla / función | Qué resuelve |
|---|---|
| `staff_branches` | Asignación N:M de personal a sedes, con una principal por persona (índice único parcial) |
| `staff_branch_ids(user_id)` | Sedes donde la persona puede operar. Administración y perfil técnico alcanzan **todas** las sedes activas; la vendedora, **solo** las asignadas |
| `default_branch_id(user_id)` | Sede a usar cuando la operación no indica una: la principal de la persona → cualquiera asignada → la predeterminada de la empresa |
| `is_staff()` / `is_seller()` | Predicados nuevos para RLS y rutas |

### Auditoría

`audit_log` es **de solo adición**: un trigger `BEFORE UPDATE OR DELETE` rechaza cualquier mutación con `42501`, y no existe ninguna política RLS de escritura. Los asientos entran por un trigger `security definer`, nunca por PostgREST. Solo administración puede leerla.

Cada asiento guarda: momento, actor, rol del actor, sede, tabla, identificador del registro, acción, campos que cambiaron, valores anteriores y nuevos.

Tablas auditadas (10): `products`, `product_variants`, `variant_prices`, `wholesale_rules`, `orders`, `order_items`, `companies`, `branches`, `staff_branches`, `admin_profiles`.

Dos decisiones de ruido:

- `search_document` —el `tsvector` generado de productos— se excluye de los valores registrados: es enorme y no aporta nada forense.
- Un `updated_at` que se mueve solo **no** genera asiento. Si el único campo distinto es ese, el trigger no escribe.

Los diccionarios (plantillas, atributos, opciones) quedan fuera a propósito: cambian por migración, no por operación diaria.

### Primera aplicación de la regla

`orders.branch_id` es **obligatorio**. Los pedidos existentes se rellenaron con la sede predeterminada antes de imponer el `not null`.

`create_admin_order` cambia de firma para recibir `p_branch_id` opcional. Si no llega, resuelve la sede con `default_branch_id()`; si tampoco hay, falla explícitamente en lugar de inventar una. Además comprueba que la sede resuelta esté dentro de `staff_branch_ids()` de quien registra.

> Se retiró la función de seis argumentos antes de crear la de siete. Conservar ambas volvería ambigua la llamada desde PostgREST.

---

## 3. Qué NO entra en esta vertical

- **Las vendedoras todavía no registran pedidos.** `create_admin_order` sigue exigiendo `is_admin()`. El rol, el alcance por sede y las políticas ya existen; abrir el flujo de venta es Bloque 2 (venta rápida), no Bloque 1.
- **Disponibilidad por sede.** Hoy la variante tiene un estado cualitativo global. La cantidad estimada y reservada por sede es parte del inventario operativo.
- **Interfaz de administración de sedes y personal.** El modelo y las APIs existen; la pantalla llega cuando haya más de una sede real.

---

## 4. Decisiones estructurales registradas (regla 20 del plan)

1. **`branch_id` es obligatorio, no opcional.** Ninguna tabla de operación se crea sin él. `orders` es el precedente.
2. **La sede nunca se deduce de la fila auditada**: se resuelve de quién opera. Un asiento de bitácora guarda dónde estaba la persona, no dónde estaba el dato.
3. **La desactivación sustituye al borrado** para personal. Nada que aparezca en un pedido o en la bitácora puede desaparecer.
4. **La bitácora es inmutable para todos, incluida la propietaria.** No hay ruta administrativa que la edite.
5. **`admin_profiles` conserva su nombre**; el coste de renombrar supera el beneficio.
6. **Administración alcanza todas las sedes activas por definición**, no por asignación explícita. Solo la vendedora requiere asignación.

---

## 5. Verificación

| Comando | Resultado |
|---|---|
| `npm run db:reset:local` | 24 migraciones + seeds, sin intervención manual |
| `npm run test:db` | **58 aserciones pgTAP · PASS** (32 previas + 18 de organización + 8 de auditoría) |
| `npm run typecheck` · `npm run lint` | Sin errores |

Comprobado además con sesiones simuladas en PostgreSQL:

| Escenario | Resultado |
|---|---|
| Alta de pedido sin indicar sede | `branchId` resuelto a la sede predeterminada |
| Vendedora leyendo la bitácora | **0 filas** |
| Vendedora leyendo empresa y sedes activas | 1 y 1 — necesita el contexto para operar |
| Vendedora leyendo pedidos | 0 filas — siguen siendo administrativos |
| Administración leyendo la bitácora | Ve los asientos generados por los propios seeds |
| Intento de dejar a la empresa sin sede predeterminada | Rechazado con `23514` |
| Intento de editar o borrar la bitácora | Rechazado con `42501` |
