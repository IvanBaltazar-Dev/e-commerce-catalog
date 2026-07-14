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

---

# Fase 2 — Logo real + Catálogo/PDF PREMIUM (en curso, 2026-07-13)

Objetivo: catálogo **beauty premium** (portada editorial + fichas con galería + CTA
WhatsApp + medios de pago) inspirado en `Catalogo_Mystyle_Publico.html`, y un **PDF
premium** generado por **HTML→Chromium** (reemplaza el PDFKit de texto plano). Logo
real de la marca en todas partes. Backend elegido: **Supabase real (nube)**.

## Decisiones tomadas con el usuario

1. **PDF premium** = HTML/CSS → PDF con Chromium (Puppeteer). NO PDFKit.
2. **Backend** = Supabase real en la nube (el usuario lo provisiona; ver README «Configuración»).
3. **Cartas de colores**: los archivos `carta_colores.*` en cada carpeta de producto SON
   la carta. Los PDF grandes de referencia NO se usan como catálogo.
4. **Sin carta**: solo **08-Glam Nails** → `color_chart_status='consult_advisor'`.
   Los otros 10 productos tienen carta (incluidos Mystyle y Candy Secret; esto corrige
   el requisito viejo que los listaba sin carta). Mystyle además tiene su HTML propio.

## Hecho en esta sesión (no requería backend)

- **Logo optimizado**: `F:\...\ChatGPT Image 13 jul 2026, 01_42_50 a.m.png`
  (2.5 MB, 1536×1024, con alfa) → recortado y escalado a `public/brand/logo{,-hero,-sm}.{png,webp}`
  (24 KB / 86 KB). Reemplaza al `public/logo.svg` provisional. **Pendiente cablearlo** en
  login, topbar, portada y catálogo público (ahora mismo la app aún usa `logo.svg`).
- **Pipeline de assets** `scripts/optimize-assets.mjs` (sharp): optimiza logo + 11 productos
  (fotos → JPEG mozjpeg 950px, cartas → JPEG 1500px + thumb 520px) + medios de pago.
  Cherimoya 06/07: cartas de **48 MB → 300 KB**. Salida en `catalog-preview/assets/`.
- **Datos del catálogo** `scripts/catalog-data.mjs`: los 11 productos del brief (marca,
  línea, presentación, tipo, lámpara, precios unidad/mayor, carta, descripción premium).
  ÚNICA fuente de verdad; reutilizable para el seed de Supabase.
- **Plantilla premium** `scripts/build-catalog.mjs` → `catalog-preview/catalogo.html`
  (portada + intro ESMALTES + 11 fichas + cierre con pagos). Playfair Display + Jost,
  paleta magenta/berry/champagne, price-card con degradado, chips, chart-block, CTA verde.
- **Render HTML→PDF** `scripts/render-pdf.mjs` (Puppeteer): `catalog-preview/catalogo.pdf`
  (14 páginas, **8 MB**) + capturas en `catalog-preview/shots/`.
  Nota clave: alimentar el HTML con **JPEG** (no WebP/PNG) mantiene el PDF liviano; con
  WebP Chromium lo incrustaba lossless y pesaba 51 MB.

Regenerar todo: `node scripts/optimize-assets.mjs && node scripts/build-catalog.mjs && node scripts/render-pdf.mjs`

**Actualización (carta + público):**
- El PDF ahora incluye, tras cada ficha, una **página completa de carta de colores** por
  producto (10 cartas; cartas re-optimizadas a 2000px para legibilidad de tonos). Glam Nails
  (sin carta) mantiene el bloque "consultar asesor". PDF ~24 págs, ~11 MB.
- La ficha ya no dice "consultar tonos por WhatsApp"; remite a la página de la carta.
- `public/logo.png` (que la app carga en Topbar/LoginForm/HomeView/PublicShell) se reemplazó:
  pesaba **1.1 MB**, ahora 86 KB (logo real optimizado).
- `src/components/public/ProductView.tsx`: la imagen de galería ahora es **clic→lightbox**
  (antes solo el botón "Ampliar"). El lightbox de pantalla completa YA existía en ese componente,
  junto con el flujo de tonos (surtidos/set/códigos) y "Ver tonos en pantalla completa".
