# Bellaroshé · Plataforma comercial

Plataforma de catálogo y operación comercial para Bellaroshé, construida con Next.js 15, TypeScript y Supabase (PostgreSQL, Auth y Storage). Incluye catálogo por variantes, importación y reconciliación, inventario, ventas, compras, caja, omnicanalidad, analítica y asistencia supervisada.

La documentación vigente comienza en [docs/README.md](docs/README.md). No uses planes o auditorías antiguas como fuente de verdad.

## Inicio local

```bash
npm install
npx supabase start
npm run db:reset:local
npm run seed:demo-operation
npm run dev
```

El stack local usa `http://127.0.0.1:55321` y la banda `55320–55329`. La aplicación lee `.env.local`; los scripts administrativos leen `.env.supabase.local`. Ambos deben apuntar a loopback.

Para revisar el prototipo como usuaria sin compilación al primer clic:

```bash
npm run prototype
# http://127.0.0.1:3005
```

## Usuarios demo

| Rol | Usuario | Contraseña |
| --- | --- | --- |
| Developer | `bulk-dev@local.invalid` | `Bulk-Dev-2026!` |
| Propietaria | `demo-admin@local.invalid` | `Demo-Admin-2026!` |
| Vendedora | `demo-seller@local.invalid` | `Demo-Seller-2026!` |

Son cuentas `.invalid` exclusivamente locales. El rol developer es el único que ve Importaciones.

## Superficies principales

El panel agrupa sus pantallas en ocho dominios, que son los que dibuja el panel
lateral. La lista viva está en [`src/lib/admin/navigation.ts`](src/lib/admin/navigation.ts).

- Público: `/`, `/producto/:slug`, `/seleccion`.
- Ventas: `/admin/ventas`, `/admin/caja`.
- Inventario: `/admin/inventario`, `/admin/reposicion`.
- Clientes: `/admin/conversaciones`, `/admin/carritos`.
- Catálogo: `/admin/productos`, `/admin/catalogo/revisar`, `/admin/pdf`.
- Compras: `/admin/compras`, `/admin/gastos`.
- Marketing: `/admin/atribucion`, `/admin/campanas`, `/admin/canales`.
- Analítica: `/admin/analitica`. Asistente: `/admin/asistente`.

Dos rutas antiguas siguen respondiendo pero no son pantalla: `/admin/estructura`
redirige al alta de productos y `/admin/importaciones` redirige a Revisar. No
aparecen en la navegación y está pendiente decidir si desaparecen.

Las rutas exactas pueden evolucionar; RLS y los contratos de servidor determinan el acceso real.

## Verificación

```bash
npm run typecheck
npm run lint
npm run test:db
npm run audit:security
```

El gate de reconstrucción completo es `npm run gate:rebuild`. Los gates de búsqueda, enriquecimiento, venta, navegación y despliegue están descritos en [docs/operacion.md](docs/operacion.md) y [docs/calidad-y-riesgos.md](docs/calidad-y-riesgos.md).

## Reglas duras

- PostgreSQL es la fuente de verdad para reglas críticas.
- Producto y variante son identidades distintas.
- Evidencia externa no equivale a dato aprobado ni a imagen publicable.
- Stock, precio, compatibilidad y documentos fiscales nunca se inventan.
- Los scripts bloquean remoto por defecto.
- Producción no se toca antes de staging, backup restaurado y autorización expresa.

## Documentos clave

- [Arquitectura](docs/arquitectura.md)
- [Catálogo](docs/catalogo.md)
- [Importación](docs/importacion-catalogo.md)
- [Operación](docs/operacion.md)
- [Frontend](docs/frontend.md)
- [Calidad y riesgos](docs/calidad-y-riesgos.md)
- [Plan vivo del MCP](docs/plan-vivo-mcp-inteligencia-catalogo.md)
