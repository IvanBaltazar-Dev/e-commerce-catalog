# Bloque 5 — Registro de ejecución

**Rama:** `feature/bellaroshe-platform-v2` · **Fecha:** 2026-08-07
**Objetivo del bloque:** demostrar que Bellaroshé puede instalarse desde cero, desplegarse sin intervención manual peligrosa, recuperarse ante un fallo y operar con datos reales sin romper los Bloques 1–4. Alcance funcional **congelado** en `cabc6a7`: en el Bloque 5 no se añaden módulos, solo se corrigen defectos que los gates encuentran.

Este documento es la evidencia de cierre. El runbook operativo vive en [operacion.md](operacion.md) y [staging-produccion.md](staging-produccion.md); el backlog de mejoras no bloqueantes en [backlog-b5.md](backlog-b5.md).

---

## Lo que los gates encontraron (y se corrigió)

El Bloque 5 no fue «poner sellos verdes»: cada gate destapó deuda real.

### 1. El ACL por defecto abierto a `anon` (migración 0045)

`audit:security` —auditoría estructural nueva, repetible en cualquier entorno— destapó que el `alter default privileges` de 0002 había concedido a `anon` **SELECT sobre 75 tablas** (caja, costos, kardex, mensajes, IA) y EXECUTE sobre cientos de funciones vía el rol `PUBLIC`. La RLS ya dejaba todo en cero filas, pero la doctrina del repositorio exige la **doble puerta**: política Y privilegio.

**0045** cierra los defaults para todo grantor, recorta `anon` a exactamente las relaciones con política pública (derivado de `pg_policy`, no de opinión) más los 10 contratos y 4 helpers del catálogo, y trae un **auto-humo dentro de la propia migración**: ejecuta el catálogo y el carrito *como* `anon` y aborta si un cierre futuro rompe la superficie pública. 15 aserciones pgTAP lo fijan; la línea base queda versionada en `security/baseline.json` y el diff es el control.

### 2. `catalog_list_v2` no escalaba (migración 0046) — el hallazgo del gate de rendimiento

`perf:volume` sembró ~1,500 SKUs y midió con cronómetro. El catálogo público **agotaba el statement_timeout** (respondía 400 a los 3 s). El `EXPLAIN (ANALYZE, BUFFERS)` —la única base admitida para tocar la base— reveló DOS causas, ninguna intuida:

| | Antes | Después de 0046 |
|---|---|---|
| Como `postgres` (sin RLS) | 906 ms · 68 849 buffers | 297 ms |
| Como `anon` (RLS activa) | **25 675 ms · 503 333 buffers** | **~47 ms** |

- **Materializaba la tarjeta completa** (imagen, precios, disponibilidad por variante, variante destacada) para los 1,500 productos filtrados y solo *después* cortaba 24. 0046 pagina sobre las claves baratas ANTES de construir las tarjetas: el trabajo caro cae de 1,500 a 24.
- **Era `stable` (INVOKER)**: cada acceso interno re-evaluaba la RLS — medio millón de comprobaciones. 0046 lo lleva a **SECURITY DEFINER** con su propio filtro `publicado + activo` como revalidación, que reproduce letra por letra la política `is_public_catalog_product` (se añadió el guard de categoría activa para que la equivalencia sea exacta). No expone ni un producto más; deja de comprobar lo mismo 500,000 veces. `catalog_product_detail_v2` recibe el mismo tratamiento.

Resultado medido bajo volumen: catálogo **284 ms**, búsqueda 191 ms, tablero 90 días 402 ms — las 12 superficies dentro de umbral. Ningún índice añadido: el EXPLAIN señaló volumen de trabajo, no un scan sin índice.

### 3. Estado local accidental

- **R-12**: el `.env` de la raíz con el `service_role` remoto quedó en cuarentena fuera del repo (rotación manual pendiente en el dashboard).
- Rutas de Edge hardcodeadas en 6 guiones → `scripts/lib/resolve-browser.mjs` (env → puppeteer → sistema).
- Guiones de volumen no re-entrantes: cada corrida cazó una conformidad de esquema (enums sin cast, triggers diferidos que exigen orden, la constraint de saliente-con-remitente) — todas documentadas en el propio guion.

