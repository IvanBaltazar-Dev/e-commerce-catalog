# Inventario de base de datos — Bellaroshé (estado previo a V2 de plataforma)

**Bloque 0 · entregable 0.5**
**Rama:** `audit/bellaroshe-v2`
**Fecha:** 2026-08-06
**Fuente:** `supabase/migrations/0001` … `0022`, `supabase/seed.sql`, `supabase/seeds/0002_v2_demo.sql`
**Entorno analizado:** definiciones versionadas en el repositorio. La verificación en Supabase local está bloqueada por un conflicto de puertos de Windows (ver `docs/riesgos-v2.md`, R-01).

---

## 1. Resumen cuantitativo

| Elemento | Cantidad | Evidencia |
|---|---:|---|
| Migraciones versionadas | 21 archivos (`0001`–`0022`, sin `0003`) | `supabase/migrations/` |
| Líneas de SQL migrado | 6.874 | `grep -c "" supabase/migrations/*.sql` |
| Tablas en `public` | 32 | `grep "^create table public\."` |
| Tablas con RLS habilitada | 32 / 32 (100 %) | `comm` entre tablas creadas y `enable row level security` |
| Políticas RLS | 61 | `grep "create policy"` |
| Funciones `public.*` | 27 | `grep "create or replace function public\."` |
| Triggers | 60 | `grep "^create trigger"` |
| Índices explícitos | 51 | `grep "create index\|create unique index"` |
| Tipos ENUM propios | 14 | `grep "^create type public\."` |
| Buckets de Storage | 2 (`catalog-assets`, `catalog-pdfs`) | `0001_initial_catalog_backend.sql:396,409` |
| Pruebas pgTAP | 32 aserciones en 2 archivos | `supabase/tests/database/` |

> **Nota de estado del repositorio:** las migraciones `0002` y `0004`–`0022`, los seeds V2 y las pruebas pgTAP **no están commiteadas**. Existen únicamente como archivos sin seguimiento en el árbol de trabajo (115 rutas en `git status`). El último commit (`4afd01b`) solo contiene hasta `0001`. Ver `docs/riesgos-v2.md`, R-00.

---

## 2. Mapa tabla → migración de origen

### Núcleo V1 — `0001_initial_catalog_backend.sql`

| Tabla | Rol |
|---|---|
| `admin_profiles` | Perfil y rol del backoffice, PK = `auth.users.id` |
| `brands` | Marcas |
| `categories` | Categorías jerárquicas (`parent_id`) |
| `products` | Producto plano de esmaltes (precio y foto en la fila) |
| `product_images` | Galería V1 por producto |
| `store_settings` | Datos de contacto y textos de tienda |
| `catalog_metadata` | Metadatos de catálogo |
| `pdf_exports` | Historial de exportaciones PDF |

### Núcleo V2 de catálogo — `0005_catalog_v2.sql` (1.942 líneas)

| Tabla | Rol |
|---|---|
| `product_variants` | **Unidad vendible**. Toda compra apunta aquí |
| `attribute_templates` | Plantilla de atributos por familia comercial |
| `attribute_definitions` | Definición tipada de atributo (`data_type`, `scope`, `is_variant_axis`, `validation_rules`) |
| `attribute_options` | Valores controlados por definición |
| `template_attributes` | Qué atributos aplican a qué plantilla |
| `product_attribute_values` | Valor de atributo a nivel producto |
| `variant_attribute_values` | Valor de atributo a nivel variante |
| `price_lists` | Listas de precio (`retail`, `wholesale`, `special`) |
| `variant_prices` | Precio vigente por variante y lista, con `tstzrange` |
| `wholesale_rules` | Regla mayorista con alcance variante/producto/marca/categoría |
| `media_assets` | Archivo físico reutilizable |
| `product_media` | Asociación medio → producto **XOR** variante |
| `product_relations` | Relaciones dirigidas y simétricas entre productos |
| `import_batches` / `import_rows` / `import_issues` | Área de importación por lotes |

### Extensiones posteriores

