# Bellaroshe · Registro de productos y catálogo

Prototipo funcional de baja fidelidad para registrar productos heterogéneos en el catálogo Bellaroshe V2, con Next.js, Supabase PostgreSQL/Auth/Storage, RLS y TypeScript. El alta guía por familia comercial y resuelve internamente la categoría, la plantilla y los campos aplicables. El módulo de pedidos se conserva como una función adicional ya implementada.

La fuente técnica de verdad es [docs/CATALOG_V2_IMPLEMENTATION.md](docs/CATALOG_V2_IMPLEMENTATION.md).

## Ejecución local segura

La aplicación usa `.env.local` y los scripts administrativos usan `.env.supabase.local`. Ambos archivos deben apuntar únicamente a un host loopback:

```text
http://127.0.0.1:55321
http://localhost:55321
```

El stack local usa la banda `55320-55329` (`supabase/config.toml`) en lugar de los puertos por defecto de Supabase: Windows reserva el rango TCP `54234-54333`, que contenía `54320`, `54321` y `54322`. Detalle en [docs/riesgos-v2.md](docs/riesgos-v2.md) (R-01).

Los scripts bloquean remoto por defecto: aceptan únicamente `127.0.0.1` o `localhost` sobre HTTP y sin `SUPABASE_PROJECT_REF`. Cualquier otro destino exige `--allow-remote` y `--confirm-project=<PROJECT_REF>`. No copies secretos reales a archivos versionados.

```bash
npm install
npx supabase start
npm run db:reset:local
npm run dev
```

## Rutas principales

- `/` — catálogo público paginado y filtrado en PostgreSQL.
- `/producto/:slug` — detalle y selección de variante.
- `/seleccion` — carrito compacto por `variantId + purchaseMode`.
- `/admin/pedidos` — registro rápido e historial reciente de pedidos.
- `/admin/productos` — listado administrativo.
- `/admin/productos/nuevo` — alta guiada por tipo, con buscadores contextuales de marca/línea y biblioteca de tonos por familia cromática.
- `/admin/productos/:id` — edición/duplicación V2.
- `/admin/estructura` — compatibilidad; redirige al alta guiada de productos.
- `/admin/pdf` — exportación PDF V2.

## Organización y roles

La plataforma modela empresa, sedes y personal desde la primera migración del Bloque 1. Toda operación guarda su `branch_id`; `orders` es el primer caso. Los roles disponibles son `admin` (propietaria), `developer` (perfil técnico) y `seller` (vendedora), y todo cambio sobre catálogo, pedidos y organización queda en una bitácora de solo adición. Detalle en [docs/vertical-1-organizacion.md](docs/vertical-1-organizacion.md).

Para entrar al panel hace falta un usuario de Supabase Auth. Créalo en Studio (`http://127.0.0.1:55323` → Authentication → Users, con *Auto Confirm*) y después:

```bash
node scripts/grant-admin.mjs tu-correo@dominio.pe admin --env .env.supabase.local
```

## Verificación

```bash
npm run typecheck
npm run test:product-registration
npm run lint
npm run build
npm run test:db
npm run test:contracts
npm run test:backfill
```

Todos los comandos de base de datos se ejecutan contra Supabase local. No se debe desplegar ni aplicar migraciones en producción sin la validación formal definida en la documentación.
