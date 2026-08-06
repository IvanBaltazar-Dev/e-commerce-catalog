# Auditoría de la plataforma actual — Bellaroshé

**Bloque 0 del Plan de desarrollo de la plataforma Bellaroshé**
**Rama:** `audit/bellaroshe-v2` (creada desde `feature/product-data-modeling`)
**Fecha:** 2026-08-06
**Auditor:** equipo de desarrollo
**Producción:** no modificada. No se ejecutó `db push`, ni migraciones, ni seeds, ni scripts contra remoto.

---

## 0. Hallazgo previo que condiciona toda la auditoría

El plan asume que se audita "una plataforma web desplegada que muestra principalmente esmaltes". **Eso ya no describe el repositorio.**

El árbol de trabajo contiene una reescritura de catálogo —"Catálogo V2"— sustancialmente completa y **sin commitear**:

| Evidencia | Dato |
|---|---|
| Rutas modificadas o nuevas sin commitear | **115** (`git status --short`) |
| Migraciones no commiteadas | `0002`, `0004`–`0022` (20 archivos, 6.402 líneas SQL) |
| Último commit | `4afd01b chore: consolidate initial database migration` — solo contiene hasta `0001` |
| Tablas nuevas frente a `main` | 24 de 32 |

Es decir: lo desplegado en producción es el catálogo plano de esmaltes; lo que hay en disco es un modelo de producto genérico, con variantes, atributos tipados y plantillas por familia. **La auditoría evalúa lo que está en disco**, porque es el candidato real a reutilización, y señala por separado lo que está en producción.

Consecuencia inmediata: **el activo más valioso del proyecto no está respaldado en Git.** Ver `docs/riesgos-v2.md`, R-00.

---

## 1. Inventario técnico (0.1)

Detalle completo en `docs/arquitectura-actual.md`, `docs/inventario-rutas-y-modulos.md` y `docs/inventario-base-datos.md`. Resumen:

| Dimensión | Estado |
|---|---|
| Next.js 15.5.20 · React 19.2.7 · TypeScript 5.9.3 `strict` · Node 24.16.0 | Vigentes, sin dependencias abandonadas relevantes |
| `src/`: 94 archivos, 11.814 líneas | Modular: `app/` · `components/` · `lib/{catalog,admin,auth,supabase,env,api}` |
| Base de datos: 32 tablas, 61 políticas RLS, 27 funciones, 60 triggers, 51 índices | RLS al 100 % de cobertura |
| Migraciones: 21 archivos reproducibles con `supabase db reset` | Falta `0003`; README desactualizado en `0016`–`0018` |
| Pruebas: 32 aserciones pgTAP + 24 scripts de integración | Sin pruebas unitarias; todas exigen Docker |
| `npm run typecheck` | **Pasa sin errores** (ejecutado en esta auditoría) |
| `npm run lint` | **Pasa sin errores** (ejecutado en esta auditoría) |
| Infraestructura versionada | Sin `vercel.json`/`vercel.ts`; sin entorno de prueba; sin procedimiento de reversión documentado |

---

## 2. Las 30 preguntas (0.2)

### Catálogo

