# Bellaroshé · Plataforma comercial

Plataforma de operación comercial para Importaciones Bellaroshé (belleza y uñas, Lima), construida sobre **Next.js 15 + Supabase (PostgreSQL/Auth/Storage) con RLS y TypeScript**. No es un catálogo con pedidos añadidos: es la operación completa del negocio.

- **Catálogo V2** — productos heterogéneos con alta guiada por familia comercial, variantes, tonos y precios mayorista/minorista resueltos en PostgreSQL (Bloque 1).
- **Operación comercial** — inventario con kardex y costo promedio, ventas, reservas con adelanto, compras y recepciones, devoluciones, anulaciones, gastos y caja, todo conciliado de extremo a extremo (Bloque 2).
- **Omnicanalidad** — canales (WhatsApp/Instagram/Facebook/TikTok), conversaciones, carrito público persistente y recuperable entre dispositivos, atribución first/last-touch y asignación de vendedora (Bloque 3).
- **Inteligencia comercial e IA** — tablero con indicadores y rankings, y un asistente (dictado, foto por etapas, asesor de catálogo, tendencias) que **propone** y siempre deja la venta y la publicación en manos de una persona; degrada con honestidad sin credencial de IA (Bloque 4).

**El runbook operativo es [docs/operacion.md](docs/operacion.md)** (instalación, backup, migraciones, despliegue, rollback, troubleshooting); el despliegue remoto, [docs/staging-produccion.md](docs/staging-produccion.md). La fuente técnica del catálogo es [docs/CATALOG_V2_IMPLEMENTATION.md](docs/CATALOG_V2_IMPLEMENTATION.md); el registro de cada bloque, `docs/bloque-N-ejecucion.md`.

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

### Probar el avance (login demo)

`npm run seed:demo-operation` siembra la operación de ejemplo y crea —imprimiéndolas al terminar— dos cuentas listas para entrar en `/admin/login`:

| Rol | Correo | Contraseña |
|---|---|---|
| Propietaria (admin) | `demo-admin@local.invalid` | `Demo-Admin-2026!` |
| Vendedora (seller) | `demo-seller@local.invalid` | `Demo-Seller-2026!` |

El catálogo público y el carrito (`/`, `/producto/:slug`, `/seleccion`) no requieren login. Son cuentas de dominio `.invalid`, exclusivas del stack local: **nunca** se siembran en staging ni en producción.

## Rutas principales

**Público**

- `/` — catálogo paginado y filtrado en PostgreSQL.
- `/producto/:slug` — detalle y selección de variante.
- `/seleccion` — carrito persistente; `/seleccion/:token` recupera la selección entre dispositivos.

**Panel** (roles admin/developer/seller según la RLS)

- `/admin/ventas` — venta, cobro, caja y reservas.
- `/admin/conversaciones` — bandeja omnicanal en tres columnas.
- `/admin/asistente` — dictado, foto por etapas y asesor (propone; la persona confirma).
- `/admin/inventario` · `/admin/compras` · `/admin/gastos` — operación diaria.
- `/admin/analitica` — tablero comercial con presets e indicadores.
- `/admin/carritos` · `/admin/atribucion` — carritos persistentes y marketing (campañas, canales, tendencias).
- `/admin/productos` · `/admin/productos/nuevo` · `/admin/productos/:id` — catálogo V2.
- `/admin/pdf` — exportación PDF del catálogo.

## Organización y roles

La plataforma modela empresa, sedes y personal desde la primera migración del Bloque 1. Toda operación guarda su `branch_id`. Los roles son `admin` (propietaria), `developer` (perfil técnico) y `seller` (vendedora); la RLS acota qué ve y qué puede hacer cada uno, y todo cambio sobre catálogo, ventas, dinero e inventario queda en libros de solo adición. Detalle en [docs/vertical-1-organizacion.md](docs/vertical-1-organizacion.md).

Para entrar al panel hace falta un usuario de Supabase Auth. Créalo en Studio (`http://127.0.0.1:55323` → Authentication → Users, con *Auto Confirm*) y después:

```bash
node scripts/grant-admin.mjs tu-correo@dominio.pe admin --env .env.supabase.local
```

## Verificación

El gate del repositorio reconstruye y prueba todo desde una base vacía:

```bash
npm run gate:rebuild
```

Corre, en orden: base vacía → migraciones 0001–0046 → seeds → pgTAP (20 suites, 505 aserciones) → integrales B1–B4 → concurrencias → typecheck → lint → build, con evidencia en `test-results/`. Suites individuales: `test:db`, `test:block2`/`3`/`4`, `test:*-concurrency`, `test:ai-matching`.

Estabilización y despliegue (Bloque 5), parametrizados por entorno:

```bash
npm run audit:security     # RLS/ACL/DEFINER/bundle contra security/baseline.json
npm run perf:volume        # rendimiento con ~1,500 SKUs, 12 superficies
npm run backup:verify      # pg_dump + restauración REAL verificada
npm run rollback:drill     # los cinco casos A–E
npm run test:responsive    # escritorio + móvil sobre superficies reales
```

Todos los comandos de base de datos se ejecutan contra Supabase local. **Producción no se toca** hasta superar los gates de staging descritos en [docs/staging-produccion.md](docs/staging-produccion.md).