| Migración | Tablas nuevas | Aporte |
|---|---|---|
| `0006_catalog_v2_contracts.sql` | — | Contratos SQL de listado, detalle, carrito y precios |
| `0007_admin_orders.sql` | `orders`, `order_items` | Pedido administrativo con correlativo y foto histórica de línea |
| `0008_product_registration_foundations.sql` | `product_lines` | Líneas comerciales + 8 plantillas de familia |
| `0009_scoped_brands_and_color_library.sql` | `brand_product_families`, `product_line_product_families`, `color_shades` | Marca/línea reutilizable en varias familias; biblioteca de tonos |
| `0014_conditional_attribute_rules.sql` | `template_attribute_conditions` | Dependencias tipadas entre atributos |
| `0015_product_form_attribute_coherence.sql` | `template_attribute_comparisons` | Comparaciones mínimo/máximo entre atributos |

---

## 3. Tipos ENUM

```text
app_role                    admin (0001) + developer (0016)
product_availability        available | sold_out | consult
product_editorial_status    draft | in_review | published | hidden | incomplete
color_chart_status          (V1, carta de colores)
attribute_data_type         text | integer | decimal | boolean | date
                            single_option | multi_option | color | measurement
attribute_scope             product | variant | both
media_role                  (main, color_chart, gallery, …)
price_list_type             retail | wholesale | special
wholesale_scope_type        variant | product | brand | category
wholesale_mixing_policy     (política de mezcla mayorista)
product_relation_type       (recommended_with, spare_part_of, …)
compatibility_status        (compatibilidad entre productos)
import_batch_status / import_proposed_action / import_row_status
import_issue_severity       info | warning | error | blocking
import_issue_status         open | resolved | ignored
```

---

## 4. Integridad estructural declarada

| Regla | Mecanismo | Evidencia |
|---|---|---|
| Un producto activo tiene exactamente una variante predeterminada | Índice parcial único + trigger diferible | `assert_active_product_has_default_variant` |
| Producto publicado debe estar completo | Trigger de validación | `assert_published_product_complete` |
| Categorías sin ciclos | Trigger `prevent_category_cycle` | `0005` |
| Categorías únicas por `(parent_id, slug)` | Constraint única | `0005` |
| Precios sin vigencias superpuestas | `exclude using gist` sobre `tstzrange` | `variant_prices_no_active_overlap` |
| Un medio pertenece a producto **XOR** variante | Check constraint | `product_media` |
| Valores de atributo validados contra su definición | `validate_attribute_value`, `validate_numeric_attribute_rules` | `0005`, `0015` |
| Dependencias condicionales entre atributos | `enforce_product_attribute_conditions` | `0014` |
| Comparaciones mínimo/máximo entre atributos | `enforce_product_attribute_comparisons` | `0015` |
| Tono coherente con marca y línea | `validate_variant_color_shade_scope`, `validate_color_shade_line_brand` | `0009`, `0010` |
| Variante única por `(product_id, variant_key)` | Constraint única | `0005` |

---

## 5. Funciones de aplicación (contratos SQL)

| Función | Consumida por | Propósito |
|---|---|---|
| `catalog_list_v2` | `GET /api/catalog`, PDF | Listado paginado y filtrado **en PostgreSQL** |
| `catalog_product_detail_v2` | `GET /api/catalog/:slug` | Detalle con variantes activas |
| `evaluate_cart_v2` | `POST /api/catalog/cart/evaluate`, WhatsApp, pedidos | Recalcula precio, disponibilidad y regla mayorista en servidor |
| `create_product_with_default_variant` | Alta admin V2 | Producto + variante + precios en una transacción |
| `replace_default_variant` | Edición admin | Cambia la variante representativa |
| `create_admin_order` | `POST /api/admin/orders` | Evalúa carrito y persiste cabecera + líneas en una transacción |
| `create_color_shade` | Alta guiada | Tono contextual por marca/línea |
| `commit_approved_import_row` | Importación | Convierte fila aprobada en producto real |
| `is_admin` / `is_developer` | 61 políticas RLS | Predicado de autorización |
| `is_public_catalog_product` / `_variant` / `_media` | Políticas RLS públicas | Predicado de visibilidad pública |