| # | Pregunta | Respuesta | Evidencia |
|---:|---|---|---|
| 1 | ¿Separación real entre producto y variante? | **Sí** | Tabla `product_variants` propia; `order_items.variant_id`; `CartLine` se identifica por `variantId + purchaseMode` (`src/lib/catalog/contracts.ts`). Un índice parcial y un trigger diferible garantizan exactamente una variante predeterminada activa por producto |
| 2 | ¿Un esmalte y sus tonos están bien modelados, o cada tono es un producto? | **Bien modelados** | Un esmalte es **un** producto con N variantes-tono. `color_shades` es una biblioteca normalizada por marca/línea (`0009`), enlazada a la variante exacta y con integridad forzada (`validate_variant_color_shade_scope`, `0010`) |
| 3 | ¿Puede manejar pestañas por curva, grosor y longitud? | **Sí, por diseño** | Plantilla `EXTENSIONES_PRO` ("curva, grosor, longitud y color", `0008:48`). Los atributos con `is_variant_axis = true` generan combinaciones. **Pendiente de comprobación empírica** (§3) |
| 4 | ¿Puede manejar químicos, equipos, accesorios y repuestos? | **Parcial** | Existen `ADHESIVO_PRO`, `LAMPARA`, `TORNO_ELECTRICO`, `MAQUINA_CORTE`, `ACCESORIO_REPUESTO`. **No** existen plantillas para polygel, ceras/depilación, maquillaje ni cuidado facial. Crearlas es `INSERT`, no `ALTER TABLE` |
| 5 | ¿Las categorías son jerárquicas? | **Sí** | `categories.parent_id`, vista recursiva `category_paths`, unicidad `(parent_id, slug)`, trigger `prevent_category_cycle` |
| 6 | ¿Los atributos están escritos como columnas fijas? | **No en V2; sí residualmente en V1** | V2 usa `attribute_definitions` tipadas (10 tipos de dato, alcance producto/variante/ambos, reglas en `jsonb`). V1 conserva columnas fijas vivas: `requires_lamp`, `presentation`, `product_type`, `color_chart_status` |
| 7 | ¿El código depende de nombres como `color`, `tono` o `esmalte`? | **Sí, en presentación; no en estructura** | `CatalogV2ProductForm.tsx:869-887` deriva 8 etiquetas de `isEnamel = template.code === "ESMALTE_TONOS"`. El `<title>` de la portada dice "Esmaltes de marca" (`app/(public)/page.tsx:6`). Ninguna tabla, contrato ni consulta depende del dominio esmalte |
| 8 | ¿Puede una variante tener hasta cinco fotografías? | **Sí, sin límite superior** | `product_media` N:N contra `media_assets`, con `product_id XOR variant_id`, `sort_order` e `is_primary`. No hay constraint que tope en 5 —si el tope es un requisito, hay que añadirlo |
| 9 | ¿Puede un producto relacionarse con varios proveedores? | **No** | Búsqueda exhaustiva sobre las 21 migraciones: **cero** ocurrencias de `supplier`/`proveedor`. No existe el dominio |
| 10 | ¿El carrito apunta a productos o a variantes vendibles? | **A variantes** | `SelectionProvider.tsx` descarta toda línea sin `variantId`; `STORAGE_VERSION = 2` invalida el estado V1 por ser inmigrable |

### Seguridad

| # | Pregunta | Respuesta | Evidencia |
|---:|---|---|---|
| 11 | ¿Las tablas públicas tienen RLS? | **Sí, 32 de 32** | Comparación automatizada entre `create table public.*` y `enable row level security`: diferencia vacía. 61 políticas |
| 12 | ¿El administrador está separado del público? | **Sí** | `admin_profiles` con FK a `auth.users`; predicados `is_admin()` / `is_developer()` en RLS; `requireAdmin()` en las 18 rutas `/api/admin/*` |
| 13 | ¿Las claves sensibles están expuestas? | **No en el repositorio** | `.env`, `.env*.local`, `.env.remote` en `.gitignore`. Los únicos archivos versionados son `.env.example` y `.env.remote.example`, ambos con marcadores. `SUPABASE_SERVICE_ROLE_KEY` nunca lleva prefijo `NEXT_PUBLIC_` |
| 14 | ¿Las operaciones administrativas se ejecutan desde el servidor? | **Sí** | Todo módulo sensible abre con `import "server-only"`. Verificación automatizada: ninguna ruta bajo `src/app/api/admin/` carece de guarda. `createSupabaseServiceClient()` está definido pero **sin una sola invocación** en `src/` |
| 15 | ¿Existe auditoría? | **No, salvo tres excepciones** | No hay tabla de auditoría ni bitácora. Solo tres columnas de autoría en toda la base: `orders.created_by`, `import_batches.created_by`, `pdf_exports.generated_by` |
| 16 | ¿Se pueden identificar cambios por usuario? | **Parcial** | Se identifica quién creó un pedido, un lote de importación o un PDF. **No** se identifica quién modificó un producto, un precio o una disponibilidad |
| 17 | ¿La autenticación soporta propietaria y vendedoras? | **No** | `app_role` tiene exactamente dos valores: `admin` (`0001`) y `developer` (`0016`). No existe rol de vendedora ni separación de permisos por persona |

### Mantenibilidad

