# Arquitectura actual — Bellaroshé

**Bloque 0 · entregable 0.5**
**Rama:** `audit/bellaroshe-v2`
**Fecha:** 2026-08-06

---

## 1. Stack verificado

| Capa | Tecnología | Versión declarada | Versión instalada |
|---|---|---|---|
| Framework | Next.js App Router | `^15.2.4` | **15.5.20** |
| UI | React | `^19.0.0` | **19.2.7** |
| Lenguaje | TypeScript | `^5.8.2` | **5.9.3**, `strict: true` |
| Runtime | Node.js | `24.x` (engines) | **v24.16.0** |
| Datos / Auth / Storage | Supabase | `supabase-js ^2.49.4` / `ssr ^0.6.1` | **2.110.2** / **0.6.1** |
| Validación | Zod | `^3.24.2` | **3.25.76** |
| PDF | `puppeteer-core` + `@sparticuz/chromium` | 24.43.1 / 148.0.0 | idem |
| Imágenes | `sharp` | 0.35.3 | idem |
| XLSX / ZIP | `saxes`, `yauzl` | — | idem |
| Despliegue | Vercel | — | Sin `vercel.json`/`vercel.ts` en el repositorio |

`tsconfig.json` es estricto: `strict: true`, `isolatedModules`, `noEmit`, `moduleResolution: bundler`, alias `@/* → ./src/*`.

Dependencias abandonadas o vulnerables detectadas: **ninguna evidente**. `pdfkit` y `@types/pdfkit` permanecen instalados aunque el generador vigente es HTML→Chromium; son residuo, no riesgo.

## 2. Diagrama de capas

```
┌──────────────── NAVEGADOR ────────────────┐
│ Público: HomeView · ProductView           │
│          SelectionView (carrito local)    │
│ Admin:   CatalogV2ProductForm · QuickOrder│
└───────────────────┬───────────────────────┘
                    │ fetch /api/*
┌───────────────────▼───────────────────────┐
│ NEXT.JS (Node runtime, force-dynamic)     │
│  middleware.ts → refresca sesión          │
│  /api/catalog/*   sin auth, RLS decide    │
│  /api/admin/*     requireAdmin / Developer│
│  lib/catalog/contracts.ts ← frontera      │
└───────────────────┬───────────────────────┘
                    │ supabase-js (anon o sesión)
┌───────────────────▼───────────────────────┐
│ POSTGRESQL (Supabase)                     │
│  61 políticas RLS · 32 tablas             │
│  Contratos: catalog_list_v2               │
│             catalog_product_detail_v2     │
│             evaluate_cart_v2              │
│             create_product_with_default_… │
│             create_admin_order            │
│  60 triggers de integridad                │
└───────────────────────────────────────────┘
        Storage: catalog-assets · catalog-pdfs
```

## 3. Decisión arquitectónica dominante: la lógica vive en PostgreSQL

Es el rasgo que define esta plataforma y el que determina su reutilización.

- El listado público **no descarga productos al navegador**: `catalog_list_v2` filtra, ordena, pagina y cuenta dentro de la base (`src/app/api/catalog/route.ts:22-31`).
- El precio y la regla mayorista **se recalculan en servidor** antes de cada acción comercial: `evaluate_cart_v2` se invoca desde el carrito, desde WhatsApp y desde el alta de pedido. El navegador nunca decide un importe.
- La creación de un producto es **atómica en base de datos**: `create_product_with_default_variant` crea producto, variante predeterminada y precios en una transacción. Ningún endpoint administrativo puede crear un producto sin variante.
- La coherencia de atributos se valida **tres veces** —interfaz, servicio y PostgreSQL— y la base es la última palabra (`enforce_product_attribute_conditions`, `enforce_product_attribute_comparisons`).

Consecuencia: la regla comercial no está duplicada en componentes y el frontend es sustituible sin reescribir el negocio. Esto es exactamente lo que el Bloque 1 necesita como fundamento.

## 4. Modelo de catálogo

