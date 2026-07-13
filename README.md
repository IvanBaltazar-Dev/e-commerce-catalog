# Catalogo Bellaroshe MVP

Catalogo Bellaroshe con Next.js App Router, TypeScript, Supabase
PostgreSQL/Auth/Storage, RLS, Zod, route handlers y server actions.

Incluye el **panel de administracion** implementado desde el diseno
`Bellaroshé Admin.dc.html` (proyecto Claude Design «Bellaroshé»). El catalogo
publico pertenece a otro archivo de diseno y aun no esta implementado; `/`
muestra una portada minima con enlace al panel. El plan de implementacion del
panel esta en `PLAN.md`.

## Stack

- Next.js App Router + TypeScript (frontend admin + API).
- Supabase PostgreSQL con SQL migrations.
- Supabase Auth con `@supabase/ssr` (login del panel con email/contrasena).
- Supabase Storage para imagenes y PDFs (subidas con URLs firmadas).
- RLS para lectura publica del catalogo y operaciones admin autenticadas.
- Zod para entradas y variables de entorno.
- Vercel Functions con runtime Node.js en route handlers.
- PDFKit para generar el PDF administrativo desde los datos del catalogo.

## Panel de administracion

Rutas del panel (requieren usuario en `admin_profiles`):

- `/admin/login` — inicio de sesion.
- `/admin/productos` — lista con busqueda, filtros por marca/estado y
  publicar/ocultar directo.
- `/admin/productos/nuevo` y `/admin/productos/:id` — crear/editar producto:
  datos, tipo de esmalte, lampara (`No`/`Sí`/`UV/LED`), disponibilidad, precios
  unidad/mayor/minimo, descripcion, 4 imagenes (01 principal, 02 detalle,
  03 tonos/carta, 04 set) y toggles de carta de colores y publicacion.
- `/admin/pdf` — estado del catalogo PDF (Actualizado/Desactualizado/Generando/
  No generado/Error), generar, vista previa y descargar.

Notas:

- La marca (texto libre) y el tipo de esmalte hacen *find-or-create* sobre
  `brands`/`categories`.
- `public/logo.svg` es un logo provisional generado a partir de la identidad
  del diseno; reemplazalo por el arte final cuando lo tengas (se usa en login,
  topbar y portada).

## Configuracion

1. Instalar dependencias:

```bash
npm install
```

2. Crear `.env` desde `.env.example`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SITE_URL=http://localhost:3000
CATALOG_DEFAULT_WHATSAPP=+51963463550
```

`SUPABASE_SERVICE_ROLE_KEY` es solo servidor. No debe tener prefijo
`NEXT_PUBLIC_` ni importarse en codigo cliente.

3. Aplicar migraciones y seed con Supabase CLI:

```bash
supabase db push
supabase db seed
```

En local tambien se puede usar:

```bash
supabase db reset
```

## Primer administrador

Crear el usuario en Supabase Auth y luego registrar su UUID en `admin_profiles`
desde SQL editor o una conexion con service role:

```sql
insert into public.admin_profiles (id, role, full_name)
values ('AUTH_USER_UUID_HERE', 'admin', 'Admin Bellaroshe')
on conflict (id) do update set role = 'admin';
```

Las operaciones admin usan la sesion autenticada del usuario y politicas RLS.

## Endpoints publicos

- `GET /api/health`
- `GET /api/catalog?brand=masglo&category=esmaltes-en-gel&q=gel`
- `GET /api/catalog/:slug`
- `GET /api/catalog/taxonomy`
- `POST /api/catalog/whatsapp`

Ejemplo WhatsApp:

```json
{
  "type": "selection",
  "items": [
    {
      "productId": "PRODUCT_UUID",
      "quantity": 3,
      "toneMode": "specific_codes",
      "toneCodes": ["042", "061", "085"]
    }
  ],
  "deliveryMethod": "shipping"
}
```

## Endpoints admin

Requieren sesion Supabase Auth con perfil `admin_profiles.role = 'admin'`.

- `GET /api/admin/products`
- `POST /api/admin/products`
- `GET /api/admin/products/:id`
- `PATCH /api/admin/products/:id`
- `DELETE /api/admin/products/:id` oculta el producto.
- `GET|POST /api/admin/brands`
- `PATCH|DELETE /api/admin/brands/:id`
- `GET|POST /api/admin/categories`
- `PATCH|DELETE /api/admin/categories/:id`
- `POST /api/admin/assets/upload-url`
- `GET|PATCH /api/admin/settings/contact`
- `GET /api/admin/pdf`
- `POST /api/admin/pdf/generate`
- `GET /api/admin/pdf/:id/download`

## Storage

La migracion crea dos buckets:

- `catalog-assets`: publico para lectura de imagenes del catalogo; escritura solo admin.
- `catalog-pdfs`: privado; lectura/escritura solo admin mediante URLs firmadas.

## Datos del MVP

El modelo evita una tabla individual de tonos para el MVP. Cada producto guarda
si tiene carta de colores o si debe consultar tonos con asesor. La seleccion
temporal del cliente queda para el navegador; el backend genera el mensaje de
WhatsApp validando productos y cantidades.

La migracion `0002_product_lamp_type.sql` agrega `products.lamp_type`
(`No`/`Sí`/`UV/LED`) para conservar la opcion exacta del panel; `requires_lamp`
se mantiene derivado para compatibilidad.

## Verificacion

Comandos esperados:

```bash
npm run typecheck
npm run lint
npm run build
```

Serena fue activado sobre este proyecto nuevo. Para validar memorias de Serena:

```bash
serena memories check
```
