# Roles y accesos del panel — entorno local

Tres roles reales (`admin_profiles.role`), tres usuarios locales listos. Las
credenciales son SOLO locales (dominio `.invalid`, no existen fuera de tu
máquina; ver `README` § login demo).

| Rol | Usuario local | Contraseña | Para qué sirve |
|-----|---------------|------------|----------------|
| **developer** | `bulk-dev@local.invalid` | `Bulk-Dev-2026!` | TODO el panel **+ Importaciones** (carga masiva, revisión de excepciones, conciliar imágenes). Es el rol técnico: úsalo tú para operar el importador y auditar el catálogo. |
| **admin** | `demo-admin@local.invalid` | `Demo-Admin-2026!` | El panel de la dueña: Inicio, Productos, PDF, Ventas, Caja, Inventario, Reposición, Compras, Gastos, Clientes, Marketing, Analítica. **No ve Importaciones** (herramienta técnica, gate deliberado de la migración 0017). |
| **seller** | `demo-seller@local.invalid` | `Demo-Seller-2026!` | Solo operación de venta: Nueva venta, Caja, Existencias, Conversaciones. |

## Por qué «no existía» Importaciones

`/admin/importaciones` exige **rol developer** y el flag
`ENABLE_CATALOG_IMPORTS=true` (ya activo en `.env.local`). Entraste como
`demo-admin` → la entrada ni se muestra en la barra. Con `bulk-dev` la ves en
**Catálogo → Importaciones**.

## Qué muestra cada superficie de catálogo (y por qué)

- **/admin/productos** — el catálogo completo (1,056 productos, borradores
  incluidos), paginado desde el servidor con búsqueda, filtro por marca y
  estado editorial (Publicados / Borradores / Ocultos). El conteo del
  encabezado es el total real.
- **/admin/inventario (Existencias)** — SOLO variantes con registro de stock.
  Hoy: 3 (las del seed demo de operación). El catálogo importado **no tiene
  stock y no se inventa** (regla de certificación: catálogo ≠ inventario).
  Las existencias reales aparecerán cuando se registren compras/conteos.
  Cómo listar «catálogo sin registro» es decisión de diseño de la Fase 4
  (Inventario definitivo).
- **/admin/importaciones** — lotes, filas, issues y decisiones navegables
  hasta la fila del Excel; «Conciliar imágenes» para el ZIP de medios.
- **Catálogo público (/)** — solo productos **publicados** (hoy: Esmalte
  MASGLO con 164 tonos, Esmalte ADMISS, y 5 demo antiguos). Publicar exige
  atributos obligatorios completos: es el trabajo de enriquecimiento de las
  siguientes fases, producto por familia.