- **Pendiente de verificación visual**: el catálogo público no se pudo abrir en navegador porque
  requiere datos de Supabase (schema sin aplicar). Verificar tras sembrar.

**Hito (Supabase conectado + catálogo verificado):**
- `.env` con llave secreta correcta. Grants aplicados vía `0003_api_grants.sql` (los defaults de
  Supabase no habían otorgado privilegios; hasta service_role daba 42501).
- `scripts/seed-products.mjs` sembró los **11 productos + imágenes** al Storage (`catalog-assets`).
- `scripts/check-supabase.mjs` verifica llaves/tablas/buckets. `scripts/shoot-public.mjs` captura
  el público (desktop+móvil) en `catalog-preview/public-shots/`.
- **Catálogo público VERIFICADO end-to-end** (dev server real): home con 11 productos + filtros +
  búsqueda; ficha con price-cards/selector de tonos; **lightbox click→pantalla completa**; agregar a
  selección → precio por mayor a 3u → "Mi selección" → pedido por WhatsApp. Desktop y móvil
  (grid 2 col + nav inferior). Ya luce premium y consistente con el PDF.
- Arranque dev: `.claude/launch.json` (bellaroshe-dev, :3000).

**Falta:** (a) ~~integrar el PDF premium HTML→Chromium en `/api/admin/pdf/generate`~~ **HECHO**
(ver «Integración PDF admin» abajo); (b) usuario admin (email+UUID en `admin_profiles`) para
probar el panel; (c) Serena re-apuntado.

### Integración PDF admin — HECHO (2026-07-13)

El endpoint `/api/admin/pdf/generate` ya genera el **PDF premium HTML→Chromium** (se retiró
PDFKit). Archivos:
- `src/lib/catalog/pdf-html.ts` — arma el HTML premium (portada + intro + fichas + cartas +
  cierre + CSS) desde datos de Supabase. Fotos por URL pública de `catalog-assets`; logo y
  medios de pago embebidos como data URI leídos de `public/{brand,pagos}`.
- `src/lib/catalog/browser.ts` — lanza Chromium: `@sparticuz/chromium` + `puppeteer-core` en
  serverless (Vercel), `puppeteer` full o `PUPPETEER_EXECUTABLE_PATH` en local.
- `src/lib/catalog/pdf.ts` — `renderCatalogPdf` ahora hace `setContent` + `page.pdf` (A4,
  `printBackground`, `preferCSSPageSize`); espera fotos remotas + `document.fonts.ready`.
- `next.config.mjs` — `serverExternalPackages` (puppeteer*/chromium) + `outputFileTracingIncludes`
  de `public/brand` y `public/pagos` para el trazado serverless. Ruta con `maxDuration = 60`.

Verificado en dev (service-role, sin auth): **PDF A4 de 25 páginas, ~11 MB**, fuentes
Playfair/Jost embebidas, 11 fichas + 10 cartas, tirado en vivo de Supabase. Idéntico en peso a
la vista previa del equipo.

Pendiente de este bloque:
- Probar el flujo **desde el panel admin** (requiere usuario admin, punto (b)) — hoy solo se
  verificó el render por el mismo código, sin pasar por login.
- En Vercel: confirmar plan/duración (el render tardó ~46 s con Edge en frío en local; en
  serverless con imágenes remotas puede acercarse al límite — subir `maxDuration`/memoria si
  hace falta) y que `@sparticuz/chromium@131` levante en la función.
- Posible pulido: el `break-after:page` de la última `.page` deja 1 página en blanco al final
  (mismo comportamiento que la vista previa); quitarlo del último bloque si molesta.

### Blocker del export — RESUELTO (2026-07-13)

Síntoma: el panel no exportaba nada; error **`[42501] permission denied for table pdf_exports`**.
Reproducido corriendo las operaciones del endpoint como el usuario `authenticated` (sesión del
admin generada vía service-role, sin contraseña): el INSERT en `pdf_exports` fallaba con 42501,
aunque la política RLS sí lo permite (el perfil admin es visible) y el Storage funciona.

