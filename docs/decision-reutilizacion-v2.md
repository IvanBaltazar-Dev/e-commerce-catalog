# Decisión de reutilización — Bellaroshé V2

**Bloque 0 · entregable 0.5**
**Rama:** `audit/bellaroshe-v2`
**Fecha:** 2026-08-06
**Base:** `docs/auditoria-plataforma-actual.md`

---

## 1. Veredicto

```text
REUTILIZAR PARCIALMENTE
```

Sin ambigüedad y sin condiciones previas al veredicto: **la plataforma actual se conserva como base y se le construyen encima los dominios que no existen.**

---

## 2. Por qué no es RECONSTRUIR

El plan enumera once síntomas que justificarían una aplicación nueva. Se verificaron uno por uno:

| Síntoma del Resultado C | ¿Presente? | Evidencia |
|---|:---:|---|
| Datos codificados en archivos o componentes | **No** | Todo dato vive en PostgreSQL. Las familias comerciales están en `attribute_templates`; la única duplicación es una lista de etiquetas en la interfaz |
| Modelo exclusivamente diseñado para esmaltes | **No** | `attribute_definitions` tipadas + plantillas por familia + variantes genéricas. El esmalte es un caso, no el esquema |
| Falta total de migraciones | **No** | 21 migraciones versionadas y reproducibles con `supabase db reset` |
| Producción como único entorno | **No** | Local documentado y aislado; toda escritura de script rechaza hosts no locales |
| Claves o secretos comprometidos | **No** | `.env*` fuera de Git; solo plantillas versionadas; `service_role` sin prefijo público y sin uso en `src/` |
| RLS ausente o insegura | **No** | 32/32 tablas con RLS y 61 políticas |
| Aplicación imposible de ejecutar localmente | **No** | Falla por una reserva de puertos del sistema operativo, no por el proyecto |
| Código duplicado y no modular | **No** | `typecheck` y `lint` limpios; frontera explícita en `contracts.ts` |
| Dependencias abandonadas | **No** | Stack vigente. Único residuo: `pdfkit`, sustituido por Chromium |
| Carrito imposible de adaptar | **No** | Ya apunta a variantes y revalida contra `evaluate_cart_v2` |
| Costo de corregir superior al de una base limpia | **No** | Habría que reescribir 6.874 líneas de SQL con integridad y RLS ya probadas |

**Cero de once.** Reconstruir sería destruir valor.

---

## 3. Por qué no es EVOLUCIONAR

El Resultado A exige que solo falten incorporaciones menores. Faltan **cuatro dominios completos**:

- **Proveedores** — 0 tablas.
- **Operación comercial** (ventas con pagos, compras, gastos, reservas, devoluciones, anulaciones, inventario operativo) — 0 tablas. `orders` es un pedido administrativo, no una venta.
- **Canales y omnicanalidad** — 0 tablas.
- **Organización** (sedes con `branch_id`, rol de vendedora, auditoría transversal) — 0 tablas; `app_role` solo tiene `admin` y `developer`.

Esto no es una extensión del catálogo: es la mitad del producto.

---

## 4. Qué se conserva y qué se construye

### Se conserva sin cambios estructurales

| Activo | Razón |
|---|---|
| Repositorio, Next.js 15, React 19, TypeScript estricto | Stack vigente y sano |
| Supabase (PostgreSQL, Auth, Storage) y Vercel | Infraestructura válida |
| Modelo de catálogo V2 completo | Producto/variante, atributos tipados, plantillas, categorías jerárquicas, medios, relaciones, precios con vigencia |
| Contratos SQL | `catalog_list_v2`, `catalog_product_detail_v2`, `evaluate_cart_v2`, `create_product_with_default_variant`, `create_admin_order` |
| Régimen de seguridad | RLS al 100 %, `requireAdmin`/`requireDeveloper`, guardas de script, manejo de secretos |
| Frontera `lib/catalog/contracts.ts` | Permite cambiar la interfaz sin tocar el negocio |
| Identidad visual, layout, componentes generales | `PublicShell`, `Topbar`, `ToastProvider`, `PremiumPagination`, `ImageSlot` |
| Importación por lotes | `import_batches` / `import_rows` / `import_issues` ya implementan el flujo que exige el Bloque 1 |
| Carrito por variante | Ya cumple la regla 4 del plan |