| # | Pregunta | Respuesta | Evidencia |
|---:|---|---|---|
| 18 | ¿Las reglas comerciales están concentradas o duplicadas? | **Concentradas** | Precio, mayorista y disponibilidad se resuelven en `evaluate_cart_v2` y se invocan desde carrito, WhatsApp y pedidos. El mensaje de WhatsApp se genera en un único módulo (`lib/catalog/whatsapp.ts`) |
| 19 | ¿Los precios están codificados en el frontend? | **No** | El navegador solo formatea (`formatSoles`, `lib/public/catalog.ts:97`). Todo importe proviene de `variant_prices` vía contrato, y se revalida en servidor antes de cualquier acción |
| 20 | ¿Existen servicios o repositorios reutilizables? | **Sí** | `lib/catalog/contracts.ts` como frontera explícita entre modelo crudo y aplicación; servicios en `lib/admin/*` y `lib/catalog/*` |
| 21 | ¿Las migraciones permiten recrear la base localmente? | **Sí por diseño; no verificado** | `npm run db:reset:local` reconstruye de `0001` a `0022` más seeds. **No pudo ejecutarse** en esta auditoría (§4) |
| 22 | ¿El proyecto puede ejecutarse desde cero siguiendo el README? | **No en esta máquina** | `npx supabase start` falla: Windows tiene reservados los puertos 54234–54333, que incluyen 54320, 54321 y 54322. Verificado con `netsh` y con una prueba de bind. El README no contempla el caso |
| 23 | ¿Existen pruebas de carrito, productos y autenticación? | **Sí, de integración; ninguna unitaria** | `test:contracts` (carrito, mayorista, consulta), `test:admin-flow` (login real → producto → pedido → PDF), `test:db` (32 aserciones pgTAP). No hay Vitest/Jest: **ninguna prueba corre sin Docker** |
| 24 | ¿La aplicación tiene estructura modular? | **Sí** | Separación clara `app/` · `components/` · `lib/{catalog,admin,auth,supabase,env,api}`. `typecheck` y `lint` pasan limpios |

### Rendimiento

| # | Pregunta | Respuesta | Evidencia |
|---:|---|---|---|
| 25 | ¿La página carga todas las variantes e imágenes innecesariamente? | **No** | `catalog_list_v2` devuelve solo datos de tarjeta; galerías, relaciones, historial y atributos no solicitados quedan fuera. El detalle se difiere a `catalog_product_detail_v2` |
| 26 | ¿Las imágenes están optimizadas? | **No las del catálogo** | `next/image` se usa en 4 puntos, todos de marca (logo, shell, login). Las imágenes de producto usan `<img>` crudo en `HomeView`, `ProductView`, `SelectionView` y `ProductListView`: sin `srcset`, sin `lazy`, sin conversión a WebP/AVIF |
| 27 | ¿Las búsquedas se realizan en el servidor? | **Sí** | `products.search_document` es una columna `tsvector` generada con índice GIN, más índice trigram sobre `name`. El filtro viaja como parámetro a la función SQL |
| 28 | ¿Hay paginación? | **Sí, en base de datos** | `catalog_list_v2` aplica `offset/limit`, acota `page_size` a 100 y devuelve `totalItems` y `totalPages` (`0006:22,244-245,291-292`) |
| 29 | ¿Existen consultas repetidas? | **No detectadas** | El PDF carga productos, variantes, precios y medios en consultas agrupadas por `in (…)`, no una por producto (`api/admin/pdf/generate/route.ts:54`) |
| 30 | ¿Puede manejar 1.500 registros y su crecimiento? | **Sí según medición previa; no reverificado** | `docs/CATALOG_V2_IMPLEMENTATION.md` §13 registra 1.505 productos, 16 páginas y 867 ms en la última página. Esta auditoría **no pudo reproducir** la medición (§4) |

**Marcador global:** 21 respuestas favorables · 6 parciales · 3 desfavorables (9, 15, 17) · 2 no verificadas empíricamente (21, 30).

---

## 3. Prueba de extensión obligatoria (0.3)

### 3.1 Estado de ejecución

La prueba exige cargar diez muestras en el entorno local. **No pudo ejecutarse contra la base de datos** por el bloqueo de puertos descrito en §4. Lo que sigue es el **análisis estructural** de cada muestra contra el modelo versionado: qué existe, qué falta y de qué naturaleza es lo que falta. Es evidencia suficiente para la decisión, pero **no sustituye la ejecución**, que queda como condición de cierre del Bloque 0.

### 3.2 Resultado por muestra