---

## 6. Rendimiento

- **Búsqueda:** columna generada `products.search_document tsvector` con índice **GIN**, más índice **trigram** (`gin_trgm_ops`) sobre `products.name`.
- **Paginación:** `catalog_list_v2` aplica `offset/limit` en base de datos y acota `page_size` a un máximo de 100 (`0006_catalog_v2_contracts.sql:22`).
- **Conteos:** `totalItems` y `totalPages` se calculan en la misma función (`:291-292`).
- **Cobertura de índices:** publicación, marca, categoría, slug, `product_id` de variante, SKU, disponibilidad, propietarios de medios, listas de precio y atributos filtrables.
- **Medición documentada:** 1.505 productos, 16 páginas, 867 ms en la consulta de la última página (`docs/CATALOG_V2_IMPLEMENTATION.md` §13). **No reverificada en esta auditoría.**

---

## 7. Storage

| Bucket | Público | Escritura | Lectura |
|---|---|---|---|
| `catalog-assets` | Sí | `public.is_admin()` | Anónima |
| `catalog-pdfs` | No | `public.is_admin()` | `public.is_admin()` |

Las rutas `demo/*` de los seeds son marcadores; el seed modela asociaciones pero no carga binarios.

---

## 8. Huecos frente a los Bloques 1–4 del plan

Búsqueda exhaustiva sobre las 21 migraciones. Ninguna de estas entidades existe:

| Dominio requerido | Bloque | Tablas presentes |
|---|---|---|
| Proveedores, contactos, producto-proveedor, costos, escalas, bonificaciones, tiempo de entrega | 1 | **0** |
| Sedes / `branch_id` en toda operación | 1 | **0** |
| Vendedoras (rol) y asignación | 1 / 2 | **0** — `app_role` solo tiene `admin` y `developer` |
| Auditoría transversal de cambios por usuario | 1 / 5 | **0** tabla de auditoría. Solo 3 columnas `_by`: `orders.created_by`, `import_batches.created_by`, `pdf_exports.generated_by` |
| Ventas, pagos, vuelto, nota de venta, solicitud tributaria | 2 | **0** — `orders` es un pedido administrativo, no una venta con pagos |
| Anulaciones y devoluciones | 2 | **0** |
| Reservas y adelantos | 2 | **0** |
| Compras, órdenes, recepción, faltantes, crédito, deuda | 2 | **0** |
| Gastos | 2 | **0** |
| Disponibilidad numérica / reservada (inventario operativo) | 1 / 2 | **0** — solo `availability_status` cualitativo por variante |
| Historial de precios y de costos | 1 | Parcial: `variant_prices` conserva vigencias con `tstzrange`; no hay costos |
| Canales, conversaciones, mensajes, atribución | 3 | **0** |
| Carrito público persistido con origen | 3 | **0** — el carrito vive solo en `localStorage` |

---

## 9. Deuda técnica de datos

1. **Columnas V1 vivas dentro de `products`:** `unit_price`, `wholesale_price`, `wholesale_min_quantity`, `main_image_path`, `color_chart_image_path`, `requires_lamp`, `presentation`, `product_type`, `availability`, `color_chart_status`. El alta V2 las sigue escribiendo por compatibilidad (`src/lib/admin/catalog-v2-service.ts:507-512`).
2. **Tabla `product_images` (V1)** coexiste con `media_assets` + `product_media` (V2).
3. **Falta la migración `0003`** en la secuencia; el salto no está documentado en `supabase/migrations/README.md`.
4. **`supabase/migrations/README.md` está desactualizado:** no documenta `0016_add_developer_role`, `0017_developer_permissions_and_import_audit` ni `0018_catalog_assets_pdf_media`, pese a que la regla de mantenimiento del propio archivo exige documentar cada cambio.

> `0019_json_attribute_values.sql` tiene una sola línea (`alter type … add value 'json'`) y **es correcto así**: PostgreSQL no admite usar un valor de enum recién agregado dentro de la misma transacción, por lo que debe ir aislado.