### Se corrige antes de construir encima

| Corrección | Motivo | Esfuerzo |
|---|---|---|
| Commitear las 115 rutas del árbol de trabajo | El activo no está respaldado | Inmediato |
| `PRODUCT_TYPES` leído desde `attribute_templates` | Hoy añadir una familia exige editar código | Bajo |
| Retirar la ruta V1 (`ProductForm`, `ProductListView`, `lib/admin/types.ts`) y la doble escritura de columnas V1 | Dos modelos vivos en paralelo | Medio |
| `next/image` en las imágenes de producto | Hoy se sirven con `<img>` crudo | Bajo |
| Rol `seller` en `app_role` y permisos derivados | El Bloque 2 lo exige | Bajo |
| Auditoría transversal de cambios por usuario | Solo existen 3 columnas `_by` | Medio |
| Pruebas unitarias sin Docker | Hoy ninguna prueba corre sin infraestructura | Medio |
| Documentar infraestructura remota, respaldos y reversión | No hay nada versionado | Bajo |

### Se construye nuevo

| Dominio | Bloque | Nota |
|---|:---:|---|
| Organización: empresa, sedes, usuarios, roles, vendedoras, auditoría | 1 | `branch_id` desde el primer día en toda venta, compra, reserva y disponibilidad |
| Proveedores: contactos, producto-proveedor, costos, escalas, pedidos mínimos, bonificaciones, tiempo de entrega, historial | 1 | Ninguna tabla existe |
| Disponibilidad numérica: cantidad estimada y reservada por variante | 1 | Hoy solo hay `availability_status` cualitativo |
| Venta rápida: carrito interno, pagos, vuelto, nota de venta, solicitud tributaria | 2 | Separada del comprobante fiscal (regla 18) |
| Anulaciones, devoluciones, reservas | 2 | La venta confirmada nunca se elimina (regla 7) |
| Compras y gastos | 2 | — |
| Carrito público persistido con canal, campaña y vendedora | 3 | Hoy vive solo en `localStorage` |
| Canales sociales: `channels`, `channel_accounts`, `channel_conversations`, `channel_messages`, `channel_events`, `channel_attributions` | 3 | Capa de adaptadores, sin duplicar el catálogo |
| Dashboards, rankings, audio, fotografía, asesor, tendencias | 4 | Después de que catálogo, ventas, costos y disponibilidad sean confiables |

---

## 5. Rama de trabajo

Aprobada esta decisión:

```text
audit/bellaroshe-v2            ← esta auditoría (actual)
feature/bellaroshe-platform-v2 ← desarrollo de los Bloques 1 en adelante
```

Antes de abrir la rama de desarrollo hay que resolver las cinco condiciones de cierre listadas en `docs/auditoria-plataforma-actual.md` §7.

---

## 6. Decisiones estructurales que quedan registradas (regla 20)

1. **La variante es la unidad vendible.** Toda venta, reserva, disponibilidad y línea de compra apunta a `product_variants.id`. Se conserva el modelo actual.
2. **Los atributos se declaran como datos, no como columnas.** Ninguna familia nueva justifica un `ALTER TABLE` sobre `products` o `product_variants`. Prohibido crear tablas por familia (regla 3).
3. **La regla comercial vive en PostgreSQL.** Precio, mayorista y disponibilidad se resuelven en funciones SQL invocadas por todos los canales. El frontend nunca decide un importe.
4. **El modelo V1 se retira, no se extiende.** Las columnas `unit_price`, `wholesale_price`, `main_image_path`, `color_chart_image_path`, `requires_lamp`, `presentation`, `product_type` y la tabla `product_images` quedan congeladas y se eliminan en una migración dedicada, una vez que ningún consumidor las lea.
5. **`branch_id` es obligatorio desde la primera tabla del Bloque 1**, aunque exista una sola sede.
6. **Precio y costo conservan valor histórico.** `variant_prices` ya usa `tstzrange`; el mismo criterio aplica a costos de proveedor.
7. **La operación comercial y el comprobante fiscal son módulos separados** y no se conectan al carrito (reglas 17 y 18).
