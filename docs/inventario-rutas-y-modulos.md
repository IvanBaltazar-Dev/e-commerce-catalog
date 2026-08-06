# Inventario de rutas y módulos — Bellaroshé

**Bloque 0 · entregable 0.5**
**Rama:** `audit/bellaroshe-v2`
**Fecha:** 2026-08-06
**Alcance:** 94 archivos TypeScript/TSX, 11.814 líneas en `src/`

---

## 1. Rutas públicas

| Ruta | Archivo | Datos | Estado |
|---|---|---|---|
| `/` | `src/app/(public)/page.tsx` → `components/public/HomeView.tsx` | `GET /api/catalog` (V2) | Operativa |
| `/producto/:slug` | `src/app/(public)/producto/[slug]/page.tsx` → `ProductView.tsx` | `GET /api/catalog/:slug` (V2) | Operativa |
| `/seleccion` | `src/app/(public)/seleccion/page.tsx` → `SelectionView.tsx` | `localStorage` + `POST /api/catalog/cart/evaluate` | Operativa |

El `<title>` de la portada sigue anclado a esmaltes: *"Catálogo Bellaroshé — Esmaltes de marca por mayor y menor"* (`src/app/(public)/page.tsx:6-8`). Es texto, no estructura.

## 2. Rutas administrativas

| Ruta | Archivo | Rol exigido | Estado |
|---|---|---|---|
| `/admin/login` | `src/app/admin/login/page.tsx` | — | Operativa |
| `/admin` | `src/app/admin/page.tsx` | admin | Operativa |
| `/admin/productos` | `(panel)/productos/page.tsx` → `ProductListView.tsx` | admin | **Lee columnas V1** (`unit_price`, `main_image_path`) |
| `/admin/productos/nuevo` | `(panel)/productos/nuevo/page.tsx` → `CatalogV2ProductForm.tsx` | admin | Alta guiada V2 — foco operativo actual |
| `/admin/productos/:id` | `(panel)/productos/[id]/page.tsx` | admin | Edición/duplicación V2 |
| `/admin/pedidos` | `(panel)/pedidos/page.tsx` → `QuickOrderView.tsx` | admin | Pedido administrativo |
| `/admin/pdf` | `(panel)/pdf/page.tsx` → `PdfView.tsx` | admin | Exportación PDF V2 |
| `/admin/estructura` | `(panel)/estructura/page.tsx` | admin | Redirige a `/admin/productos/nuevo` |
| `/admin/importaciones` | `(panel)/importaciones/page.tsx` → `CatalogImportView.tsx` | **developer** + `ENABLE_CATALOG_IMPORTS=true` | Oculta por defecto (`notFound()`) |

## 3. API

### Pública — sin autenticación, protegida por RLS

| Endpoint | Implementación | Ejecución |
|---|---|---|
| `GET /api/catalog` | `rpc("catalog_list_v2")` | Filtro, orden, paginación y conteos **en PostgreSQL** |
| `GET /api/catalog/:slug` | `rpc("catalog_product_detail_v2")` | Detalle + variantes activas |
| `GET /api/catalog/taxonomy` | Consulta directa | Marcas y rutas de categoría |
| `POST /api/catalog/cart/evaluate` | `rpc("evaluate_cart_v2")` | Recalcula precio y regla mayorista en servidor |
| `POST /api/catalog/whatsapp` | `evaluate_cart_v2` + `lib/catalog/whatsapp.ts` | Generador único de mensaje |
| `GET /api/health` | — | Sonda |
| `GET /api/auth/callback` | Supabase SSR | Intercambio de sesión |

### Administrativa — 18 endpoints, **todos con guarda de servidor**

```
/api/admin/brands            [id]           requireAdmin
/api/admin/categories        [id]           requireAdmin
/api/admin/products          [id]           requireAdmin
/api/admin/catalog-v2/products  [id]        requireAdmin
/api/admin/catalog-v2/structure             requireAdmin
/api/admin/catalog-v2/relations             requireAdmin
/api/admin/catalog-v2/bootstrap             requireAdmin
/api/admin/orders            [id]           requireAdmin
/api/admin/pdf   /generate   /[id]/download requireAdmin
/api/admin/assets/upload-url                requireAdmin
/api/admin/settings/contact                 requireAdmin
/api/admin/importaciones/preview            requireDeveloper + flag
/api/admin/importaciones/commit             requireDeveloper + flag
/api/admin/importaciones/template           requireDeveloper + flag
/api/admin/importaciones/media/preview      requireDeveloper + flag
/api/admin/importaciones/media/commit       requireDeveloper + flag
```

Verificación automatizada: ninguna ruta bajo `src/app/api/admin/` carece de guarda. Las cinco rutas de importación usan `requireCatalogImportDeveloper()` (`src/lib/auth/catalog-import.ts:12-17`), que exige rol `developer` **y** `ENABLE_CATALOG_IMPORTS=true`, devolviendo 404 en caso contrario.