| # | Muestra exigida | ¿Soportada hoy? | Qué haría falta | Naturaleza del cambio |
|---:|---|---|---|---|
| 1 | Esmalte con varios tonos | **Sí** | Nada. Plantilla `ESMALTE_TONOS` + `color_shades` | — |
| 2 | Pestaña con curvas, grosores y longitudes | **Sí** | Nada. Plantilla `EXTENSIONES_PRO` con ejes de variante | — |
| 3 | Pegamento con tiempo de secado y retención | **Sí** | Nada. Plantilla `ADHESIVO_PRO` | — |
| 4 | Polygel con Slip Solution relacionado | **Parcial** | Plantilla nueva + atributos. La relación ya existe (`product_relations`, tipo `recommended_with`) | **Datos** (`INSERT`) + 1 línea de UI |
| 5 | Lámpara con potencia | **Sí** | Nada. Plantilla `LAMPARA` | — |
| 6 | Drill con RPM | **Sí** | Nada. Plantilla `TORNO_ELECTRICO` | — |
| 7 | Cera con aroma y peso | **No** | Plantilla nueva + atributos `aroma` (`single_option`) y `peso` (`measurement`), ambos tipos ya existentes | **Datos** + 1 línea de UI |
| 8 | Rubro de maquillaje | **No** | Categoría + plantilla + atributos nuevos | **Datos** + 1 línea de UI |
| 9 | Producto con dos proveedores | **No** | `suppliers`, `supplier_contacts`, `product_suppliers`, costos y escalas | **Esquema nuevo — 0 tablas existen** |
| 10 | Producto sin variantes visibles | **Sí** | Nada. `create_product_with_default_variant` siempre crea una variante predeterminada | — |

**6 de 10 funcionan sin tocar nada. 3 requieren únicamente datos. 1 requiere un dominio completo que no existe.**

### 3.3 Lectura del criterio del plan

> *"Si para lograrlo se necesitan columnas nuevas o condiciones especiales para cada familia, el modelo actual no es reutilizable como modelo definitivo."*

Aplicado literalmente:

- **Cera, maquillaje y polygel no necesitan columnas nuevas.** Una familia se declara con `INSERT` en `attribute_templates`, `attribute_definitions`, `attribute_options` y `template_attributes`. Los diez tipos de dato disponibles (`measurement`, `single_option`, `decimal`, `json`, …) cubren aroma, peso, viscosidad, tono o acabado sin `ALTER TABLE`. **El modelo de catálogo supera el criterio.**
- **Sí existe una "condición especial por familia", pero en la interfaz, no en el modelo:** el arreglo `PRODUCT_TYPES` de `CatalogV2ProductForm.tsx:38-47` enumera las ocho familias a mano. Añadir cera exige editar código. Es un defecto acotado a una pantalla, resoluble leyendo las plantillas desde la base.
- **Proveedores es un vacío estructural, no un defecto del modelo de catálogo.** El plan lo ubica en el Bloque 1, no en el Bloque 0. Que no exista era lo esperado.

---

## 4. Limitación de esta auditoría

`npx supabase start` falla en esta máquina:

```
failed to start docker container "supabase_db_e-commerce-catalog":
ports are not available: exposing port TCP 0.0.0.0:54322 -> 127.0.0.1:0:
listen tcp 0.0.0.0:54322: bind: An attempt was made to access a socket
in a way forbidden by its access permissions.
```

Causa verificada: Windows mantiene reservado el rango **54234–54333** (`netsh int ipv4 show excludedportrange protocol=tcp`), que contiene los tres puertos que Supabase necesita —54320 (shadow), 54321 (API) y 54322 (base)—. Una prueba de bind directa confirma que los tres están bloqueados. No es un defecto del proyecto: es una reserva dinámica de Hyper-V/WSL en el host.

Quedan **sin verificar empíricamente**: la reconstrucción `db reset` (P21), la medición de 1.500 registros (P30) y la ejecución de la prueba de extensión (§3).

Cómo desbloquearlo, en orden de preferencia:

1. Liberar el rango reservado, en una consola **como administrador**:
   ```
   net stop winnat
   net start winnat
   ```
   Deja el proyecto intacto. Es la vía recomendada.
2. Reasignar los puertos locales en `supabase/config.toml` a la banda libre 54740–56131. Obliga a tocar además `.env.local`, `.env.supabase.local` y la guarda `url.port === "54321"` de `scripts/lib/supabase-script-env.mjs`, que es un control de seguridad. **No recomendado.**

