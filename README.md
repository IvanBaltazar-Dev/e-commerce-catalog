# Bellaroshe · Registro de productos y catálogo

Prototipo funcional de baja fidelidad para registrar productos heterogéneos en el catálogo Bellaroshe V2, con Next.js, Supabase PostgreSQL/Auth/Storage, RLS y TypeScript. El alta guía por familia comercial y resuelve internamente la categoría, la plantilla y los campos aplicables. El módulo de pedidos se conserva como una función adicional ya implementada.

La fuente técnica de verdad es [docs/CATALOG_V2_IMPLEMENTATION.md](docs/CATALOG_V2_IMPLEMENTATION.md).

## Ejecución local segura

La aplicación usa `.env.local` y los scripts administrativos usan `.env.supabase.local`. Ambos archivos deben apuntar únicamente a:

```text
http://127.0.0.1:54321
http://localhost:54321
```

Los scripts bloquean remoto por defecto. No copies secretos reales a archivos versionados.

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