## 4. Módulos de `src/lib`

| Módulo | Archivos | Responsabilidad | Reutilizable en V2 |
|---|---:|---|---|
| `lib/catalog/contracts.ts` | 1 | Contratos de aplicación separados del modelo crudo | **Sí — pieza clave** |
| `lib/catalog/*` | 8 | Producto, taxonomía, validación, slug, WhatsApp, PDF | Sí, con ajustes |
| `lib/admin/catalog-v2*.ts` | 2 | Servicio de alta/edición V2 | Sí |
| `lib/admin/catalog-import-*.ts` | 3 | Importación XLSX (lectura, tipos, servicio) | Sí |
| `lib/admin/catalog-media-*.ts` | 2 | Medios y ZIP de imágenes | Sí |
| `lib/admin/relation-*.ts` | 2 | Contexto y recomendaciones de relaciones | Sí |
| `lib/admin/orders.ts` | 1 | Pedido administrativo | Parcial — no es una venta |
| `lib/auth/*` | 2 | `requireAdmin`, `requireDeveloper`, flag de importación | Sí — ampliar con rol vendedora |
| `lib/supabase/*` | 3 | Cliente navegador, servidor y `service_role` | Sí |
| `lib/env/*` | 2 | Validación de entorno con Zod | Sí |
| `lib/api/{http,errors}.ts` | 2 | `HttpError`, respuestas normalizadas | Sí |
| `lib/admin/types.ts` | 1 | Tipos V1 (`unit_price`, `main_image_path`, `requires_lamp`) | **A retirar** |

## 5. Componentes

| Componente | Líneas aprox. | Observación |
|---|---:|---|
| `admin/CatalogV2ProductForm.tsx` | El más grande del proyecto | Contiene `PRODUCT_TYPES`, lista **hardcodeada** de las 8 familias comerciales (`:38-47`). Añadir una familia nueva exige editar este arreglo |
| `admin/CatalogImportView.tsx` | — | Vista de importación |
| `admin/ProductForm.tsx` / `ProductListView.tsx` | — | **Ruta V1**: leen `product.unit_price`, `product.main_image_path`, `product.requires_lamp` |
| `public/SelectionProvider.tsx` | — | Carrito por `variantId + purchaseMode`, `localStorage`, `STORAGE_VERSION = 2` |
| `public/HomeView.tsx` / `ProductView.tsx` / `SelectionView.tsx` | — | Consumen contratos V2 |
| `PremiumPagination.tsx`, `ImageSlot.tsx`, `ToastProvider.tsx`, `Topbar.tsx`, `icons.tsx` | — | Genéricos, reutilizables |

## 6. Scripts operativos (`scripts/`, 24 archivos `.mjs`)

| Grupo | Scripts |
|---|---|
| Pruebas de contrato y flujo | `test-v2-contracts`, `test-v2-admin-flow`, `test-v2-scale`, `test-product-registration-ui` |
| Importación | `test-catalog-import-{flow,xlsx,access}`, `test-catalog-media-{flow,zip}`, `finalize-import-template` |
| Relaciones | `test-relation-{context,recommendations}` |
| Backfill V1→V2 | `seed-v1-backfill-fixtures`, `verify-v1-backfill`, `test-v1-backfill.ps1` |
| Utilidades | `check-supabase`, `grant-admin`, `seed-products`, `cleanup-v2-test-data` |

Todos cargan `.env.supabase.local` y aplican la guarda de host local de `scripts/lib/supabase-script-env.mjs`. La escritura contra remoto exige simultáneamente `--allow-remote` y `--confirm-project=<PROJECT_REF>`.

## 7. Middleware

`middleware.ts` refresca la sesión de Supabase en cada petición no estática. **No autoriza**: la autorización vive en cada ruta (`requireAdmin`) y en RLS. Es la separación correcta, pero implica que una ruta nueva sin guarda quedaría abierta hasta donde RLS lo permita.

## 8. Cobertura de pruebas

| Tipo | Cobertura | Limitación |
|---|---|---|
| pgTAP | 32 aserciones: constraints, RLS, importación, reglas | Exige Supabase local |
| Scripts de integración `.mjs` | Login real, alta, carrito, pedido, PDF, escala (1.505 productos) | Exigen Supabase local + servidor |
| `npm run typecheck` | **Pasa sin errores** (verificado en esta auditoría) | — |
| `npm run lint` | **Pasa sin errores** (verificado en esta auditoría) | — |
| Pruebas unitarias | **Ninguna** | No hay Vitest/Jest; no existe prueba ejecutable sin base de datos |

## 9. Rutas y módulos ausentes para los Bloques 1–4

Ninguna ruta, endpoint ni módulo cubre: proveedores, compras, gastos, ventas con pagos, anulaciones, devoluciones, reservas, inventario operativo, sedes, canales sociales, dashboards ni IA. El alcance actual termina en catálogo + pedido administrativo + PDF.
