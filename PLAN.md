# Plan de implementación — Panel Admin Bellaroshé

Fuente de diseño: proyecto Claude Design «Bellaroshé» → archivo `Bellaroshé Admin.dc.html`.
Este plan implementa ese diseño con **frontend real (Next.js App Router)** conectado al
**backend existente (Supabase + API admin)**, más los ajustes de backend necesarios.

## Estado de partida

- Backend completo: esquema Postgres con RLS (`supabase/migrations/0001_initial_catalog_backend.sql`),
  buckets de Storage, API admin (`/api/admin/*`), API pública (`/api/catalog/*`), server actions y
  middleware de sesión Supabase.
- Frontend inexistente: no hay `layout.tsx` ni ninguna página.

## Pantallas del diseño a implementar

| Pantalla del diseño | Ruta implementada |
| --- | --- |
| Admin · Inicio de sesión | `/admin/login` |
| Admin · Productos (lista, búsqueda, filtros, publicar/ocultar) | `/admin/productos` |
| Admin · Editar producto (crear/editar, imágenes, carta) | `/admin/productos/nuevo` y `/admin/productos/[id]` |
| Admin · Catálogo PDF (estado, generar, vista previa, descargar) | `/admin/pdf` |
| Toast global | Provider compartido del panel |

`/admin` redirige a `/admin/productos`. `/` queda como portada mínima con enlace al panel
(el catálogo público pertenece a otro archivo de diseño y no entra en este alcance).

## Mapeo diseño → modelo de datos

| Campo del diseño | Columna / API |
| --- | --- |
| Código | `products.code` |
| Marca (texto libre) | `products.brand_id` — *find-or-create* en `brands` por nombre |
| Nombre / línea | `products.name` |
| Presentación | `products.presentation` |
| Tipo de esmalte (chips) | `products.product_type` + *find-or-create* en `categories` |
| ¿Requiere lámpara? (No / Sí / UV/LED) | `products.lamp_type` (nueva) + `requires_lamp` derivado |
| Disponibilidad (Disponible / Agotado) | `products.availability` (`available` / `sold_out`) |
| Precio unidad / mayor / mínimo | `unit_price` / `wholesale_price` / `wholesale_min_quantity` |
| Descripción comercial | `products.description` |
| Imagen 01 · Principal | `products.main_image_path` |
| Imagen 02 · Detalle y 04 · Set | `product_images` (galería, sort 1 y 2) |
| Imagen 03 · Tonos | `products.color_chart_image_path` |
| Carta de colores (toggle) | `products.color_chart_status` (`available` / `consult_advisor`) |
| Publicado / Oculto | `products.is_active` |
| Estado del PDF | `pdf_exports.status` + `isStale` de `/api/admin/pdf` |

## Cambios de backend

1. **Migración `0002_product_lamp_type.sql`**: columna `products.lamp_type text`
   (valores `No`, `Sí`, `UV/LED`) con backfill desde `requires_lamp` y constraint de valores.
   `requires_lamp` se mantiene (compatibilidad con API pública y PDF) y se deriva de `lamp_type`.
2. **`src/lib/catalog/validation.ts`**: `lampType` opcional en create/update de producto.
3. **`src/lib/catalog/product-service.ts`**: persistir `lamp_type`, derivar `requires_lamp`,
   incluirla en `PRODUCT_SELECT`.

El resto del backend ya cubre el diseño (CRUD productos, marcas, categorías, upload por URL
firmada, settings y PDF) y no se toca.

## Frontend nuevo

- `src/app/layout.tsx` — layout raíz: fuentes Poppins/Jost (link de Google Fonts, como el diseño),
  fondo degradado rosa del diseño, metadata.
- `src/app/globals.css` — tokens de color del diseño, animaciones `br-fade`/`br-toast`/`br-spin`,
  estilos de inputs/botones/chips/filas traducidos del diseño.
- `src/app/page.tsx` — portada mínima con enlace al panel.
- `src/app/admin/page.tsx` — redirect a `/admin/productos`.
- `src/app/admin/login/page.tsx` — login (client component).
- `src/app/admin/(panel)/layout.tsx` — guard server-side (sesión + `admin_profiles`; si no,
  redirect a login) + topbar + ToastProvider.