---

## Gates y su evidencia

### BASE VIRGEN — `gate:rebuild`, ×2 consecutivas

Reconstrucción total desde base vacía, **dos veces seguidas** para cazar lo no re-entrante:

```
✓ 0001–0046 + seed base     ✓ integrales B1 · B2 · B3 · B4
✓ seeds mínimos             ✓ concurrencias (inventario · ventas · omnicanal)
✓ pgTAP (20 suites, 505)    ✓ typecheck · lint · production build
```

Evidencia por paso en `test-results/gate-rebuild-1.md` y `-2.md`. La segunda corrida cazó que el guion de concurrencia omnicanal no era re-entrante (purga previa añadida).

### Seguridad — `audit:security`

RLS activa en todas las tablas, `anon` recortado a la superficie pública derivada de las políticas, cero DEFINER sin `search_path`, cero secretos en el bundle de cliente. Línea base versionada; corre contra local (docker) o remoto (`PG_AUDIT_URL`).

### Rendimiento — `perf:volume`

Las 12 superficies del plan dentro de umbral bajo 1,500 SKUs / 5,000 ventas / 10,000 mensajes / 1,500 carritos. Evidencia en `test-results/perf-volume.md`.

### Recuperación — `backup:verify` y `rollback:drill`

- **Backup real**: `pg_dump -Fc` + **restauración verificada** por conteos de 12 tablas críticas + 95 tablas de esquema. No un dump teórico.
- **Rollback ensayado**: los cinco casos A–E simulados y verificados (12/12), incluida la propiedad de la regla 10 (con la IA caída, la venta se registra igual) y la correlación por `x-request-id` cuando Supabase no responde.

### Observabilidad mínima

Middleware con `x-request-id` (adoptado del proxy o generado) devuelto en la respuesta y en el log; clases `http_5xx`, `rpc_error`, `ai_failure` (distinta de fallo operacional), `pdf_failure`, `storage_failure` en una línea JSON, sin payloads sensibles.

### Frontend — `test:responsive`

Escritorio (1440×900) y móvil (375×812) sobre las 12 superficies reales bajo volumen: sin overflow horizontal, loaders eternos, errores de hidratación ni de consola. La debilidad de imágenes que señaló la auditoría inicial NO se reprodujo en la medición — queda en backlog (B5-04) para reabrirse solo si producción la confirma.

### STAGING — ○ pendiente de credenciales

El tooling está listo y parametrizado por entorno (`db push`, `audit:security` con `PG_AUDIT_URL`, `backup:verify` con `PG_BACKUP_URL`, `rollback:drill`, `e2e:staging`, `test:responsive` con `STAGING_URL`). Los ocho gates de staging se ejecutan sin escribir más código en cuanto exista el proyecto Supabase de staging y el hosting. Runbook completo en [staging-produccion.md](staging-produccion.md).

### PRODUCCIÓN — ○ NO TOCAR

Hasta superar los gates de staging.

---

## Estado de cierre

```
BASE VIRGEN
✓ 0001–0046   ✓ seeds   ✓ pgTAP (505)   ✓ B1 ✓ B2 ✓ B3 ✓ B4
✓ concurrencias   ✓ typecheck   ✓ lint   ✓ production build

LOCAL (equivalente a los gates de staging, ejecutados donde hay entorno)
✓ seguridad/RLS comprobada   ✓ degradación IA comprobada
✓ backup restaurado realmente   ✓ rollback ensayado (A–E)
✓ rendimiento medido (12/12)   ✓ escritorio + móvil comprobados

STAGING     ○ tooling listo; pendiente de que se provisione el entorno
PRODUCCIÓN  ○ NO TOCAR hasta superar staging
```

La plataforma está lista para pasar del desarrollo estructural a la provisión de staging y, superados sus gates, a la migración productiva. Lo único que queda del lado humano antes de staging: rotar la clave R-12 y provisionar el proyecto Supabase + hosting de staging.
