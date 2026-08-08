# Staging y producción — runbook de despliegue

Este documento es el procedimiento remoto. Complementa [operacion.md](operacion.md) (que cubre lo local) y se detiene, a propósito, ANTES de tocar producción: producción no se toca hasta superar todos los gates de staging.

## 0. Antes de nada — provisión de entornos

Cada entorno es un proyecto Supabase propio + un despliegue de frontend propio. **No comparten base, buckets ni secretos.**

| Recurso | Cómo se crea | Dónde viven sus secretos |
|---|---|---|
| Proyecto Supabase STAGING | dashboard Supabase → New project | gestor de secretos del hosting de staging |
| Proyecto Supabase PRODUCCIÓN | dashboard Supabase → New project | gestor de secretos del hosting de producción |
| Frontend STAGING / PROD | Vercel (u otro): un proyecto/branch por entorno | variables de entorno del propio hosting |

Variables por entorno (nunca en el repo): `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`, y las opcionales (`ANTHROPIC_API_KEY`, WhatsApp/Meta/TikTok). La plantilla es [.env.example](../.env.example).

**Pendiente bloqueante (R-12):** el `service_role` del proyecto remoto heredado del catálogo antiguo fue puesto en cuarentena fuera del repo. **Rotarlo en el dashboard** antes de reutilizar ese proyecto, o crear uno nuevo para staging.

## 1. Enlazar la CLI a un entorno

```
npx supabase link --project-ref <STAGING_REF>          # pide la BD password
npx supabase migration list --linked                    # aplicado (remoto) vs repo (local)
```

`migration list` es el inventario del §6: muestra qué migraciones faltan aplicar. En un proyecto virgen, faltan las 46.

## 2. Migración a staging (ensayo del despliegue de producción)

```
# a) BACKUP verificable ANTES de migrar (aunque staging no tenga datos reales,
#    es el ensayo del gesto que en producción es obligatorio)
PG_BACKUP_URL="postgres://postgres:<PWD>@<host>:5432/postgres" npm run backup:verify

# b) Aplicar las migraciones pendientes
npx supabase db push --linked

# c) Auditoría estructural en el entorno REMOTO (no asumir que local ⇒ remoto)
PG_AUDIT_URL="postgres://postgres:<PWD>@<host>:5432/postgres" npm run audit:security
```

`db push` aplica 0001–0046. La única migración destructiva es **0029** (drop de `orders`/`order_items`, legado V1); en un proyecto nuevo no hay nada que perder, pero el runbook de producción exige el export previo de esas dos tablas si el proyecto ya las tuviera.

## 3. Recorrido E2E real en staging (§5)

No basta con que migre. Se ejecuta el recorrido completo contra staging y se confirma la reconciliación de los mismos invariantes que la integral local:

```
STAGING_URL="https://staging.bellaroshe…" \
STAGING_ENV=.env.staging \
npm run e2e:staging
```

`e2e:staging` (scripts/e2e-staging.mjs) recorre, contra las superficies REALES del entorno:

```
producto/variante → proveedor/compra/recepción → inventario/costo
→ campaña/canal/clienta → conversación/carrito → reserva/adelanto
→ venta/pagos/caja → BI → asistencia IA (degradada si no hay credencial)
```

y verifica que sale = caja = inventario = costo = canal = campaña reconcilian, igual que `test:block3` + `test:block4` en local.

## 4. Gates de staging (todos, antes de producción)

```
STAGING
✓ migración reproducida (db push sin error, migration list al día)
✓ flujo E2E real completo (e2e:staging en verde)
✓ permisos/RLS comprobados (audit:security con PG_AUDIT_URL, sin violaciones)
✓ degradación IA comprobada (sin ANTHROPIC_API_KEY: el E2E completa vendiendo)
✓ backup restaurado realmente (backup:verify con PG_BACKUP_URL)
✓ rollback ensayado (rollback:drill apuntado a staging)
✓ rendimiento medido (perf:volume — o su equivalente remoto — dentro de umbral)
✓ escritorio + móvil comprobados (test:responsive contra STAGING_URL)
```

## 5. Producción — NO TOCAR hasta que staging pase

Cuando staging cumpla los ocho gates, el despliegue de producción repite el §2 con una diferencia: **el backup previo es obligatorio y se conserva**, y si alguna migración pendiente fuera destructiva se exporta lo afectado primero. El orden exacto está en [operacion.md §5](operacion.md). Reglas que no se rompen:

- Nunca `seed:demo-operation` en producción.
- Nunca editar filas a mano para «arreglar» producción — toda corrección va por migración o por los contratos.
- El rollback de un despliegue es redeploy del build anterior; el de una migración destructiva es restore del backup + redeploy (ver la tabla A–E de operacion.md §6).

## Estado actual

**Local:** todos los gates en verde (reconstrucción ×2, seguridad, backup real, rollback, rendimiento, responsive).
**Staging:** ○ pendiente de que se provisione el proyecto Supabase de staging y el hosting. El tooling (`db push`, `audit:security`, `backup:verify`, `rollback:drill`, `e2e:staging`, `test:responsive`) está listo y parametrizado por entorno; en cuanto existan las credenciales, los ocho gates se ejecutan sin escribir más código.
**Producción:** ○ NO TOCAR.