- `src/app/admin/(panel)/productos/page.tsx` — lista.
- `src/app/admin/(panel)/productos/nuevo/page.tsx` + `[id]/page.tsx` — formulario compartido.
- `src/app/admin/(panel)/pdf/page.tsx` — gestión del PDF.
- `src/components/admin/*` — `Topbar`, `ToastProvider`, `ProductForm`, `ImageSlot`, `LogoutButton`.
- `src/lib/supabase/browser.ts` — cliente Supabase de navegador (cookies compartidas con el server).
- `src/lib/admin/api.ts` + `types.ts` — cliente fetch tipado de `/api/admin/*`, mapeos
  producto↔formulario, estado del PDF y URLs públicas de Storage.
- `public/logo.png` — logo importado del proyecto de diseño.

## Decisiones (desviaciones deliberadas del prototipo)

- **Auth real** con Supabase (`signInWithPassword` + verificación en `admin_profiles`), en lugar de
  las credenciales fijas y `sessionStorage` del prototipo. El bloque «Acceso de prueba» del diseño
  se sustituye por un aviso de acceso restringido: no se publican credenciales en la página.
- **Persistencia real** en Postgres vía la API (el prototipo usaba `localStorage`).
- **Rutas reales** en vez de estado SPA: misma UI, URLs navegables y guard por layout.
- **Subida de imágenes** en el momento de seleccionar archivo, con URL firmada de
  `/api/admin/assets/upload-url` (kind `product-image` / `color-chart`).
- **Estado del PDF** derivado del backend: `generating` → «Generando», `updated` + `isStale=false`
  → «Actualizado», `updated` + `isStale=true` → «Desactualizado», `error` → «Error», sin registros
  → «No generado». «Vista previa» y «Descargar» usan la URL firmada de descarga.
- **«Ver catálogo ↗»** apunta a `/` (placeholder hasta implementar el catálogo público).

## Verificación

1. `npm run typecheck`, `npm run lint`, `npm run build`.
2. Dev server + revisión visual de las cuatro pantallas contra el diseño.
3. Si hay entorno Supabase disponible, prueba E2E: login → crear producto con imágenes →
   publicar/ocultar → generar y descargar PDF.

## Puesta en marcha (requisitos del entorno)

- `.env` con `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (ver `.env.example`).
- Migraciones + seed aplicados (`supabase db push` / `supabase db reset`).
- Usuario admin creado en Supabase Auth y registrado en `admin_profiles` (ver README).

## Resultado de la verificación (2026-07-13)

Ejecutado en este entorno:

- ✅ `npm run typecheck` — sin errores.
- ✅ `npm run lint` — sin errores.
- ✅ `npm run build` — compila; todas las rutas del panel y la API registradas.
- ✅ Dev server + navegador: `/` renderiza la portada; `/admin` redirige a
  `/admin/login` (guard); el login renderiza fiel al diseño (fuentes Poppins/Jost
  cargadas, degradado de fondo, tarjeta 24px, botón con el gradiente exacto).
- ✅ Validaciones del login: envío vacío muestra «Ingresa tu correo y contraseña…»;
  con credenciales y sin backend alcanzable muestra el error de conexión traducido.
- ⏳ Pendiente (requiere un proyecto Supabase real): login completo, CRUD de
  productos con subida de imágenes y generación/descarga del PDF. Pasos: llenar
  `.env`, aplicar migraciones + seed, crear el usuario admin en Auth e insertarlo
  en `admin_profiles`, y recorrer las cuatro pantallas.

Notas de esta ejecución:

- El PNG del logo del proyecto de diseño supera el límite de descarga de la API
  (256 KiB) y llega truncado, así que se generó `public/logo.svg` (wordmark con la
  paleta de la marca) como reemplazo drop-in. Sustituir por el arte final.
- Se creó `.env` local con valores placeholder para poder compilar y probar la UI;
  reemplazar por credenciales reales.
- Se quitó `PLAN.md` de `.gitignore` para que este plan quede en el repositorio.