Causa raíz: los grants iniciales solo otorgaron `SELECT` al rol `authenticated` ("la escritura la
maneja el service_role"). Pero TODOS los endpoints `/api/admin/*` escriben con el cliente de sesión
(`requireAdmin` → rol `authenticated`), no con service_role. Así que no solo el PDF: crear/editar
productos, marcas, categorías y settings fallaban igual con 42501.

Fix (aplicado por el usuario en el SQL Editor y **verificado**: el INSERT como `authenticated` ya
pasa): `grant insert, update, delete` en products/product_images/brands/categories/store_settings/
pdf_exports a `authenticated` (RLS de 0001 sigue restringiendo por fila a `is_admin()`).

### Migraciones consolidadas a 3 .sql (2026-07-13)

Se fusionaron `0002_product_lamp_type` + `0003_color_chart_pdf` + `0003_api_grants` +
`0004_admin_write_grants` en un único **`0002_columns_and_grants.sql`** (columnas + bucket + todos
los grants). Quedan solo 3 .sql: `0001_initial_catalog_backend.sql`, `0002_columns_and_grants.sql`
y `seed.sql`. La BD ya tenía todo aplicado; la consolidación es hygiene de repo, sin acción en BD.

### Salida = catalogo.html — verificado

El PDF/HTML del generador se comparó contra `catalog-preview/shots/` (portada y ficha Masglo):
coincide 1:1 (marca, línea, chips, precios, carta, pie, fotos). Se ajustaron 2 detalles para
igualar exactamente: WhatsApp con espacios (`+51 963 463 550`) y fecha `Julio 2026` (sin "de").

## Pendientes (necesitan Supabase real conectado)

1. **Conectar Supabase**: en `.env`, `SUPABASE_SERVICE_ROLE_KEY` quedó con la llave
   publishable (anon) duplicada — reemplazar por la llave **secreta** `sb_secret_...`.
   Aplicar migraciones `0001` + `0002` (0002 YA existe) + `seed.sql`. El proyecto ya
   responde (Auth OK); falta aplicar el schema (la tabla `brands` da 404).
2. **Sembrar los 11 productos** desde `scripts/catalog-data.mjs` (script nuevo
   `scripts/seed-products.mjs` con service role) y **subir las imágenes optimizadas** al
   bucket `catalog-assets` (main/gallery/color-chart). Crear usuario admin.
3. **Integrar el PDF premium en la app**: portar la plantilla de `build-catalog.mjs` a un
   módulo TS (`src/lib/catalog/pdf-html.ts`) que arme el HTML desde datos de Supabase, y
   reemplazar `renderCatalogPdf` (PDFKit) en `/api/admin/pdf/generate` por un render Chromium.
   - Serverless (Vercel): usar `puppeteer-core` + `@sparticuz/chromium` (el `puppeteer`
     full de dev NO cabe en la función). Alternativa: contenedor Docker de render.
4. ~~**Cablear el logo** `public/brand/logo.*` en `Topbar`, `LoginForm`, portada y shell
   público.~~ **HECHO (2026-07-13):** cada pantalla usa ahora su variante por tamaño —
   `Topbar` y `PublicShell` → `logo-sm`, `LoginForm` → `logo`, hero de `HomeView` → `logo-hero`
   (antes todas cargaban el `/logo.png` grande). Verificado en navegador: variantes 200 OK sin
   404, hero nítido en móvil. `public/logo.png` quedó huérfano (cleanup opcional).
5. **Elevar el catálogo público** (`src/app/(public)/*`, `HomeView/ProductView/SelectionView`)
   a la estética premium (hoy es básico) y **verificar el flujo de pedido** end-to-end
   (cliente → selección → WhatsApp) contra Supabase.
6. **Serena**: está fijado a `ControlLocal`; re-apuntarlo a `D:\init\e-commerce-catalog`
   (sesión interactiva / reinicio MCP con `--project`) para mapear funciones de este repo.

## Assets y rutas clave

- Logo fuente: `F:\products\Bella Roshe\Catalogo\ChatGPT Image 13 jul 2026, 01_42_50 a.m.png`
- Fotos/cartas: `F:\products\Bella Roshe\Catalogo\imagenes_productos\NN-*\` (`carta_colores.*` = carta)
- Medios de pago: `F:\products\Bella Roshe\Catalogo\metodos_pago\` (yape, plin, bcp, bbva, interbank)
- Brief/requisitos: `F:\products\Bella Roshe\Catalogo\*.md`
- Salida preview: `catalog-preview/{catalogo.html,catalogo.pdf,shots/,assets/}`