```
categories (jerárquicas, sin ciclos)
    └─ attribute_templates ─── template_attributes ─── attribute_definitions
                                                            └─ attribute_options
brands ─┬─ brand_product_families ─── (familia comercial)
        ├─ product_lines ─── product_line_product_families
        └─ color_shades (biblioteca de tonos por marca/línea)

products ──┬── product_attribute_values
           ├── product_media ──┐
           ├── product_relations│
           ├── wholesale_rules  │   media_assets
           └── product_variants ┴───┘
                    ├── variant_attribute_values
                    ├── variant_prices ─── price_lists
                    └── order_items ─── orders
```

**Producto ≠ variante.** La variante es la unidad vendible; el producto es el agrupador editorial. Un esmalte es un producto con N variantes-tono, no N productos.

**Los atributos no son columnas.** `attribute_definitions` los tipa (`text`, `integer`, `decimal`, `boolean`, `date`, `single_option`, `multi_option`, `color`, `measurement`, `json`), les asigna alcance (`product` / `variant` / `both`) y marca cuáles son eje de variante, filtrables o buscables. Las plantillas se crean con `INSERT`, no con `ALTER TABLE`.

## 5. Seguridad

| Control | Implementación |
|---|---|
| Autenticación | Supabase Auth + cookies SSR (`@supabase/ssr`) |
| Autorización de aplicación | `requireAdmin()` / `requireDeveloper()` en cada ruta `/api/admin/*` |
| Autorización de datos | 61 políticas RLS sobre 32/32 tablas |
| Predicados RLS | `is_admin()`, `is_developer()`, `is_public_catalog_product/_variant/_media()` |
| `service_role` | Definido en `lib/supabase/service.ts`, **sin ninguna invocación en `src/`** |
| Secretos | `.env`, `.env*.local` y `.env.remote` en `.gitignore`; no hay archivos de entorno con secretos versionados |
| Prefijo público | `SUPABASE_SERVICE_ROLE_KEY` nunca lleva `NEXT_PUBLIC_` |
| Función de riesgo tras bandera | Importador XLSX: rol `developer` **y** `ENABLE_CATALOG_IMPORTS=true`, con 404 si falta cualquiera |
| Guarda de scripts | Host local obligatorio; remoto exige `--allow-remote` + `--confirm-project` |

Visibilidad pública: un producto se ve solo si `is_active = true` **y** `editorial_status = 'published'`, evaluado dentro de la política, no en el cliente.

## 6. Entornos

| Entorno | Configuración | Estado |
|---|---|---|
| Local (app) | `.env.local` → `http://127.0.0.1:54321` | Definido |
| Local (scripts) | `.env.supabase.local` | Definido |
| Remoto | `.env.remote.example` como plantilla sin secretos | Documentado, no usado en esta auditoría |
| Producción | Vercel + Supabase remoto | **Sin configuración versionada en el repositorio** |
| Prueba / staging | — | **No existe** |

## 7. Debilidades arquitectónicas

1. **Frontera Next.js ↔ PostgreSQL sin tipos generados.** Los contratos de `contracts.ts` se escriben a mano; nada garantiza que coincidan con el JSON que devuelven las funciones SQL. Un cambio en `catalog_list_v2` no rompe la compilación.
2. **Familias comerciales duplicadas.** Existen como datos (`attribute_templates`) y como arreglo hardcodeado en la interfaz (`CatalogV2ProductForm.tsx:38-47`). El modelo es extensible; la pantalla no.
3. **Doble modelo vivo.** V1 (`products.unit_price`, `product_images`) y V2 (`variant_prices`, `product_media`) coexisten; el alta V2 escribe ambos.
4. **Sin dimensión organizativa.** No hay `branch_id`, ni rol de vendedora, ni auditoría transversal. El Bloque 1 los exige desde el primer día.
5. **Carrito solo en navegador.** `localStorage` sin persistencia ni origen de captación. El Bloque 3 exige registrar canal, campaña y vendedora asignada.
6. **`orders` no es una venta.** Es un pedido administrativo sin pagos, sin vuelto, sin comprobante ni solicitud tributaria.
7. **Sin capa de pruebas independiente de infraestructura.** Toda prueba exige Docker + Supabase local levantado.