---

## 5. Tabla de decisión (0.5)

| Área | Reutilizable | Requiere corrección | Debe reemplazarse | Evidencia |
|---|:---:|:---:|:---:|---|
| Autenticación | ✔ | ✔ | | Supabase Auth + `admin_profiles` + RLS son correctos. Falta el rol de vendedora: `app_role` solo tiene `admin` y `developer` |
| Catálogo | ✔ | | | Producto/variante separados, categorías jerárquicas, atributos tipados, contratos SQL, paginación en base |
| Variantes | ✔ | | | `product_variants` es la unidad vendible; variante predeterminada garantizada por índice parcial y trigger |
| Carrito | ✔ | ✔ | | Apunta a variantes y revalida en servidor. Falta persistencia y origen de captación (canal, campaña, vendedora) que exige el Bloque 3 |
| Imágenes | ✔ | ✔ | | `media_assets` + `product_media` con propietario producto XOR variante. Las imágenes de producto se sirven con `<img>` crudo, sin optimización |
| Administración | ✔ | ✔ | | Alta guiada por familia, 18 endpoints con guarda. `PRODUCT_TYPES` hardcodea las 8 familias; `ProductForm`/`ProductListView` siguen en V1 |
| Base de datos | ✔ | ✔ | | 32 tablas, RLS 100 %, 60 triggers, 51 índices. Columnas V1 vivas y doble escritura; faltan proveedores, sedes y auditoría |
| Despliegue | | ✔ | | Vercel + Supabase operativos, pero sin configuración versionada, sin entorno de prueba, sin procedimiento de reversión ni respaldos documentados |
| Seguridad | ✔ | ✔ | | RLS completa, secretos fuera de Git, `service_role` sin uso en `src/`. No hay auditoría transversal de cambios |
| Pruebas | ✔ | ✔ | | 32 aserciones pgTAP + 24 scripts de integración. Ninguna prueba ejecutable sin Docker; cero pruebas unitarias |
| **Proveedores** | | | ✔ | **No existe.** Cero tablas |
| **Operación comercial** (ventas, pagos, compras, gastos, reservas, devoluciones, inventario) | | | ✔ | **No existe.** `orders` es un pedido administrativo sin pagos |
| **Canales y omnicanalidad** | | | ✔ | **No existe.** Cero tablas de canal, conversación o atribución |
| **Sedes / `branch_id`** | | | ✔ | **No existe** en ninguna tabla |

---

## 6. Recomendación

```text
REUTILIZAR PARCIALMENTE
```

Ninguna de las condiciones del **Resultado C** se cumple: hay migraciones reproducibles, RLS al 100 %, código modular, sin secretos comprometidos, sin datos en archivos y con un carrito que ya apunta a variantes. Reconstruir destruiría 6.874 líneas de SQL con integridad probada y un modelo de catálogo que ya resuelve el problema difícil.

Tampoco es un **Resultado A** puro: faltan cuatro dominios completos —proveedores, operación comercial, canales y sedes— y la organización (roles, auditoría, `branch_id`) no está modelada.

Es exactamente el **Resultado B**, con un matiz favorable respecto de lo que anticipaba el plan: la parte que el plan daba por reemplazable —*"el modelo de productos, las consultas de catálogo, el carrito"*— **ya fue reemplazada** en el trabajo sin commitear. Lo que queda por construir no es corregir el catálogo, sino levantar los dominios que nunca existieron.

El fundamento detallado y el plan de ejecución están en `docs/decision-reutilizacion-v2.md`.

---

## 7. Condiciones para cerrar el Bloque 0

1. **Respaldar en Git las 115 rutas sin commitear.** Bloqueante y urgente.
2. Desbloquear los puertos y ejecutar realmente: `db:reset:local`, `test:db`, `test:contracts`, `test:admin-flow`, `test:scale`.
3. Ejecutar la prueba de extensión (§3) con las diez muestras, creando cera, maquillaje y polygel **solo con datos**, para confirmar empíricamente que no hace falta `ALTER TABLE`.
4. Documentar el estado real de la infraestructura remota: proyecto de Vercel, proyecto de Supabase, dominios, respaldos y procedimiento de reversión.
5. Aprobar la recomendación y abrir `feature/bellaroshe-platform-v2`.
